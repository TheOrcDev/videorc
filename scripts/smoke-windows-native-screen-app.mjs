import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { performanceAppSpawnSpec, launchDevApp } from './lib/app-launcher.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { evaluateRecordingWallDuration } from './lib/recording-duration-gate.mjs'
import {
  assertBmpHeaders,
  assertNonblankBmp,
  nativeWindowsCompositorUsesScreen,
  nativeWindowsScreenCandidates,
  nativeWindowsScreenRecordingActive
} from './lib/windows-native-screen-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

if (process.platform !== 'win32') {
  throw new Error('The native Windows screen/BMP smoke must run on Windows.')
}

const repoRoot = resolve(import.meta.dirname, '..')
const spawnSpec = performanceAppSpawnSpec()
if (!spawnSpec) {
  throw new Error('Set VIDEORC_PERF_APP_EXECUTABLE to the packaged Videorc.exe.')
}

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-windows-native-screen-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000)
const recordingMs = Number(process.env.VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS ?? 6_000)
const video = {
  preset: 'custom',
  width: Number(process.env.VIDEORC_SMOKE_VIDEO_WIDTH ?? 1280),
  height: Number(process.env.VIDEORC_SMOKE_VIDEO_HEIGHT ?? 720),
  fps: Number(process.env.VIDEORC_SMOKE_VIDEO_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_SMOKE_VIDEO_BITRATE_KBPS ?? 4_000)
}

mkdirSync(outputDirectory, { recursive: true })

const launched = await launchDevApp({
  spawnSpec,
  timeoutMs,
  requiredMarkers: ['backend-ready'],
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1'
  }
})

let ws
try {
  const connection = launched.connections['backend-ready']
  ws = await connectBackend(connection, timeoutMs)
  const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'Bundled FFmpeg is unavailable.')
  }

  const deviceList = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const candidates = nativeWindowsScreenCandidates(deviceList?.devices ?? [])
  if (candidates.length === 0) {
    throw new Error(
      `No available Windows DXGI/gdigrab screen source. Devices: ${JSON.stringify(deviceList?.devices ?? [])}`
    )
  }
  const screen = await startAvailableWindowsScreenPreview(ws, candidates)
  const sources = { screenId: screen.id, testPattern: false }
  console.log(`Windows native screen smoke selected ${screen.id}: ${screen.detail ?? screen.name}`)
  await waitForNativeScreenFrame(ws, screen.id)

  const firstBmp = await waitForNonblankBmpFrame(connection)

  const started = await request(ws, timeoutMs, 'session.start', screenOnlySessionParams(sources))
  if (started?.state !== 'recording') {
    throw new Error(`Expected ScreenOnly recording, got ${started?.state ?? 'no state'}.`)
  }
  const recordingStartedAt = Date.now()
  const activeRecording = await waitForActiveNativeScreenRecording(ws, screen.id)
  if (!nativeWindowsCompositorUsesScreen(activeRecording.compositor, screen.id)) {
    throw new Error(
      `Recording compositor did not retain selected native screen ${screen.id}: ${JSON.stringify(activeRecording)}`
    )
  }

  const bmpEvidence = await pollBmpDuringRecording(connection, firstBmp.cursor, recordingMs)
  const stopRequestedAt = Date.now()
  const stopped = await request(ws, timeoutMs, 'session.stop')
  const outputPath = stopped?.outputPath ?? started?.outputPath
  if (!outputPath || !existsSync(outputPath) || statSync(outputPath).size <= 0) {
    throw new Error(
      `Native ScreenOnly recording output is missing or empty: ${outputPath ?? 'none'}`
    )
  }

  const report = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    expectAudio: false,
    gates: { requireMotion: false }
  })
  const reportPaths = writeReports(report)
  if (!report.verdict.pass) {
    throw new Error(
      `Native ScreenOnly recording quality failed: ${report.verdict.failures.join('; ')} (report: ${reportPaths.mdPath})`
    )
  }
  const durationFailures = evaluateRecordingWallDuration({
    expectedDurationMs: stopRequestedAt - recordingStartedAt,
    actualDurationSeconds: report.metrics.durationSeconds
  })
  if (durationFailures.length > 0) {
    throw new Error(`Native ScreenOnly duration failed: ${durationFailures.join('; ')}`)
  }
  assertNonblankRecordingFrame(outputPath)

  console.log(
    `Windows native screen/BMP PASS: ${screen.id}, ${bmpEvidence.advancedFrames} BMP frame advances, ` +
      `${report.metrics.observedFrames ?? 'n/a'} recorded frames, ${report.metrics.durationSeconds.toFixed(2)}s, ` +
      `${outputPath} (report: ${reportPaths.mdPath})`
  )
} finally {
  if (ws) {
    try {
      await request(ws, 10_000, 'preview.screen.stop')
    } catch {
      // Process teardown below is authoritative.
    }
    ws.close()
  }
  await launched.stop()
}

async function startAvailableWindowsScreenPreview(ws, candidates) {
  const failures = []
  for (const candidate of candidates) {
    const preview = await request(ws, timeoutMs, 'preview.screen.start', {
      sources: { screenId: candidate.id, testPattern: false },
      video,
      protectedOverlayWindowIds: [],
      ffmpegPath
    })
    if (preview?.state === 'live') {
      return candidate
    }
    failures.push(`${candidate.id}: ${preview?.state} ${preview?.message ?? ''}`)
    await request(ws, timeoutMs, 'preview.screen.stop')
  }
  throw new Error(`No Windows native screen backend could start: ${failures.join('; ')}`)
}

async function waitForNativeScreenFrame(ws, sourceId) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.screen.status')
    if (
      last?.state === 'live' &&
      last?.sourceId === sourceId &&
      ((last.framesCaptured ?? 0) > 0 || last.sequence != null)
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${sourceId} frame: ${JSON.stringify(last)}`)
}

async function waitForNonblankBmpFrame(connection) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const frame = await fetchBmpFrame(connection, null)
      if (frame.status === 200) {
        assertNonblankBmp(frame.bytes, frame.headers)
        return frame
      }
    } catch (error) {
      lastError = error
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for the first nonblank native BMP preview frame.', {
    cause: lastError
  })
}

async function waitForActiveNativeScreenRecording(ws, sourceId) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const [diagnostics, compositor, recording] = await Promise.all([
      request(ws, timeoutMs, 'diagnostics.stats'),
      request(ws, timeoutMs, 'compositor.status'),
      request(ws, timeoutMs, 'recording.status')
    ])
    last = { diagnostics, compositor, recording }
    if (nativeWindowsScreenRecordingActive(last, sourceId)) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for ScreenOnly recording/source authority for ${sourceId}: ${JSON.stringify(last)}`
  )
}

async function pollBmpDuringRecording(connection, initialCursor, durationMs) {
  const deadline = Date.now() + durationMs
  let cursor = initialCursor
  let advancedFrames = 0
  let nonblankFrames = 0
  while (Date.now() < deadline) {
    const frame = await fetchBmpFrame(connection, cursor)
    if (frame.status === 200) {
      assertNonblankBmp(frame.bytes, frame.headers)
      cursor = frame.cursor
      advancedFrames += 1
      nonblankFrames += 1
    }
    await sleep(100)
  }
  if (advancedFrames < 5 || nonblankFrames !== advancedFrames) {
    throw new Error(
      `Native BMP preview did not stay live during recording: advanced=${advancedFrames}, nonblank=${nonblankFrames}.`
    )
  }
  return { advancedFrames, cursor }
}

async function fetchBmpFrame(connection, cursor) {
  const url = new URL(`http://${connection.host}:${connection.port}/preview/screen/latest.bmp`)
  url.searchParams.set('token', connection.token)
  url.searchParams.set('maxWidth', '640')
  if (cursor) {
    url.searchParams.set('afterGeneration', cursor.generation)
    url.searchParams.set('afterSequence', String(cursor.sequence))
  }
  const response = await fetch(url, { cache: 'no-store' })
  if (![200, 204].includes(response.status)) {
    throw new Error(`BMP preview request failed with HTTP ${response.status}.`)
  }
  const headers = Object.fromEntries(response.headers.entries())
  assertBmpHeaders(headers, response.status)
  const generation = headers['x-videorc-frame-generation']
  const sequence = Number(headers['x-videorc-frame-sequence'])
  const nextCursor = { generation, sequence }
  if (response.status === 204) {
    return { status: 204, bytes: Buffer.alloc(0), headers, cursor: nextCursor }
  }
  return {
    status: 200,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers,
    cursor: nextCursor
  }
}

function screenOnlySessionParams(sources) {
  return {
    sources,
    layout: {
      layoutPreset: 'screen-only',
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
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: true,
      microphoneSyncOffsetMs: 0
    }
  }
}

function assertNonblankRecordingFrame(outputPath) {
  const rawPath = join(outputDirectory, `native-screen-recording-${Date.now()}.rgb`)
  const result = spawnSync(
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
      'scale=320:180',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      rawPath
    ],
    { encoding: 'utf8', cwd: repoRoot }
  )
  if (result.status !== 0) {
    throw new Error(`Could not decode native ScreenOnly frame: ${result.stderr || result.stdout}`)
  }
  const bytes = readFileSync(rawPath)
  let minimum = 255
  let maximum = 0
  for (let offset = 0; offset < bytes.length; offset += 97) {
    minimum = Math.min(minimum, bytes[offset])
    maximum = Math.max(maximum, bytes[offset])
  }
  if (bytes.length < 320 * 180 * 3 || maximum - minimum < 8 || maximum < 16) {
    throw new Error(
      `Native ScreenOnly recording decoded as blank/constant: bytes=${bytes.length}, range=${maximum - minimum}, max=${maximum}.`
    )
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
