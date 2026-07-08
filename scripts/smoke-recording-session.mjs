import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'

const SMOKE_VIDEO_FPS = 30
const TEST_PATTERN_GATES = Object.freeze({
  // Synthetic source/layout smoke proves file health and timing. Some synthetic
  // layouts are intentionally static, so motion artifacts remain warnings here.
  requireMotion: false
})

export const LAYOUT_PRESET_SCENARIOS = [
  { preset: 'screen-camera', label: 'Screen + camera' },
  { preset: 'screen-only', label: 'Screen only' },
  { preset: 'camera-only', label: 'Camera only' },
  { preset: 'side-by-side', label: 'Side-by-side' }
]

export async function runBackendRecordingSmoke({
  connection,
  ffmpegPath,
  ffprobePath = resolveSiblingFfprobe(ffmpegPath) ?? 'ffprobe',
  outputDirectory,
  timeoutMs = 45000,
  recordingMs = 2000,
  label = 'App',
  analyze = true,
  onHealth,
  scenarios = LAYOUT_PRESET_SCENARIOS
}) {
  mkdirSync(outputDirectory, { recursive: true })

  let ws
  try {
    ws = await connectBackend(connection, timeoutMs)
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for smoke recording.')
    }

    await onHealth?.({ health, ffmpegPath })
    console.log(`${label} smoke using FFmpeg: ${ffmpegPath}`)
    if (analyze) {
      console.log(`${label} smoke using FFprobe: ${ffprobePath}`)
    }

    // Drive every layout preset through real FFmpeg with the test pattern so each
    // composed filtergraph (overlay, screen-only, camera-only, side-by-side) is
    // validated end to end and the recording finalizes.
    const results = []
    for (const scenario of scenarios) {
      results.push(
        await recordScenario({
          ws,
          timeoutMs,
          recordingMs,
          label,
          outputDirectory,
          ffmpegPath,
          ffprobePath,
          analyze,
          scenario
        })
      )
    }
    results.push(
      await recordAssetBackgroundScenario({
        ws,
        timeoutMs,
        recordingMs,
        label,
        outputDirectory,
        ffmpegPath,
        ffprobePath,
        analyze
      })
    )
    await assertSessionPoster({ ws, connection, timeoutMs, ffmpegPath, label })
    return results
  } finally {
    ws?.close()
  }
}

async function recordScenario({
  ws,
  timeoutMs,
  recordingMs,
  label,
  outputDirectory,
  ffmpegPath,
  ffprobePath,
  analyze,
  scenario
}) {
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams({
      outputDirectory,
      ffmpegPath,
      preset: scenario.preset,
      background: scenario.background
    })
  )
  if (!['recording', 'streaming'].includes(started.state)) {
    throw new Error(
      `[${scenario.label}] Expected recording state after start, got ${started.state}.`
    )
  }

  await sleep(recordingMs)

  const stopped = await request(ws, timeoutMs, 'session.stop')
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(
      `[${scenario.label}] Recording output was not created: ${outputPath ?? 'missing path'}`
    )
  }

  const size = statSync(outputPath).size
  if (size <= 0) {
    throw new Error(`[${scenario.label}] Recording output is empty: ${outputPath}`)
  }

  console.log(`${label} smoke [${scenario.label}] recording created: ${outputPath} (${size} bytes)`)

  if (!analyze) {
    return { preset: scenario.preset, outputPath, size }
  }

  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: SMOKE_VIDEO_FPS,
    expectAudio: true,
    gates: TEST_PATTERN_GATES
  })
  const reportPaths = writeReports(quality)
  if (!quality.verdict.pass) {
    throw new Error(
      `[${scenario.label}] Recording quality gate failed: ${quality.verdict.failures.join('; ')} ` +
        `(report: ${reportPaths.mdPath})`
    )
  }

  console.log(
    `${label} smoke [${scenario.label}] quality PASS: ` +
      `${quality.metrics.observedFrames ?? 'n/a'} frame(s), ` +
      `A/V skew ${formatMetricMs(quality.metrics.avSkewMs)} ` +
      `(report: ${reportPaths.mdPath})`
  )
  return { preset: scenario.preset, outputPath, size, quality, reportPaths }
}

async function recordAssetBackgroundScenario({
  ws,
  timeoutMs,
  recordingMs,
  label,
  outputDirectory,
  ffmpegPath,
  ffprobePath,
  analyze
}) {
  const backgroundPath = writeSolidBackgroundPng({ ffmpegPath, outputDirectory })
  const scenario = {
    preset: 'screen-only',
    label: 'Asset background 80% screen stage',
    background: {
      assetId: 'smoke-red-background',
      managedAssetPath: backgroundPath,
      fit: 'stretch',
      scale: 100,
      offsetX: 0,
      offsetY: 0,
      blurPx: 0,
      dimPercent: 0,
      saturationPercent: 100,
      vignettePercent: 0
    }
  }
  const result = await recordScenario({
    ws,
    timeoutMs,
    recordingMs,
    label,
    outputDirectory,
    ffmpegPath,
    ffprobePath,
    analyze,
    scenario
  })
  assertAssetBackgroundFrame({
    outputPath: result.outputPath,
    outputDirectory,
    ffmpegPath
  })
  console.log(
    `${label} smoke [${scenario.label}] asset background frame PASS: red border around 80% screen stage`
  )
  return result
}

/** Library rewrite L6: a finalized recording must yield a servable poster —
 * ensure it over WS (idle-aware extraction), then fetch the actual JPEG from
 * the token-authenticated HTTP server. */
async function assertSessionPoster({ ws, connection, timeoutMs, ffmpegPath, label }) {
  const sessions = await request(ws, timeoutMs, 'sessions.list', { limit: 1 })
  const latest = sessions?.[0]
  if (!latest) {
    throw new Error('Poster assert: no session found after the recording scenarios.')
  }
  const poster = await request(ws, timeoutMs, 'sessions.poster', {
    sessionId: latest.id,
    ffmpegPath
  })
  if (!poster?.available) {
    throw new Error(`Poster assert: sessions.poster reported unavailable for ${latest.id}.`)
  }
  const url =
    `http://${connection.host}:${connection.port}/sessions/` +
    `${encodeURIComponent(latest.id)}/poster?token=${encodeURIComponent(connection.token)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Poster assert: HTTP ${response.status} fetching the poster for ${latest.id}.`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 100 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`Poster assert: response is not a JPEG (${bytes.length} bytes).`)
  }
  console.log(`${label} smoke poster PASS: ${bytes.length}-byte JPEG served for ${latest.id}`)
}

export function connectBackend(connection, timeoutMs) {
  return new Promise((resolveConnection, rejectConnection) => {
    const url = `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
    let ws
    const timer = setTimeout(() => {
      ws?.close()
      rejectConnection(new Error(`Timed out connecting to ${url}.`))
    }, timeoutMs)
    ws = new WebSocket(url)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolveConnection(ws)
      },
      { once: true }
    )
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        rejectConnection(new Error(`Could not connect to ${url}`))
      },
      {
        once: true
      }
    )
  })
}

export function request(ws, timeoutMs, method, params) {
  const id = `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      rejectRequest(new Error(`Timed out waiting for ${method}.`))
    }, timeoutMs)

    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        rejectRequest(error)
        return
      }
      if (message.id !== id) {
        return
      }

      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (message.ok) {
        resolveRequest(message.payload)
      } else {
        rejectRequest(new Error(message.error?.message ?? `${method} failed.`))
      }
    }

    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function sessionParams({ outputDirectory, ffmpegPath, preset = 'screen-camera', background }) {
  return {
    sources: {
      testPattern: true
    },
    layout: {
      layoutPreset: preset,
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectory,
      ffmpegPath,
      video: {
        preset: 'custom',
        width: 640,
        height: 360,
        fps: 30,
        bitrateKbps: 2000
      },
      rtmp: {
        preset: 'custom',
        serverUrl: '',
        streamKey: ''
      }
    },
    scene: background ? sceneWithAssetBackground(background) : undefined
  }
}

function sceneWithAssetBackground(background) {
  const transform = fullFrameTransform()
  return {
    id: 'scene:asset-background-smoke',
    name: 'Asset background smoke',
    sources: [
      {
        id: 'source:test-pattern',
        name: 'Test pattern',
        kind: 'test-pattern',
        deviceId: undefined,
        transform,
        defaultTransform: transform,
        visible: true,
        locked: false
      }
    ],
    outputs: [],
    background
  }
}

function fullFrameTransform() {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
}

function writeSolidBackgroundPng({ ffmpegPath, outputDirectory }) {
  const backgroundPath = join(outputDirectory, `asset-background-red-${Date.now()}.png`)
  runCommand(
    ffmpegPath,
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=16x16',
      '-frames:v',
      '1',
      backgroundPath
    ],
    'create asset background PNG'
  )
  return backgroundPath
}

function assertAssetBackgroundFrame({ outputPath, outputDirectory, ffmpegPath }) {
  const width = 640
  const height = 360
  const rawPath = join(outputDirectory, `asset-background-frame-${Date.now()}.rgb`)
  runCommand(
    ffmpegPath,
    [
      '-v',
      'error',
      '-y',
      '-ss',
      '0.5',
      '-i',
      outputPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      rawPath
    ],
    'extract asset background smoke frame'
  )

  const bytes = readFileSync(rawPath)
  const expectedBytes = width * height * 3
  if (bytes.length < expectedBytes) {
    throw new Error(
      `Asset background smoke frame is truncated: expected ${expectedBytes} byte(s), got ${bytes.length}.`
    )
  }

  const borderPoints = sampleGrid({ x0: 8, x1: 56, y0: 8, y1: 32, columns: 5, rows: 3 })
    .concat(sampleGrid({ x0: 8, x1: 56, y0: 328, y1: 352, columns: 5, rows: 3 }))
    .concat(sampleGrid({ x0: 584, x1: 632, y0: 8, y1: 352, columns: 3, rows: 5 }))
  const centerPoints = sampleGrid({ x0: 96, x1: 544, y0: 72, y1: 288, columns: 7, rows: 5 })

  const borderRedRatio = redRatio(bytes, width, borderPoints)
  const centerRedRatio = redRatio(bytes, width, centerPoints)
  if (borderRedRatio < 0.9) {
    throw new Error(
      `Asset background smoke expected a red border around the staged screen; red border ratio was ${borderRedRatio.toFixed(2)}.`
    )
  }
  if (centerRedRatio > 0.75) {
    throw new Error(
      `Asset background smoke expected screen content in the 80% center; center red ratio was ${centerRedRatio.toFixed(2)}.`
    )
  }
}

function sampleGrid({ x0, x1, y0, y1, columns, rows }) {
  const points = []
  for (let yIndex = 0; yIndex < rows; yIndex += 1) {
    const y = Math.round(y0 + ((y1 - y0) * yIndex) / Math.max(1, rows - 1))
    for (let xIndex = 0; xIndex < columns; xIndex += 1) {
      const x = Math.round(x0 + ((x1 - x0) * xIndex) / Math.max(1, columns - 1))
      points.push([x, y])
    }
  }
  return points
}

function redRatio(bytes, width, points) {
  const red = points.filter(([x, y]) => {
    const offset = (y * width + x) * 3
    const r = bytes[offset] ?? 0
    const g = bytes[offset + 1] ?? 0
    const b = bytes[offset + 2] ?? 0
    return r >= 180 && g <= 80 && b <= 80
  }).length
  return red / Math.max(1, points.length)
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${command} ${args.join(' ')} exited with ${result.status}; ${result.stderr || result.stdout}`
    )
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function resolveSiblingFfprobe(ffmpegPath) {
  if (typeof ffmpegPath !== 'string') {
    return null
  }
  if (ffmpegPath.endsWith('ffmpeg')) {
    return `${ffmpegPath.slice(0, -'ffmpeg'.length)}ffprobe`
  }
  if (ffmpegPath.endsWith('ffmpeg.exe')) {
    return `${ffmpegPath.slice(0, -'ffmpeg.exe'.length)}ffprobe.exe`
  }
  return null
}

function formatMetricMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(0)}ms` : 'n/a'
}
