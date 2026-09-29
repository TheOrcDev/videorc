// Output-stall smoke (plan 076 A): a healthy microphone survives FFmpeg
// pausing its audio input.
//
// The owner's 2026-09-28 live stream (0.9.120) lost its microphone for the
// rest of the session: the Mac got busy, the recording video reached FFmpeg
// late, FFmpeg 8.1.1's scheduler stopped draining the session audio FIFO, the
// bus fell ~1.7 s behind and refused every buffer, and after 2 s it retired
// the working microphone. This drives the same chain through the real dev
// app: the debug-only VideoToolbox FIFO pause (VIDEORC_TEST_VT_FIFO_PAUSE_*)
// holds the recording video writer for 1.5 s three times, one access unit
// apart: sustained pressure that never goes 2 s without video progress (a
// single 3 s pause trips the bridge's own no-progress watchdog instead,
// which is not the owner's failure). Meanwhile the debug synthetic
// microphone (VIDEORC_CAPTION_CONTRACT_TEST + VIDEORC_LIVE_SOURCE_SWITCH_TEST,
// a continuous 440 Hz tone) keeps delivering. Nothing plays through the
// speakers and nothing moves the pointer.
//
// PASS: the stall is reported (audio-output-stalled), the microphone is never
// reported lost, and the decoded file has the tone before the pause and again
// within 2.5 s of its end, to the end of the file.
//
//   node scripts/smoke-output-stall-app.mjs [--pause-ms 1500] [--pause-repeat 3] [--seconds 16]

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { decodeSourcePcm, measureSourceWindow } from './lib/live-source-switch-gates.mjs'
import { evaluateOutputStall } from './lib/output-stall-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { values: args } = parseArgs({
  options: {
    'pause-ms': { type: 'string', default: '1500' },
    'pause-repeat': { type: 'string', default: '3' },
    'pause-after-frames': { type: 'string', default: '120' },
    seconds: { type: 'string', default: '16' }
  },
  strict: true
})
if (process.platform !== 'darwin') {
  console.log('Output-stall smoke SKIPPED: the VideoToolbox FIFO pause seam is macOS only.')
  process.exit(0)
}

const FPS = 30
const pauseMs = Number(args['pause-ms'])
const pauseRepeat = Number(args['pause-repeat'])
const pauseAfterFrames = Number(args['pause-after-frames'])
const recordSeconds = Number(args.seconds)
const timeoutMs = 180000
const microphoneId = 'microphone:coreaudio:4294967295'
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-output-stall-${Date.now()}`)
)
const reportPath = join(outputDirectory, 'output-stall-evidence.json')
mkdirSync(outputDirectory, { recursive: true })

const events = { recording: [], health: [] }
let report = { pass: false, scope: 'output-stall', pauseMs, pauseRepeat, pauseAfterFrames }
let launched
let backend
let active = false

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1',
      VIDEORC_TEST_VT_FIFO_PAUSE_AFTER_FRAMES: String(pauseAfterFrames),
      VIDEORC_TEST_VT_FIFO_PAUSE_MS: String(pauseMs),
      VIDEORC_TEST_VT_FIFO_PAUSE_REPEAT: String(pauseRepeat),
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_APP_DATA_DIR: join(outputDirectory, 'app-data'),
      VIDEORC_USER_DATA_DIR: join(outputDirectory, 'user-data')
    }
  })
  backend = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  backend.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.event === 'recording.status')
      events.recording.push({ ...message.payload, receivedAt: Date.now() })
    if (message.event === 'health.event')
      events.health.push({ ...message.payload, receivedAt: Date.now() })
  })
  const smoke = launched.connections['preview-motion-ready']
  const authorization = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )
  const started = await request(backend, timeoutMs, 'session.start', {
    sources: { testPattern: true, microphoneId },
    layout: {
      layoutPreset: 'screen-only',
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
    },
    output: {
      recordEnabled: true,
      streamEnabled: false,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' },
      outputDirectoryCapability: authorization.capabilityId,
      video: { preset: 'custom', width: 640, height: 360, fps: FPS, bitrateKbps: 2000 }
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 },
    captions: { enabled: false }
  })
  assert.equal(started.state, 'recording')
  assert.ok(started.sessionId && started.outputPath)
  active = true
  await delay(recordSeconds * 1000)
  const stopRequestedAt = Date.now()
  const stopped = await request(backend, timeoutMs, 'session.stop', {})
  active = false
  const exported = await resolveFinalRecordingPath({
    started,
    stopped,
    recordingStatusEvents: events.recording,
    healthEvents: events.health,
    stopRequestedAt,
    timeoutMs: 60000
  })
  // The MKV carries the same audio track; the MP4 export is not under test.
  const file = exported ?? (existsSync(started.outputPath) ? started.outputPath : null)
  report.exportedMp4 = Boolean(exported)
  assert.ok(file, 'The recording produced no file.')
  // Finalization health (the bus summary, late stall reports) lands after stop.
  await delay(1500)
  const samples = await decodeSourcePcm(file, { ffmpegPath })
  const fileSeconds = samples.length / 48000
  const windows = []
  for (let start = 0; start + 0.5 <= fileSeconds; start += 0.5) {
    windows.push(measureSourceWindow(samples, { startSeconds: start, durationSeconds: 0.5 }))
  }
  const health = events.health.filter((event) => event.sessionId === started.sessionId)
  const verdict = evaluateOutputStall({
    windows,
    health,
    pauseStartSeconds: pauseAfterFrames / FPS,
    pauseSeconds: (pauseMs * pauseRepeat) / 1000,
    fileSeconds
  })
  report = {
    ...report,
    pass: verdict.failures.length === 0,
    sessionId: started.sessionId,
    file,
    fileSeconds,
    verdict,
    windows: windows.map(({ startSeconds, amplitude440 }) => ({
      startSeconds,
      amplitude440: Number(amplitude440.toFixed(4))
    })),
    health: health.map(({ code, level, message }) => ({ code, level, message }))
  }
  assert.deepEqual(verdict.failures, [])
  console.log(
    `Output-stall smoke PASS: ${verdict.stallEvents} stall report(s), the microphone back at ${verdict.resumedAt?.toFixed(1)} s and never reported lost. Evidence: ${reportPath}`
  )
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.health ??= events.health.map(({ code, level, message }) => ({ code, level, message }))
  report.recording ??= events.recording.map(({ state, outputPath, message }) => ({
    state,
    outputPath,
    message
  }))
  console.error(`Output-stall smoke FAIL: ${report.error}`)
  process.exitCode = 1
} finally {
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (backend) {
    if (active) await request(backend, timeoutMs, 'session.stop', {}).catch(() => {})
    backend.close()
  }
  await launched?.stop()
}
