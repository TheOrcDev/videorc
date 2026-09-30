// Linux portal → file smoke: launch the dev app, grant the portal monitor
// source, restart it once inside the same backend (the second portal session
// is what hung on ogre, 2026-09-27), then record a screen-only session from
// that source and prove the finalized file carries video.
//
// Every backend request is bounded by VIDEORC_PORTAL_STEP_TIMEOUT_MS so a
// wedged portal or session.start fails the smoke in seconds, not minutes.
//
// First run on a box is interactive (the compositor's picker appears); the
// restore token persisted beside the database makes later starts silent.
//
//   VIDEORC_PORTAL_WAIT_MS            consent wait for the first start (default 60000)
//   VIDEORC_PORTAL_STEP_TIMEOUT_MS    every later request (default 45000)
//   VIDEORC_PORTAL_RECORDING_MS       take length (default 6000)
//   VIDEORC_PORTAL_RECORD_MOTION      '0' records the desktop as it is and
//                                     keeps freeze/repeat findings advisory
//   VIDEORC_SMOKE_OUTPUT_DIR          evidence + recording directory
//
// Safe GPU: the encoder defaults to OpenH264. Set VIDEORC_LINUX_H264_ENCODER
// yourself to exercise VAAPI on a render node the box allows.

import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import {
  PORTAL_MONITOR_SOURCE_ID,
  assessPortalRecording,
  assessPortalScreenStatus
} from './lib/linux-portal-capture-gates.mjs'
import { isLinuxSmokeEvidenceLine } from './lib/linux-smoke-evidence.mjs'
import { startLinuxMotionWindow } from './lib/linux-motion-window.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const launchTimeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const consentWaitMs = Number(process.env.VIDEORC_PORTAL_WAIT_MS ?? 60000)
const stepTimeoutMs = Number(process.env.VIDEORC_PORTAL_STEP_TIMEOUT_MS ?? 45000)
const recordingMs = Number(process.env.VIDEORC_PORTAL_RECORDING_MS ?? 6000)
// A static desktop only repaints on damage, so exact repeats are its correct
// output and the analyzer's freeze gates say nothing about the pipeline.
// With a window repainting every frame on the captured monitor they do.
const motionEnabled = process.env.VIDEORC_PORTAL_RECORD_MOTION !== '0'
const encoder = process.env.VIDEORC_LINUX_H264_ENCODER ?? 'openh264'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-portal-record-'))
)
mkdirSync(outputDirectory, { recursive: true })
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(resolve(import.meta.dirname, '..'), 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg')
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'

const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 8000 }
const sources = {
  screenId: PORTAL_MONITOR_SOURCE_ID,
  windowId: null,
  cameraId: null,
  microphoneId: null,
  testPattern: false
}
const layout = {
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
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  contract: 'linux-portal-screen-record-to-file',
  source: PORTAL_MONITOR_SOURCE_ID,
  encoder,
  video,
  recordingMs,
  motion: motionEnabled,
  steps: [],
  failures: []
}

function saveEvidence() {
  writeFileSync(
    join(outputDirectory, 'linux-portal-record.json'),
    JSON.stringify(evidence, null, 2)
  )
}

function step(name, detail) {
  const entry = { name, at: new Date().toISOString(), ...detail }
  evidence.steps.push(entry)
  console.log(`[portal-record] ${name}: ${JSON.stringify(detail).slice(0, 400)}`)
  saveEvidence()
}

function fail(message) {
  evidence.failures.push(message)
  saveEvidence()
  console.error(`Linux portal record smoke FAILED: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

// preview.screen.start answers after a bounded caller wait; a portal session
// that is still negotiating reports `starting`. Poll until frames flow.
async function waitForLiveScreen(ws, label, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let status = await request(ws, stepTimeoutMs, 'preview.screen.status')
  while (Date.now() < deadline) {
    if (status.state === 'live' && (status.framesCaptured ?? 0) >= 10) break
    if (status.state !== 'live' && status.state !== 'starting') break
    await sleep(500)
    status = await request(ws, stepTimeoutMs, 'preview.screen.status')
  }
  const assessment = assessPortalScreenStatus(status, { expect: 'granted' })
  step(label, {
    state: status.state,
    framesCaptured: status.framesCaptured ?? 0,
    width: status.width ?? null,
    height: status.height ?? null,
    message: status.message ?? null
  })
  if (!assessment.ok) fail(`${label}: ${assessment.failures.join('; ')}`)
  return status
}

async function startPortalPreview(ws, label, timeoutMs) {
  const startedAt = Date.now()
  const status = await request(ws, timeoutMs, 'preview.screen.start', {
    sources,
    video,
    ffmpegPath
  })
  step(`${label} start`, { state: status.state, ms: Date.now() - startedAt })
  return waitForLiveScreen(ws, `${label} live`, timeoutMs - (Date.now() - startedAt))
}

if (process.platform !== 'linux') {
  console.error('Linux portal record smoke FAILED: this smoke only runs on Linux')
  process.exit(1)
}

let stopApp = async () => {}
let stopMotion = async () => {}
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_LINUX_H264_ENCODER: encoder
    },
    timeoutMs: launchTimeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (
        process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1' ||
        isLinuxSmokeEvidenceLine(line) ||
        /portal screen capture|portal PipeWire|portal restore token|command-lane|session\.start/.test(
          line
        )
      ) {
        console.log(line)
      }
    }
  })
  stopApp = launch.stop
  const ws = await connectBackend(launch.connections['backend-ready'], launchTimeoutMs)
  const smoke = launch.connections['preview-motion-ready']

  // 1. First portal session (the picker may appear on a fresh box).
  await startPortalPreview(ws, 'portal preview #1', Math.max(stepTimeoutMs, consentWaitMs + 10000))

  // 2. A second portal session in the same backend process. Before the
  //    persistent portal runtime this hung forever on a dead D-Bus
  //    connection, and every later session.start waited behind it.
  const stopped = await request(ws, stepTimeoutMs, 'preview.screen.stop')
  step('portal preview #1 stop', { state: stopped.state })
  await startPortalPreview(ws, 'portal preview #2', stepTimeoutMs)

  // 3. Record from the live portal source, with guaranteed motion on it.
  if (motionEnabled) {
    const motion = await startLinuxMotionWindow({ timeoutMs: stepTimeoutMs })
    stopMotion = motion.stop
    step('motion window', { pid: motion.pid })
    // Let the compositor map and paint it before the take starts.
    await sleep(1000)
  }
  const { capabilityId } = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs: stepTimeoutMs }
  )
  const startRequestedAt = Date.now()
  const started = await request(ws, stepTimeoutMs, 'session.start', {
    sources,
    layout,
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: capabilityId,
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  step('session.start', {
    state: started.state,
    sessionId: started.sessionId ?? null,
    ms: Date.now() - startRequestedAt,
    message: started.message ?? null
  })
  if (started.state !== 'recording') {
    fail(`session.start state ${started.state}: ${started.message ?? ''}`)
  }
  await sleep(recordingMs)
  const diagnostics = await request(ws, stepTimeoutMs, 'diagnostics.stats')
  step('diagnostics', {
    encodeBackend: diagnostics.encodeBackend ?? null,
    encoderBridgeEncodedOutputFrames: diagnostics.encoderBridgeEncodedOutputFrames ?? null,
    encoderBridgeError: diagnostics.encoderBridgeError ?? null,
    compositorFallbackReason: diagnostics.compositorFallbackReason ?? null
  })
  const stopRequestedAt = Date.now()
  const stoppedSession = await request(ws, stepTimeoutMs, 'session.stop')
  step('session.stop', { state: stoppedSession.state, ms: Date.now() - stopRequestedAt })
  await stopMotion()

  const outputPath = await resolveFinalRecordingPath({
    started,
    stopped: stoppedSession,
    timeoutMs: stepTimeoutMs
  })
  if (!outputPath || !existsSync(outputPath)) fail('recording produced no output file')
  const sizeBytes = statSync(outputPath).size
  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    expectAudio: false
  })
  writeReports(quality)
  const { metrics } = quality
  evidence.recording = {
    outputPath,
    sizeBytes,
    codec: metrics.codec,
    width: metrics.width,
    height: metrics.height,
    durationSeconds: metrics.durationSeconds,
    observedFrames: metrics.observedFrames,
    observedFps: metrics.observedFps,
    uniqueFrameCount: metrics.uniqueFrameCount,
    hasAudio: metrics.hasAudio,
    analyzerFailures: quality.verdict.failures,
    analyzerWarnings: quality.verdict.warnings
  }
  step('recording', evidence.recording)
  const assessment = assessPortalRecording(
    { metrics, sizeBytes },
    { width: video.width, height: video.height, recordingMs }
  )
  if (!assessment.ok) fail(assessment.failures.join('; '))
  if (motionEnabled && quality.verdict.failures.length > 0) {
    fail(`quality gates with motion on screen: ${quality.verdict.failures.join('; ')}`)
  }

  const previewStopped = await request(ws, stepTimeoutMs, 'preview.screen.stop')
  step('portal preview #2 stop', { state: previewStopped.state })
  ws.close()
  evidence.outcome = 'pass'
  saveEvidence()
  console.log(
    `Linux portal record smoke PASS: ${outputPath} (${sizeBytes} bytes, ` +
      `${metrics.durationSeconds?.toFixed?.(2)}s ${metrics.width}x${metrics.height} ${metrics.codec}); ` +
      `evidence in ${outputDirectory}`
  )
} catch (error) {
  if (!evidence.failures.length) {
    evidence.failures.push(String(error?.stack ?? error))
    console.error(`Linux portal record smoke FAILED: ${error?.stack ?? error}`)
  }
  evidence.outcome = 'fail'
  saveEvidence()
  process.exitCode = 1
} finally {
  await stopMotion()
  await stopApp()
}
