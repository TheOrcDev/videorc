import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-live-layout-switch-${Date.now()}`)
)
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const recordingMs = Number(process.env.VIDEORC_LIVE_LAYOUT_RECORDING_MS ?? 3500)
const streamRecordingMs = Number(
  process.env.VIDEORC_LIVE_LAYOUT_STREAM_RECORDING_MS ?? Math.max(recordingMs, 6500)
)
const staticScreenSettleMs = Number(process.env.VIDEORC_LIVE_LAYOUT_STATIC_SCREEN_MS ?? 6200)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const realScreenMode = process.env.VIDEORC_LIVE_LAYOUT_REAL_SCREEN === '1'
const includeStreamMode = process.env.VIDEORC_LIVE_LAYOUT_SKIP_STREAM !== '1'
const streamPort = Number(process.env.VIDEORC_LIVE_LAYOUT_STREAM_PORT ?? 19611)
const streamKey = 'live-layout-switch'

const video = {
  preset: 'custom',
  width: 640,
  height: 360,
  fps: 30,
  bitrateKbps: 2000
}

mkdirSync(outputDirectory, { recursive: true })

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_STATE_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1'
  }
})
const smoke = launched.connections['preview-motion-ready']

let ws
let listener = null
let stopping = false
try {
  ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(
      health?.ffmpeg?.message ?? 'FFmpeg is unavailable for live layout switch smoke.'
    )
  }

  const sources = realScreenMode ? await prepareRealScreenSource(ws) : { testPattern: true }
  await runSwitchScenario(ws, smoke, {
    label: realScreenMode ? 'real-screen-recording' : 'synthetic-recording',
    sources,
    streamTarget: null,
    durationMs: recordingMs
  })

  if (includeStreamMode) {
    const streamTarget = {
      port: streamPort,
      serverUrl: `rtmp://127.0.0.1:${streamPort}/live`,
      streamKey,
      listenUrl: `rtmp://127.0.0.1:${streamPort}/live/${streamKey}`,
      recvPath: join(outputDirectory, 'stream-received.flv')
    }
    listener = spawnListener(streamTarget)
    await sleep(1500)
    await runSwitchScenario(ws, smoke, {
      label: realScreenMode ? 'real-screen-record-stream' : 'synthetic-record-stream',
      sources,
      streamTarget,
      durationMs: streamRecordingMs
    })
    stopping = true
    await stopListener(listener)
    listener = null
    assertStreamReceived(streamTarget)
  }

  console.log(
    `Live layout switch smoke OK - ${realScreenMode ? 'real ScreenCaptureKit' : 'synthetic'} active-session apply_live switches reached recording${includeStreamMode ? ' and stream' : ''}.`
  )
} finally {
  ws?.close()
  if (listener) {
    stopping = true
    await stopListener(listener)
  }
  await launched.stop()
}

async function prepareRealScreenSource(ws) {
  const devices = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const source = (devices.devices ?? []).find(
    (device) =>
      (device.kind === 'screen' || device.kind === 'window') &&
      device.status === 'available' &&
      device.id.includes('screencapturekit')
  )
  if (!source) {
    const summary = (devices.devices ?? [])
      .filter((device) => device.kind === 'screen' || device.kind === 'window')
      .map((device) => `${device.kind}:${device.id}:${device.status}`)
      .join(', ')
    throw new Error(
      `No available ScreenCaptureKit screen/window source for live layout switch device smoke. Devices: ${summary || 'none'}`
    )
  }

  const sources =
    source.kind === 'window'
      ? { windowId: source.id, testPattern: false }
      : { screenId: source.id, testPattern: false }
  const status = await request(ws, timeoutMs, 'preview.screen.start', {
    sources,
    video,
    protectedOverlayWindowIds: [],
    ffmpegPath
  })
  if (status.state !== 'live') {
    throw new Error(
      `Screen preview did not start for ${source.id}: ${status.state} ${status.message ?? ''}`
    )
  }
  await waitForScreenFrame(ws, source.id)
  // Hold the source visually static long enough that frame-age freshness would
  // have failed before the backend fix.
  await sleep(staticScreenSettleMs)
  return sources
}

async function waitForScreenFrame(ws, sourceId) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.screen.status')
    if (
      last?.state === 'live' &&
      last.sourceId === sourceId &&
      ((last.framesCaptured ?? 0) > 0 || last.sequence != null)
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for first screen frame from ${sourceId}. Last status: ${JSON.stringify(last)}`
  )
}

async function runSwitchScenario(ws, smoke, { label, sources, streamTarget, durationMs }) {
  const recordingDirectory = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { path: outputDirectory, kind: 'output-directory' },
    { timeoutMs }
  )
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams({
      sources,
      streamTarget,
      outputDirectoryCapability: recordingDirectory.capabilityId
    })
  )
  if (!['recording', 'streaming'].includes(started.state)) {
    throw new Error(`[${label}] Expected active session after start, got ${started.state}.`)
  }
  const sessionId = started.sessionId

  await sleep(500)
  for (const preset of ['screen-camera', 'screen-only', 'screen-camera']) {
    const status = await request(ws, timeoutMs, 'scene.layout.apply_live', {
      sources,
      layout: layout(preset),
      video,
      background: null,
      protectedOverlayWindowIds: []
    })
    if (!status.applied) {
      throw new Error(`[${label}] ${preset} did not apply: ${JSON.stringify(status)}`)
    }
    await assertSameSession(ws, sessionId, label)
    await waitForSceneProof(ws, status.sceneRevision, label, preset)
  }

  await sleep(durationMs)
  if (streamTarget) {
    stopping = true
  }
  const stopped = await request(ws, timeoutMs, 'session.stop')
  await assertRecordingArtifact(label, stopped.outputPath ?? started.outputPath, {
    minVideoSeconds: 2
  })
}

function sessionParams({ sources, streamTarget, outputDirectoryCapability }) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const streamEnabled = Boolean(streamTarget)
  return {
    sources,
    layout: layout('screen-only'),
    output: {
      recordEnabled: true,
      streamEnabled,
      outputDirectoryCapability,
      video,
      rtmp: {
        preset: 'custom',
        serverUrl: streamTarget?.serverUrl ?? '',
        streamKey: streamTarget?.streamKey ?? ''
      }
    },
    ...(streamTarget
      ? {
          streaming: {
            enabled: true,
            mode: 'single',
            targets: [
              {
                id: 'custom',
                platform: 'custom',
                label: 'Local RTMP',
                enabled: true,
                serverUrl: streamTarget.serverUrl,
                urlMode: 'server-and-key',
                streamKey: streamTarget.streamKey,
                streamKeyPresent: true,
                authMode: 'manual-rtmp',
                createdAt: timestamp,
                updatedAt: timestamp
              }
            ],
            defaultOutputPreset: 'tutorial-1080p30',
            defaultBitrateKbps: 2000,
            enabledTargetIds: ['custom']
          }
        }
      : {})
  }
}

function layout(layoutPreset) {
  return {
    layoutPreset,
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  }
}

async function assertSameSession(ws, sessionId, label) {
  const status = await request(ws, timeoutMs, 'recording.status')
  if (status.sessionId !== sessionId || !['recording', 'streaming'].includes(status.state)) {
    throw new Error(
      `[${label}] live layout switch changed session state: expected ${sessionId}, got ${status.sessionId}/${status.state}.`
    )
  }
}

async function waitForSceneProof(ws, revision, label, preset) {
  const deadline = Date.now() + timeoutMs
  let lastCompositor = null
  let lastDiagnostics = null
  while (Date.now() < deadline) {
    lastCompositor = await request(ws, timeoutMs, 'compositor.status')
    lastDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    const compositorRendered = (lastCompositor.frameSceneRevision ?? 0) >= revision
    const diagnosticsReached = (lastDiagnostics.activeSceneRevision ?? 0) >= revision
    if (compositorRendered && diagnosticsReached) {
      return
    }
    await sleep(150)
  }
  throw new Error(
    `[${label}] ${preset} scene revision ${revision} was not proven live. Last compositor: ${JSON.stringify(
      lastCompositor
    )}; last diagnostics: ${JSON.stringify(lastDiagnostics)}`
  )
}

async function assertRecordingArtifact(label, outputPath, { minVideoSeconds }) {
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(`[${label}] Recording output was not created: ${outputPath ?? 'missing path'}`)
  }
  const size = statSync(outputPath).size
  if (size <= 0) {
    throw new Error(`[${label}] Recording output is empty: ${outputPath}`)
  }
  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    expectAudio: false,
    gates: {
      requireMotion: false,
      // This smoke proves active-session layout switching and video output
      // health. Synthetic record+stream audio is covered by the dedicated A/V
      // sync gates, and may start before split-output video in this harness.
      avSyncTargetMs: Number.POSITIVE_INFINITY,
      avSyncHardFailMs: Number.POSITIVE_INFINITY
    }
  })
  const reportPaths = writeReports(quality)
  if (!quality.verdict.pass) {
    throw new Error(
      `[${label}] Recording quality gate failed: ${quality.verdict.failures.join('; ')} (report: ${reportPaths.mdPath})`
    )
  }
  if ((quality.metrics.durationSeconds ?? 0) < minVideoSeconds) {
    throw new Error(
      `[${label}] Recording video duration ${quality.metrics.durationSeconds ?? 'unknown'}s is below ${minVideoSeconds}s (report: ${reportPaths.mdPath})`
    )
  }
  console.log(
    `[${label}] recording quality PASS: ${outputPath} (${size} bytes, report: ${reportPaths.mdPath})`
  )
}

function spawnListener(target) {
  const proc = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      target.listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      target.recvPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (text) => {
    if (stopping) {
      return
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        console.error(`[live-layout-listener :${target.port}] ${line}`)
      }
    }
  })
  return proc
}

function stopListener(proc) {
  return new Promise((resolveStop) => {
    if (!proc?.pid || proc.killed) {
      resolveStop()
      return
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
      resolveStop()
    }, 2000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolveStop()
    }
  })
}

function assertStreamReceived(target) {
  const size = existsSync(target.recvPath) ? statSync(target.recvPath).size : 0
  if (size <= 0) {
    throw new Error(`Local RTMP listener received no stream bytes: ${target.recvPath}`)
  }
  console.log(`Local RTMP listener received ${size} bytes: ${target.recvPath}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
