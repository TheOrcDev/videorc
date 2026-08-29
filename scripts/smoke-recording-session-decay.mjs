// Multi-session recording decay smoke (second-session lag plan, D1).
//
// The 2026-08-24 owner regression on 0.9.71: the FIRST recording of a backend
// generation is clean, later ones are majority-frozen (compositor re-serves
// held frames at full cadence; preview lags identically). Every existing
// recording smoke records ONCE per app launch (or, like the matrix smoke,
// varies the profile per session and never gates on freshness), so per-session
// decay inside one backend generation was invisible to every gate.
//
// This smoke records N IDENTICAL sessions against ONE dev-app/backend launch
// with hard (per-frame noise) content, so a held frame is a literal duplicate,
// and holds EVERY session — not just the first — to the analyzer's freshness
// gates (freezedetect + exact-repeat), plus the bridge's own fresh/repeat
// counters from the authoritative final recording-frame-accounting event. The
// live diagnostics snapshot is retained as context, never as the final oracle.
//
// Usage: pnpm smoke:session-decay
//   VIDEORC_DECAY_SESSIONS=6           session count (default 6)
//   VIDEORC_DECAY_RECORDING_MS=15000   per-session capture length (real-source
//                                      default: 65000)
//   VIDEORC_DECAY_IDLE_MS=8000         idle gap between sessions
//   VIDEORC_DECAY_REAL_SCREEN=1        capture the real screen (needs the
//                                      dev app's Screen Recording TCC grant;
//                                      records your screen — run intentionally)
//   VIDEORC_DECAY_REAL_CAMERA=1        add the first real camera
//   VIDEORC_DECAY_WIDTH/HEIGHT/FPS/BITRATE_KBPS   output profile override
//   VIDEORC_SMOKE_OUTPUT_DIR=...       artifact + report directory
//
// With real sources, screen/camera content may be legitimately static, so
// freezedetect demotes to evidence and the bridge's own fresh/repeat counters
// (content-independent: a repeat means the compositor delivered no new frame
// in time) become the hard freshness gate.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  captureDecayEvidenceGates,
  captureRecoveryObservation,
  createCaptureDecaySample,
  evaluateLongRecordingRuntimeEvidence,
  longRecordingEvidenceFailures,
  sourceSurfaceSnapshot
} from './lib/capture-decay-soak.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import {
  launchScreenMotionStimulus,
  screenMotionStimulusTeardownFailures,
  stopScreenMotionStimulus
} from './lib/screen-motion-stimulus.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { pickDevice } from './lib/source-selection.mjs'
import {
  evaluateSessionDecayEvidence,
  evaluateSessionDecayLifecycleEvents,
  waitForSessionTerminalStatus
} from './lib/session-decay-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    process.env.VIDEORC_CAPTURE_DECAY_LONG_RECORDING_OUTPUT_DIR ??
    join(tmpdir(), `videorc-session-decay-${Date.now()}`)
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-session-decay-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const launchTimeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const rpcTimeoutMs = Number(process.env.VIDEORC_DECAY_RPC_TIMEOUT_MS ?? 10_000)
// Session stop owns encoder drain, container finalization, and artifact
// publication. Keep it independent from the short control/status RPC budget:
// the backend deliberately allows finalization to run for up to 25 seconds.
const finalizationTimeoutMs = Number(process.env.VIDEORC_DECAY_FINALIZATION_TIMEOUT_MS ?? 60_000)
const realScreen = process.env.VIDEORC_DECAY_REAL_SCREEN === '1'
const realCamera = process.env.VIDEORC_DECAY_REAL_CAMERA === '1'
const sessionCount = Number(process.env.VIDEORC_DECAY_SESSIONS ?? 6)
const recordingMs = Number(
  process.env.VIDEORC_DECAY_RECORDING_MS ?? (realScreen || realCamera ? 65000 : 15000)
)
const idleMs = Number(process.env.VIDEORC_DECAY_IDLE_MS ?? 8000)
const captureDecayLongRecording = process.env.VIDEORC_CAPTURE_DECAY_LONG_RECORDING === '1'
const longRecordingMinimumRatio = Number(process.env.VIDEORC_DECAY_MIN_RECORDING_RATIO ?? 0.97)
const recordingStatusPollMs = Number(process.env.VIDEORC_DECAY_STATUS_POLL_MS ?? 2_000)
const longRecordingRuntimeGates = captureDecayEvidenceGates({
  env: process.env,
  sampleSeconds: recordingStatusPollMs / 1_000
})

// VIDEORC_DECAY_PACKAGED_APP: drive the INSTALLED app instead of the dev app.
// The packaged bundle carries the user's real TCC camera/screen grants, which
// the ad-hoc dev Electron cannot obtain on this box (macOS refuses to prompt).
const packagedAppExecutable =
  process.env.VIDEORC_DECAY_PACKAGED_APP === '1'
    ? (process.env.VIDEORC_PACKAGED_APP_EXECUTABLE ??
      '/Applications/Videorc.app/Contents/MacOS/Videorc')
    : null
const packagedSmokeCapability = packagedAppExecutable
  ? randomBytes(32).toString('base64url')
  : undefined

// One fixed shipping-shaped profile. 1080p30 holds full cadence under hard
// content on every supported box (matrix smoke proves 1080p60 does), so any
// freeze here is a pipeline defect, not encoder pressure.
const PROFILE = {
  width: Number(process.env.VIDEORC_DECAY_WIDTH ?? 1920),
  height: Number(process.env.VIDEORC_DECAY_HEIGHT ?? 1080),
  fps: Number(process.env.VIDEORC_DECAY_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_DECAY_BITRATE_KBPS ?? 6000)
}

// Freshness is the whole point: freeze segments and exact-repeat runs are
// hard failures on EVERY session index. The owner's frozen 0.9.71 recording
// had 51 freeze spans up to 1.3s — 400ms is loose enough for encoder jitter
// under noise content and still fails that file on dozens of counts. Real
// sources can be legitimately static, so there freezedetect is evidence only;
// authoritative final source freshness/age and bridge accounting carry the verdict.
const DECAY_GATES = Object.freeze({
  requireMotion: !realScreen && !realCamera,
  maxFreezeMs: 400,
  minUniqueFrameRatio: 0.95,
  requireColorTags: true,
  requireValidLevel: true,
  keyframeMaxIntervalSeconds: 2.5,
  maxTailMismatchMs: 100
})

async function resolveRealSources(ws) {
  if (!realScreen && !realCamera) {
    return { testPattern: true }
  }
  const listed = await backendRequest(ws, 'devices.list', { ffmpegPath })
  const devices = listed?.devices ?? []
  const sources = { testPattern: false }
  if (realScreen) {
    const screen = pickDevice(devices, 'screen', {
      nativePrefix: 'screen:screencapturekit:',
      requireNative: true
    })
    if (!screen) throw new Error('no screen device for VIDEORC_DECAY_REAL_SCREEN=1')
    sources.screenId = screen.id
    console.log(`[session-decay] real screen: ${screen.name} (${screen.id})`)
  }
  if (realCamera) {
    const camera = pickDevice(devices, 'camera', {
      override: process.env.VIDEORC_DECAY_CAMERA_ID,
      nativePrefix: 'camera:avfoundation-native:'
    })
    if (!camera) throw new Error('no camera device for VIDEORC_DECAY_REAL_CAMERA=1')
    sources.cameraId = camera.id
    console.log(`[session-decay] real camera: ${camera.name} (${camera.id}, ${camera.status})`)
  }
  return sources
}

function sessionParams(outputDirectoryCapability, sources) {
  return {
    sources,
    layout: {
      layoutPreset: 'screen-camera',
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
      ...(outputDirectoryCapability ? { outputDirectoryCapability } : {}),
      video: { preset: 'custom', ...PROFILE },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}

const FRESHNESS_KEYS = [
  'compositorFramesRendered',
  'compositorTickSkipped',
  'encoderBridgeInputFps',
  'encoderBridgeFreshFrames',
  'encoderBridgeRepeatedFrames',
  'encoderBridgeSyntheticFrames',
  'encoderBridgeDroppedFrames',
  'encoderBridgeEncodedOutputFrames',
  'encoderBridgeCompositorWaitP95Ms',
  'compositorCameraSourceFreshServes',
  'compositorCameraSourceHeldServes',
  'compositorCameraSourceServedAgeMaxMs',
  'compositorScreenSourceFreshServes',
  'compositorScreenSourceHeldServes',
  'compositorScreenSourceServedAgeMaxMs'
]

async function recordSession({ ws, smoke, index, sources, backendEvents }) {
  let capabilityId
  if (!packagedAppExecutable) {
    const authorization = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { kind: 'output-directory', path: outputDirectory },
      { timeoutMs: rpcTimeoutMs }
    )
    capabilityId = authorization.capabilityId
  }
  const recoveryObservationStart = recoveryObservations.length
  const laggedEventStart = laggedEvents.length
  const longRecordingInitialStats = captureDecayLongRecording
    ? await backendRequest(ws, 'diagnostics.stats')
    : null
  const started = await backendRequest(ws, 'session.start', sessionParams(capabilityId, sources))
  if (started.state !== 'recording' || !started.sessionId) {
    throw new Error(`session.start state ${started.state}: ${started.message ?? ''}`)
  }
  const recordingStatusSamples = [started]
  let longRecordingRuntime = null
  if (captureDecayLongRecording) {
    longRecordingRuntime = await monitorActiveRecording({
      ws,
      sessionId: started.sessionId,
      durationMs: recordingMs,
      statusSamples: recordingStatusSamples,
      recoveryObservationStart,
      laggedEventStart,
      initialStats: longRecordingInitialStats
    })
  } else {
    await interruptibleSleep(recordingMs)
  }
  if (interruptedSignal) {
    throw new Error(`recording interrupted by ${interruptedSignal}`)
  }
  const diagnostics = await backendRequest(ws, 'diagnostics.stats')
  const liveDiagnostics = Object.fromEntries(
    FRESHNESS_KEYS.filter((key) => diagnostics[key] !== undefined).map((key) => [
      key,
      diagnostics[key]
    ])
  )
  const stopped = await backendRequest(ws, 'session.stop', undefined, finalizationTimeoutMs)
  const terminalStatus = await waitForSessionTerminalStatus({
    events: backendEvents,
    sessionId: started.sessionId,
    timeoutMs: finalizationTimeoutMs
  })
  const lifecycle = evaluateSessionDecayLifecycleEvents({
    events: backendEvents,
    sessionId: started.sessionId
  })
  const finalAccounting = lifecycle.accounting
  const bridge = finalAccounting?.diagnostics ?? {}
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error('recording produced no output file')
  }

  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: PROFILE.fps,
    expectAudio: true,
    gates: DECAY_GATES
  })
  writeReports(quality)

  const accounting = evaluateSessionDecayEvidence({
    diagnostics: bridge,
    requestedSources: { screen: realScreen, camera: realCamera },
    targetFps: finalAccounting?.targetFps,
    elapsedMs: finalAccounting?.elapsedMs
  })
  const terminalFailures =
    terminalStatus.state === 'failed'
      ? [`session ${started.sessionId} reported terminal recording state failed`]
      : []
  const longRecordingFailures = captureDecayLongRecording
    ? longRecordingEvidenceFailures({
        requestedDurationMs: recordingMs,
        minimumRatio: longRecordingMinimumRatio,
        sessionId: started.sessionId,
        statusSamples: recordingStatusSamples,
        artifactDurationSeconds: quality.metrics.durationSeconds,
        accountingElapsedMs: finalAccounting?.elapsedMs,
        runtimeEvidenceFailures: longRecordingRuntime?.failures ?? [
          'long recording runtime capture/recovery evidence is unavailable'
        ]
      })
    : []
  const sessionLaggedEvents = laggedEvents.slice(laggedEventStart)
  const laggedEventFailures =
    sessionLaggedEvents.length > 0
      ? [
          `backend event stream lagged ${sessionLaggedEvents.length} time(s) during recording/finalization; session evidence is incomplete`
        ]
      : []
  const continuationFailures = [
    ...accounting.failures,
    ...lifecycle.failures,
    ...terminalFailures,
    ...longRecordingFailures,
    ...laggedEventFailures
  ]
  const failures = [
    ...quality.verdict.failures,
    ...accounting.failures,
    ...lifecycle.failures,
    ...terminalFailures,
    ...longRecordingFailures,
    ...laggedEventFailures
  ]
  const observedFps = quality.metrics.observedFps
  if (observedFps != null && Math.abs(observedFps - PROFILE.fps) > PROFILE.fps * 0.05) {
    failures.push(`observed fps ${observedFps.toFixed(2)} != requested ${PROFILE.fps}`)
  }
  return {
    session: index + 1,
    outputPath,
    sizeBytes: statSync(outputPath).size,
    failures,
    warnings: quality.verdict.warnings,
    longestFreezeMs: quality.metrics.longestFreezeMs ?? null,
    freezeCount: quality.metrics.freezeCount ?? null,
    observedFps,
    degradedRatio: accounting.bridge.degradedRatio,
    bridge,
    liveDiagnostics,
    accounting,
    lifecycle,
    longRecordingEvidence: captureDecayLongRecording
      ? {
          requestedDurationMs: recordingMs,
          minimumRatio: longRecordingMinimumRatio,
          artifactDurationSeconds: quality.metrics.durationSeconds,
          accountingElapsedMs: finalAccounting?.elapsedMs ?? null,
          recordingStatusSamples,
          runtime: longRecordingRuntime,
          laggedEvents: sessionLaggedEvents
        }
      : null,
    continuationFailures
  }
}

async function monitorActiveRecording({
  ws,
  sessionId,
  durationMs,
  statusSamples,
  recoveryObservationStart,
  laggedEventStart,
  initialStats
}) {
  const startedAt = Date.now()
  const deadline = startedAt + durationMs
  const samples = []
  let previousStats = initialStats
  let previousAtMs = startedAt
  let activeSurfaceBaseline = null
  while (Date.now() < deadline && !interruptedSignal) {
    await interruptibleSleep(Math.min(recordingStatusPollMs, deadline - Date.now()))
    if (interruptedSignal) break
    const [
      status,
      stats,
      surfaceStatus,
      cameraStatus,
      screenStatus,
      compositorStatus,
      recoveryStatus
    ] = await Promise.all([
      backendRequest(ws, 'recording.status'),
      backendRequest(ws, 'diagnostics.stats'),
      backendRequest(ws, 'preview.surface.status'),
      backendRequest(ws, 'preview.camera.status'),
      backendRequest(ws, 'preview.screen.status'),
      backendRequest(ws, 'compositor.status'),
      backendRequest(ws, 'capture.recovery.status')
    ])
    const sampledAtMs = Date.now()
    statusSamples.push(status)
    if (status?.state !== 'recording' || status?.sessionId !== sessionId) {
      throw new Error(
        `long recording stopped before its requested duration: expected ${sessionId}/recording, got ${status?.sessionId ?? 'missing'}/${status?.state ?? 'missing'} after ${Date.now() - startedAt}ms`
      )
    }
    recoveryObservations.push(
      captureRecoveryObservation(recoveryStatus, sampledAtMs, 'long-recording-rpc')
    )
    samples.push(
      createCaptureDecaySample({
        stats,
        surfaceStatus,
        cameraStatus,
        screenStatus,
        compositorStatus,
        recoveryStatus,
        previousStats,
        nowMs: sampledAtMs,
        previousAtMs,
        startedAtMs: startedAt
      })
    )
    activeSurfaceBaseline ??= sourceSurfaceSnapshot(stats)
    previousStats = stats
    previousAtMs = sampledAtMs
  }
  const evaluated = evaluateLongRecordingRuntimeEvidence({
    samples,
    plannedDurationMs: durationMs,
    sampleIntervalMs: recordingStatusPollMs,
    activeSurfaceBaseline,
    recoveryObservations: recoveryObservations.slice(recoveryObservationStart),
    laggedEvents: laggedEvents.slice(laggedEventStart),
    gates: longRecordingRuntimeGates
  })
  return {
    ...evaluated,
    samples,
    activeSurfaceBaseline,
    recoveryObservations: recoveryObservations.slice(recoveryObservationStart),
    laggedEvents: laggedEvents.slice(laggedEventStart)
  }
}

const results = []
const backendEvents = []
const recoveryObservations = []
const laggedEvents = []
const cleanupFailures = []
const processTeardownEvidence = { motionStimulus: null, app: null }
let stopApp = async () => {}
let activeWs = null
let motionStimulus = null
let launchedOk = false
let interruptedSignal = null
let eventStreamFailure = null
let wakeSleep = null
const signalHandlers = new Map(
  ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => requestInterruption(signal)])
)
for (const [signal, handler] of signalHandlers) process.on(signal, handler)
if (!realScreen && !realCamera) {
  console.log(
    '[session-decay] synthetic hard-content mode proves lifecycle/accounting only; ' +
      'it does not prove real-device source freshness (run with REAL_SCREEN/REAL_CAMERA under TCC).'
  )
}
try {
  const launch = await launchDevApp({
    spawnSpec: packagedAppExecutable ? { command: packagedAppExecutable, args: [] } : undefined,
    packagedSmokeCommandCapability: packagedSmokeCapability,
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      ...(packagedAppExecutable
        ? {
            VIDEORC_PACKAGED_SMOKE_TEST: '1',
            VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability,
            VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
          }
        : {}),
      // Per-frame noise: every compositor-fresh frame is unique, so a held
      // frame is an exact duplicate and freezedetect sees it immediately.
      VIDEORC_SYNTHETIC_HARD_CONTENT: '1'
    },
    timeoutMs: launchTimeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1') console.log(line)
    }
  })
  stopApp = launch.stop
  launchedOk = true
  const ws = await connectBackend(launch.connections['backend-ready'], launchTimeoutMs)
  activeWs = ws
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data)
      if (
        message?.event === 'health.event' ||
        message?.event === 'session.log' ||
        message?.event === 'recording.status'
      ) {
        backendEvents.push(message)
      } else if (message?.event === 'capture.recovery.status') {
        recoveryObservations.push(captureRecoveryObservation(message.payload, Date.now(), 'event'))
      } else if (message?.event === 'events.lagged') {
        laggedEvents.push({ ...message.payload, observedAt: new Date().toISOString() })
        eventStreamFailure = `backend event stream lagged (skipped ${message?.payload?.skipped ?? 'unknown'} event(s))`
        activeWs?.close()
      }
    } catch {
      // Ignore non-JSON socket noise.
    }
  })
  const smoke = launch.connections['preview-motion-ready']
  const sources = await resolveRealSources(ws)
  if (interruptedSignal) throw new Error(`session-decay interrupted by ${interruptedSignal}`)
  if (realScreen) {
    motionStimulus = await launchScreenMotionStimulus({
      outputDirectory,
      ffmpegPath
    })
    console.log('[session-decay] screen motion stimulus running')
  }

  for (let index = 0; index < sessionCount && !interruptedSignal; index += 1) {
    try {
      const result = await recordSession({ ws, smoke, index, sources, backendEvents })
      results.push(result)
      const status = result.failures.length === 0 ? 'PASS' : 'FAIL'
      const serves = (kind) => {
        const fresh = result.bridge?.[`compositor${kind}SourceFreshServes`]
        const held = result.bridge?.[`compositor${kind}SourceHeldServes`]
        if (typeof fresh !== 'number' || typeof held !== 'number') return 'n/a'
        return `${fresh}f/${held}h`
      }
      console.log(
        `Session decay [${result.session}/${sessionCount}] ${status}: ` +
          `${(result.sizeBytes / 1024).toFixed(0)}KB, ` +
          `fps ${result.observedFps == null ? '?' : result.observedFps.toFixed(2)}, ` +
          `degraded bridge ${Number.isFinite(result.degradedRatio) ? `${(result.degradedRatio * 100).toFixed(1)}%` : 'n/a'}, ` +
          `serves screen ${serves('Screen')} camera ${serves('Camera')}`
      )
      for (const failure of result.failures) {
        console.error(`  ❌ ${failure}`)
      }
      if (result.continuationFailures.length > 0) {
        console.error(
          'Session decay is aborting before the next session because final accounting or writer lifecycle evidence failed.'
        )
        break
      }
    } catch (error) {
      const failures = [String(error?.message ?? error)]
      console.error(
        `Session decay [${index + 1}/${sessionCount}] FAIL: ${String(error?.message ?? error)}`
      )
      try {
        const recoveryStopped = await backendRequest(
          ws,
          'session.stop',
          undefined,
          finalizationTimeoutMs
        )
        if (recoveryStopped?.state !== 'idle') {
          failures.push(
            `recovery session.stop did not confirm idle state (got ${recoveryStopped?.state ?? 'missing'})`
          )
        }
      } catch (stopError) {
        failures.push(
          `recovery session.stop could not be confirmed: ${String(stopError?.message ?? stopError)}`
        )
      }
      results.push({ session: index + 1, failures })
      console.error(
        'Session decay is aborting before the next session after an unconfirmed failure.'
      )
      break
    }
    if (index + 1 < sessionCount) {
      await interruptibleSleep(idleMs)
    }
  }
} catch (error) {
  console.error(`Session decay smoke failed to launch: ${String(error?.message ?? error)}`)
} finally {
  if (motionStimulus) {
    try {
      processTeardownEvidence.motionStimulus = await stopScreenMotionStimulus(motionStimulus)
      cleanupFailures.push(
        ...screenMotionStimulusTeardownFailures(processTeardownEvidence.motionStimulus)
      )
    } catch (error) {
      cleanupFailures.push(
        `screen motion stimulus teardown threw: ${error?.message ?? String(error)}`
      )
    }
  }
  activeWs?.close()
  activeWs = null
  try {
    processTeardownEvidence.app = (await stopApp()) ?? null
  } catch (error) {
    cleanupFailures.push(`app process teardown failed: ${error?.message ?? String(error)}`)
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
}

if (cleanupFailures.length > 0 && results.length > 0) {
  const finalResult = results.at(-1)
  finalResult.failures = [...(finalResult.failures ?? []), ...cleanupFailures]
}
if (results.length > 0) {
  results.at(-1).processTeardownEvidence = processTeardownEvidence
}

const resultsPath = join(outputDirectory, 'session-decay-results.json')
const teardownPath = join(outputDirectory, 'session-decay-teardown.json')
try {
  writeFileSync(resultsPath, JSON.stringify(results, null, 1))
  writeFileSync(
    teardownPath,
    `${JSON.stringify({ processTeardownEvidence, cleanupFailures }, null, 2)}\n`
  )
} catch {
  // The console summary below is the primary output.
}

const failed = results.filter((result) => result.failures.length > 0)
if (interruptedSignal) {
  console.error(
    `Session decay interrupted by ${interruptedSignal}; owned app processes were reaped.`
  )
  process.exitCode = signalExitCode(interruptedSignal)
} else if (!launchedOk || results.length !== sessionCount) {
  console.error('Session decay smoke did not run every session.')
  process.exitCode = 1
} else if (cleanupFailures.length > 0) {
  console.error('Session decay process teardown failed after the recording evidence completed.')
  for (const failure of cleanupFailures) console.error(`  ❌ ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `\nSession decay: ${results.length - failed.length}/${results.length} sessions PASS ` +
      `(reports in ${outputDirectory})`
  )
  if (failed.length > 0) {
    console.error(`Failing sessions: ${failed.map((result) => result.session).join(', ')}`)
    process.exitCode = 1
  }
}

function requestInterruption(signal) {
  if (!interruptedSignal) interruptedSignal = signal
  wakeSleep?.()
  activeWs?.close()
}

async function backendRequest(ws, method, params, timeoutMs = rpcTimeoutMs) {
  if (interruptedSignal) {
    throw new Error(`${method} interrupted by ${interruptedSignal}`)
  }
  if (eventStreamFailure) {
    throw new Error(`${method} refused because ${eventStreamFailure}`)
  }
  return request(ws, timeoutMs, method, params)
}

function interruptibleSleep(ms) {
  if (interruptedSignal || ms <= 0) return Promise.resolve()
  return new Promise((resolveSleep) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (wakeSleep === finish) wakeSleep = null
      resolveSleep()
    }
    const timer = setTimeout(finish, ms)
    wakeSleep = finish
  })
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return 1
}
