// Long-uptime capture-decay soak (2026-08-27 capture-decay plan, D2/D3).
//
// The field failure this hunts: after minutes-to-hours of app uptime — no
// recording required — real camera/screen delivery can settle into a stable
// low-rate equilibrium while the compositor continues re-serving held frames.
// This harness keeps an interruption-safe decay curve with the direct
// capture-callback, frame-store publication, freshness, latency, and retained
// surface evidence needed to distinguish capture starvation from retention.
//
// Usage:
//   pnpm smoke:capture-decay-soak
//   pnpm smoke:capture-decay-soak:quick
//   pnpm smoke:capture-decay-soak:gate
//
// Environment:
//   VIDEORC_SOAK_MINUTES=60
//   VIDEORC_SOAK_SAMPLE_SECONDS=10       (--gate defaults to 2s)
//   VIDEORC_SOAK_REAL_SOURCES=1          installed app + native SCK/AVF
//   VIDEORC_SOAK_SCREEN_ID=...
//   VIDEORC_SOAK_CAMERA_ID=...
//   VIDEORC_PACKAGED_APP_EXECUTABLE=...
//   VIDEORC_SOAK_DEBUG_APP_EXECUTABLE=...  (--recovery-gate only)
//   VIDEORC_SMOKE_OUTPUT_DIR=...
//   VIDEORC_SOAK_SOURCE_READY_TIMEOUT_MS=90000
//   VIDEORC_SOAK_SOURCE_READY_POLL_MS=2000
//   VIDEORC_SOAK_SOURCE_READY_CONSECUTIVE_POLLS=3
//   VIDEORC_SOAK_MIN_SAMPLE_COVERAGE=0.95
//   VIDEORC_SOAK_MAX_SAMPLE_GAP_MS=...  (default 3 sample intervals)
//   VIDEORC_SOAK_MAX_SURFACE_LIVE_COUNT=12
//   VIDEORC_SOAK_MAX_SURFACE_PEAK_COUNT=16
//   VIDEORC_SOAK_MAX_SURFACE_SLOPE_PER_MINUTE=0.05
//   VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES=10
//   VIDEORC_SOAK_SURFACE_GROWTH_ALLOWANCE=2
//   VIDEORC_SOAK_SURFACE_RELEASE_TIMEOUT_MS=10000
//
// Real mode captures the real screen and opens a visible motion stimulus. Run
// it intentionally on a macOS account where the installed app has camera and
// Screen Recording permission. Synthetic mode explicitly stops real source
// previews and proves compositor cadence without touching either device.

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  captureDecayCsvHeader,
  captureDecayCsvRow,
  captureDecayLayout,
  captureDecaySoakConfig,
  captureRecoveryArmFailures,
  captureRecoveryCadenceSample,
  captureRecoveryCadenceRestoreFailures,
  captureRecoveryObservation,
  createCaptureDecaySample,
  effectiveCompositorTargetFps,
  evaluateCaptureDecayEvidence,
  evaluateCaptureRecoveryEvidence,
  evaluateDualCaptureRecoveryRecordingEvidence,
  nativeRetentionSnapshot,
  nativePreviewFailures,
  realSourceProgressFailures,
  realSourceShippingPathFailures,
  realSourceSurfaceBackingFailures,
  realSourceSampleFailures,
  realSourceCadenceBaseline,
  renderCadenceFailures,
  retentionTeardownFailures,
  sceneCommitFailures,
  selectNativeSoakSources,
  sourceSurfaceSnapshot,
  sourceSelectionForPreview,
  surfaceReturnFailures,
  syntheticIsolationFailures
} from './lib/capture-decay-soak.mjs'
import {
  focusScreenMotionStimulus,
  launchScreenMotionStimulus,
  screenMotionStimulusTeardownFailures,
  stopScreenMotionStimulus
} from './lib/screen-motion-stimulus.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { sha256File } from './lib/beta-release-manifest.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const config = captureDecaySoakConfig({ env: process.env, argv: process.argv.slice(2) })
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    process.env.VIDEORC_CAPTURE_DECAY_OUTPUT_DIR ??
    join(tmpdir(), `videorc-capture-soak-${Date.now()}`)
)
const reportPath = join(outputDirectory, 'capture-decay-soak.csv')
const checkpointPath = join(outputDirectory, 'capture-decay-soak.json')
const checkpointTemporaryPath = `${checkpointPath}.tmp`
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-capture-soak-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const recoveryDebugAppExecutable = process.env.VIDEORC_SOAK_DEBUG_APP_EXECUTABLE?.trim()
const packagedAppExecutable = config.realSources
  ? config.recoveryGate
    ? recoveryDebugAppExecutable
    : (process.env.VIDEORC_PACKAGED_APP_EXECUTABLE ??
      '/Applications/Videorc.app/Contents/MacOS/Videorc')
  : null
const packagedSmokeCapability = packagedAppExecutable
  ? randomBytes(32).toString('base64url')
  : undefined

mkdirSync(outputDirectory, { recursive: true })
writeFileSync(reportPath, `${captureDecayCsvHeader()}\n`, 'utf8')

const samples = []
const failures = []
let checkpoint = {
  schemaVersion: 3,
  status: 'starting',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  config: {
    gate: config.gate,
    recoveryGate: config.recoveryGate,
    releaseGate: config.releaseGate,
    realSources: config.realSources,
    soakMinutes: config.soakMinutes,
    sampleSeconds: config.sampleSeconds,
    launchTimeoutMs: config.launchTimeoutMs,
    rpcTimeoutMs: config.rpcTimeoutMs,
    sourceReadyTimeoutMs: config.sourceReadyTimeoutMs,
    sourceReadyPollMs: config.sourceReadyPollMs,
    sourceReadyConsecutivePolls: config.sourceReadyConsecutivePolls,
    surfaceReleaseTimeoutMs: config.surfaceReleaseTimeoutMs,
    realSourceFailureConsecutiveSamples: config.realSourceFailureConsecutiveSamples,
    maximumRecoveryDurationMs: config.maximumRecoveryDurationMs,
    maximumRecoveryDetectionMs: config.maximumRecoveryDetectionMs,
    recoveryRecordingMs: config.recoveryRecordingMs,
    evidenceGates: config.evidenceGates
  },
  artifacts: {
    csv: { path: reportPath, sha256: null, sizeBytes: null },
    checkpoint: { path: checkpointPath },
    recording: null
  },
  sourceSelection: null,
  startupEvidence: null,
  laggedEvents: [],
  recoveryEvents: [],
  recoveryEvidence: null,
  samplesCollected: 0,
  degradedSamples: 0,
  failures
}
writeCheckpoint()
console.log(`[capture-soak] evidence directory: ${outputDirectory}`)

let stopApp = async () => {}
let ws = null
let smoke = null
let motionStimulus = null
let motionStimulusFocusTimer = null
let interruptedSignal = null
let wakeSleep = null
let exitCode = 0
let terminalCheckpointWritten = false
let terminalStatus = 'failed'
let terminalFields = {}
let degradedSamples = 0
const processTeardownEvidence = { motionStimulus: null, app: null }
const recoveryEvents = []
const recoveryObservations = []
const recordingStatusEvents = []
const healthEvents = []
const laggedEvents = []
let recoveryGateCompletedAtMs = null
let injectedRecoveryEvidence = null
let activeRecoverySessionId = null
let lastRecoveryRecordingEvidenceAtMs = null

const signalHandlers = new Map(
  ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => requestInterruption(signal)])
)
for (const [signal, handler] of signalHandlers) process.on(signal, handler)

try {
  if (config.recoveryGate && !config.realSources) {
    throw new Error('--recovery-gate requires VIDEORC_SOAK_REAL_SOURCES=1 and a live camera')
  }
  if (config.recoveryGate && !recoveryDebugAppExecutable) {
    throw new Error(
      '--recovery-gate requires VIDEORC_SOAK_DEBUG_APP_EXECUTABLE pointing to a TCC-authorized debug Videorc executable; the installed release app cannot expose the debug-only injection RPC.'
    )
  }
  if (config.realSources && process.env.VIDEORC_SYNTHETIC_HARD_CONTENT === '1') {
    throw new Error(
      'Real-source soak refuses inherited VIDEORC_SYNTHETIC_HARD_CONTENT=1; unset it so evidence comes only from SCK/AVFoundation.'
    )
  }
  if (config.realSources && process.env.VIDEORC_SMOKE_PREVIEW_MOTION === '1') {
    throw new Error(
      'Real-source soak refuses inherited VIDEORC_SMOKE_PREVIEW_MOTION=1 because that forces the synthetic preview path.'
    )
  }
  if (config.realSources) {
    const shippingPathFailures = realSourceShippingPathFailures(process.env)
    if (shippingPathFailures.length > 0) {
      throw new Error(
        `Real-source soak requires the shipping zero-copy capture path: ${shippingPathFailures.join('; ')}`
      )
    }
  }

  const launch = await launchDevApp({
    spawnSpec: packagedAppExecutable ? { command: packagedAppExecutable, args: [] } : undefined,
    launchViaMacosLaunchServices: Boolean(packagedAppExecutable),
    packagedSmokeCommandCapability: packagedSmokeCapability,
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      ...(packagedAppExecutable
        ? {
            VIDEORC_PACKAGED_SMOKE_TEST: '1',
            VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability,
            VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
          }
        : {
            // Hard synthetic content continuously exercises compositor cadence;
            // this flag is intentionally absent from the real-source branch.
            VIDEORC_SYNTHETIC_HARD_CONTENT: '1',
            VIDEORC_SMOKE_PREVIEW_MOTION: '1'
          })
    },
    timeoutMs: config.launchTimeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1') console.log(line)
    }
  })
  stopApp = launch.stop
  smoke = launch.connections['preview-motion-ready']
  ws = await connectBackend(launch.connections['backend-ready'], config.launchTimeoutMs)
  ws.addEventListener('message', handleBackendEvent)

  const startup = config.realSources ? await prepareRealSources(ws) : await prepareSyntheticOnly(ws)
  recordRecoveryObservation(startup.recoveryStatus, 'startup-rpc')
  const startupRecovery = evaluateCaptureRecoveryEvidence({
    observations: recoveryObservations,
    maximumRecoveryDurationMs: config.maximumRecoveryDurationMs
  })
  if (startupRecovery.failures.length > 0) {
    throw new Error(
      `Capture recovery was not idle at soak startup: ${startupRecovery.failures.join('; ')}`
    )
  }
  if (config.recoveryGate) {
    injectedRecoveryEvidence = await runInjectedCaptureRecovery(ws, startup, {
      appProcessId: smoke.appPid,
      backendProcessId: launch.connections['backend-ready'].pid
    })
    const afterRecovery = await backendRequest(ws, 'diagnostics.stats')
    const revalidated = await waitForRealSourceProgress(ws, {
      before: afterRecovery,
      sources: startup.sources,
      sceneRevision: startup.sceneRevision
    })
    Object.assign(startup, {
      sampledAt: revalidated.sampledAt,
      stats: revalidated.stats,
      activeSurfaceBaseline: sourceSurfaceSnapshot(revalidated.stats),
      cameraStatus: revalidated.cameraStatus,
      screenStatus: revalidated.screenStatus,
      surfaceStatus: revalidated.surfaceStatus,
      compositorStatus: revalidated.compositorStatus,
      recoveryStatus: revalidated.recoveryStatus
    })
  }
  checkpoint = {
    ...checkpoint,
    status: 'running',
    startedAt: new Date().toISOString(),
    sourceSelection: startup.sourceSelection,
    startupEvidence: startup.evidence,
    injectedRecoveryEvidence,
    recoveryEvents,
    recoveryObservations
  }
  writeCheckpoint()

  const soakStartedAt = Date.now()
  const plannedDurationMs = config.soakMinutes * 60_000
  const deadline = soakStartedAt + plannedDurationMs
  let previous = {
    at: startup.sampledAt,
    stats: startup.stats,
    sample: createCaptureDecaySample({
      stats: startup.stats,
      surfaceStatus: startup.surfaceStatus,
      cameraStatus: startup.cameraStatus,
      screenStatus: startup.screenStatus,
      compositorStatus: startup.compositorStatus,
      recoveryStatus: startup.recoveryStatus,
      nowMs: startup.sampledAt,
      startedAtMs: soakStartedAt
    })
  }
  degradedSamples = 0
  let cadenceFailureStreak = 0
  let realSourceFailureStreak = 0
  let recoveryFailureReported = false
  let evidenceSummary = null
  let recoveryEvidence = startupRecovery.summary
  let teardownEvidence = null

  console.log(
    `[capture-soak] soaking idle for ${config.soakMinutes}m, sampling every ${config.sampleSeconds}s ` +
      `(${config.realSources ? 'REAL native SCK/AVF sources' : 'synthetic-only scene'}); no sessions will be started`
  )

  while (Date.now() < deadline && !interruptedSignal) {
    await interruptibleSleep(Math.min(config.sampleSeconds * 1000, deadline - Date.now()))
    if (interruptedSignal) break

    const [stats, surfaceStatus, cameraStatus, screenStatus, compositorStatus, recoveryStatus] =
      await Promise.all([
        backendRequest(ws, 'diagnostics.stats'),
        backendRequest(ws, 'preview.surface.status'),
        backendRequest(ws, 'preview.camera.status'),
        backendRequest(ws, 'preview.screen.status'),
        backendRequest(ws, 'compositor.status'),
        backendRequest(ws, 'capture.recovery.status')
      ])
    const now = Date.now()
    recordRecoveryObservation(recoveryStatus, 'sample-rpc', now)
    const sample = createCaptureDecaySample({
      stats,
      surfaceStatus,
      cameraStatus,
      screenStatus,
      compositorStatus,
      recoveryStatus,
      previousStats: previous.stats,
      nowMs: now,
      previousAtMs: previous.at,
      startedAtMs: soakStartedAt
    })
    const realSourceFailures = config.realSources
      ? realSourceSampleFailures({
          sample,
          previousSample: previous.sample,
          sources: startup.sources,
          sceneRevision: startup.sceneRevision,
          targetFps: startup.video.fps,
          sourceCadence: startup.sourceCadence,
          minimumRateFraction: config.evidenceGates.minimumRealSourceRateFraction,
          maximumAgeMs: config.evidenceGates.maximumRealSourceAgeMs
        })
      : []
    const sourceSurfaceFailures = config.realSources ? realSourceSurfaceBackingFailures(sample) : []
    const sourceSurfaceFailureSet = new Set(sourceSurfaceFailures)
    const sustainedFailures = realSourceFailures.filter(
      (failure) => !sourceSurfaceFailureSet.has(failure)
    )
    realSourceFailureStreak = sustainedFailures.length > 0 ? realSourceFailureStreak + 1 : 0
    sample.evidenceFailure =
      sourceSurfaceFailures.length > 0
        ? `real-source shipping-path evidence failed: ${sourceSurfaceFailures.join('; ')}`
        : sustainedFailures.length > 0
          ? `real-source evidence ${realSourceFailureStreak}/${config.realSourceFailureConsecutiveSamples}: ${sustainedFailures.join('; ')}`
          : null
    samples.push(sample)
    appendFileSync(reportPath, `${captureDecayCsvRow(sample)}\n`, 'utf8')
    previous = { at: now, stats, sample }

    if (sample.degradedStage) {
      degradedSamples += 1
      console.error(
        `[capture-soak] DEGRADED at uptime ${sample.uptimeSec}s: stage=${sample.degradedStage} ` +
          `render=${formatRate(sample.renderFps)} camera_callbacks=${formatRate(sample.cameraCaptureCallbackFps)} ` +
          `camera_publications=${formatRate(sample.cameraPublicationFps)} camera_fresh=${formatRate(sample.cameraFreshFps)} ` +
          `camera_did_drop=${formatRate(sample.cameraDidDropPerSec)} camera_oob=${formatRate(sample.cameraOutOfBuffersPerSec)} ` +
          `camera_pool=${formatCount(sample.cameraSurfaceLiveCount)}/${formatCount(sample.cameraSurfacePeakCount)}`
      )
    }

    const cadenceFailures = renderCadenceFailures(stats)
    cadenceFailureStreak = cadenceFailures.length > 0 ? cadenceFailureStreak + 1 : 0
    if (cadenceFailureStreak >= 3) {
      failures.push(...cadenceFailures.map((failure) => `uptime ${sample.uptimeSec}s: ${failure}`))
      console.error(`[capture-soak] FAIL: ${cadenceFailures.join('; ')}`)
    }

    if (realSourceFailureStreak >= config.realSourceFailureConsecutiveSamples) {
      failures.push(
        ...sustainedFailures.map(
          (failure) =>
            `uptime ${sample.uptimeSec}s: real-source evidence failed for ${realSourceFailureStreak} consecutive samples: ${failure}`
        )
      )
      console.error(`[capture-soak] FAIL: ${sustainedFailures.join('; ')}`)
    }

    if (sourceSurfaceFailures.length > 0) {
      failures.push(
        ...sourceSurfaceFailures.map(
          (failure) =>
            `uptime ${sample.uptimeSec}s: real-source shipping-path evidence failed: ${failure}`
        )
      )
      console.error(`[capture-soak] FAIL: ${sourceSurfaceFailures.join('; ')}`)
    }

    const evaluatedRecovery = evaluateRecoveryForRun()
    recoveryEvidence = evaluatedRecovery.summary
    if (!recoveryFailureReported && evaluatedRecovery.failures.length > 0) {
      recoveryFailureReported = true
      failures.push(...evaluatedRecovery.failures)
      console.error(`[capture-soak] FAIL: ${evaluatedRecovery.failures.join('; ')}`)
    }

    updateCheckpoint({
      degradedSamples,
      lastSampleAt: new Date(now).toISOString(),
      lastSample: sample,
      recoveryEvidence,
      recoveryEvents,
      recoveryObservations
    })

    if (failures.length > 0) break
    if (
      !sample.degradedStage &&
      samples.length % Math.max(1, Math.round(300 / config.sampleSeconds)) === 0
    ) {
      console.log(
        `[capture-soak] healthy at uptime ${sample.uptimeSec}s: render=${formatRate(sample.renderFps)} ` +
          `camera callbacks/publications/fresh=${formatRate(sample.cameraCaptureCallbackFps)}/${formatRate(sample.cameraPublicationFps)}/${formatRate(sample.cameraFreshFps)} ` +
          `camera didDrop/oob=${formatRate(sample.cameraDidDropPerSec)}/${formatRate(sample.cameraOutOfBuffersPerSec)} ` +
          `screen callbacks/publications/fresh=${formatRate(sample.screenCaptureCallbackFps)}/${formatRate(sample.screenPublicationFps)}/${formatRate(sample.screenFreshFps)} ` +
          `surfaces camera=${formatCount(sample.cameraSurfaceLiveCount)}/${formatCount(sample.cameraSurfacePeakCount)} ` +
          `screen=${formatCount(sample.screenSurfaceLiveCount)}/${formatCount(sample.screenSurfacePeakCount)}`
      )
    }
  }

  if (!interruptedSignal) {
    const evaluated = evaluateCaptureDecayEvidence({
      samples,
      plannedDurationMs,
      sampleIntervalMs: config.sampleSeconds * 1_000,
      activeSurfaceBaseline: startup.activeSurfaceBaseline,
      requireNativePreview: config.realSources,
      requirePositiveSourceSurfaces: config.realSources,
      requireSurfaceEvidence: true,
      gates: config.evidenceGates
    })
    evidenceSummary = evaluated.summary
    failures.push(...evaluated.failures)
    const evaluatedRecovery = evaluateRecoveryForRun()
    recoveryEvidence = evaluatedRecovery.summary
    if (!recoveryFailureReported) failures.push(...evaluatedRecovery.failures)
    updateCheckpoint({ evidenceSummary, recoveryEvidence })

    teardownEvidence = await stopCaptureGraphAndVerifySurfaceRelease(
      ws,
      startup.releasedSurfaceBaseline
    )
    failures.push(...teardownEvidence.failures)
    updateCheckpoint({ teardownEvidence })
  } else {
    await stopCaptureGraphBestEffort(ws)
  }

  if (interruptedSignal) {
    exitCode = signalExitCode(interruptedSignal)
    terminalStatus = 'interrupted'
    terminalFields = {
      interruptedSignal,
      evidenceSummary,
      recoveryEvidence,
      recoveryEvents,
      recoveryObservations,
      teardownEvidence,
      samples
    }
  } else if (degradedSamples > 0 || failures.length > 0) {
    exitCode = 1
    terminalStatus = 'failed'
    terminalFields = {
      evidenceSummary,
      recoveryEvidence,
      recoveryEvents,
      recoveryObservations,
      teardownEvidence,
      samples
    }
  } else {
    terminalStatus = 'passed'
    terminalFields = {
      evidenceSummary,
      recoveryEvidence,
      recoveryEvents,
      recoveryObservations,
      teardownEvidence,
      samples
    }
    updateCheckpoint({ status: 'validating-cleanup', ...terminalFields })
  }
} catch (error) {
  const message = error?.stack ?? String(error)
  failures.push(message)
  exitCode = interruptedSignal ? signalExitCode(interruptedSignal) : 1
  terminalStatus = interruptedSignal ? 'interrupted' : 'failed'
  terminalFields = {
    interruptedSignal,
    error: message,
    recoveryEvents,
    recoveryObservations,
    samples
  }
} finally {
  const cleanupFailures = []
  if (ws && activeRecoverySessionId) {
    const stopped = await requestSafe(ws, 'session.stop')
    if (!stopped) cleanupFailures.push('active recovery recording did not stop during cleanup')
    activeRecoverySessionId = null
  }
  if (ws) await stopCaptureGraphBestEffort(ws)
  if (smoke) await smokeRequestSafe('preview-window-close')
  if (motionStimulusFocusTimer) {
    clearInterval(motionStimulusFocusTimer)
    motionStimulusFocusTimer = null
  }
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
  ws?.removeEventListener('message', handleBackendEvent)
  ws?.close()
  if (packagedAppExecutable && smoke) {
    await smokeRequestSafe('app-quit')
  }
  try {
    processTeardownEvidence.app = (await stopApp()) ?? null
  } catch (error) {
    cleanupFailures.push(`app process teardown failed: ${error?.message ?? String(error)}`)
  }
  let terminalArtifacts = checkpoint.artifacts
  try {
    terminalArtifacts = {
      csv: await captureArtifactDescriptor(reportPath),
      checkpoint: { path: checkpointPath },
      recording: injectedRecoveryEvidence?.recording?.artifact ?? null
    }
  } catch (error) {
    cleanupFailures.push(
      `capture evidence artifact hashing failed: ${error?.message ?? String(error)}`
    )
  }
  failures.push(...cleanupFailures)
  if (interruptedSignal) {
    terminalStatus = 'interrupted'
    exitCode = signalExitCode(interruptedSignal)
  } else if (cleanupFailures.length > 0) {
    terminalStatus = 'failed'
    exitCode = 1
  }
  writeTerminalCheckpoint(terminalStatus, {
    ...terminalFields,
    interruptedSignal,
    finishedAt: new Date().toISOString(),
    artifacts: terminalArtifacts,
    processTeardownEvidence,
    cleanupFailures
  })
  if (terminalStatus === 'interrupted') {
    console.error(
      `[capture-soak] interrupted by ${interruptedSignal}; preserved ${samples.length} sample(s) at ${reportPath}`
    )
  } else if (terminalStatus === 'failed') {
    console.error(
      `[capture-soak] FAIL: ${degradedSamples} degraded sample(s), ${failures.length} harness failure(s) over ${config.soakMinutes}m — curve at ${reportPath}`
    )
  } else {
    console.log(
      `[capture-soak] PASS: ${samples.length} samples over ${config.soakMinutes}m, no degradation declared and all owned processes exited — curve at ${reportPath}`
    )
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
}

process.exitCode = exitCode

async function runInjectedCaptureRecovery(connection, startup, { appProcessId, backendProcessId }) {
  if (!Number.isSafeInteger(appProcessId) || appProcessId <= 0) {
    throw new Error('Recovery evidence requires the exact launched app process id.')
  }
  if (!Number.isSafeInteger(backendProcessId) || backendProcessId <= 0) {
    throw new Error('Recovery evidence requires the exact backend-ready process id.')
  }
  const outputDirectoryCapability = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs: config.rpcTimeoutMs }
  )
  if (typeof outputDirectoryCapability?.capabilityId !== 'string') {
    throw new Error('Recovery recording output-directory authorization returned no capability.')
  }

  focusScreenMotionStimulus(motionStimulus)
  motionStimulusFocusTimer = setInterval(
    () => focusScreenMotionStimulus(motionStimulus),
    Math.max(250, Number(process.env.VIDEORC_SCREEN_MOTION_FOCUS_INTERVAL_MS ?? 1_000))
  )
  const recordingStartRequestedAtMs = Date.now()
  const startedRaw = await backendRequest(
    connection,
    'session.start',
    captureRecoverySessionParams(startup, outputDirectoryCapability.capabilityId)
  )
  const startedObservedAtMs = Date.now()
  if (startedRaw?.state !== 'recording' || typeof startedRaw?.sessionId !== 'string') {
    throw new Error(
      `Dual recovery recording did not enter recording (${startedRaw?.sessionId ?? 'no session'}/${startedRaw?.state ?? 'missing state'}).`
    )
  }
  const sessionId = startedRaw.sessionId
  const identity = { sessionId, appProcessId, backendProcessId }
  activeRecoverySessionId = sessionId
  lastRecoveryRecordingEvidenceAtMs = startedObservedAtMs
  const recording = {
    identity: { ...identity },
    started: {
      sessionId,
      state: 'recording',
      observedAt: new Date(startedObservedAtMs).toISOString()
    },
    observations: []
  }

  recording.observations.push(
    await observeRecoveryRecordingBoundary(connection, identity, 'camera', 'before')
  )
  const camera = await runInjectedSourceRecovery(connection, startup, identity, 'camera')
  recording.observations.push(
    await observeRecoveryRecordingBoundary(connection, identity, 'camera', 'after')
  )
  await interruptibleSleep(1)
  recording.observations.push(
    await observeRecoveryRecordingBoundary(connection, identity, 'screen', 'before')
  )
  const screen = await runInjectedSourceRecovery(connection, startup, identity, 'screen')
  recording.observations.push(
    await observeRecoveryRecordingBoundary(connection, identity, 'screen', 'after')
  )

  const remainingRecordingMs = recordingStartRequestedAtMs + config.recoveryRecordingMs - Date.now()
  if (remainingRecordingMs > 0) await interruptibleSleep(remainingRecordingMs)
  await assertRecoveryRecordingSession(connection, sessionId)
  if (interruptedSignal) {
    throw new Error(`dual capture recovery recording interrupted by ${interruptedSignal}`)
  }

  const stopRequestedAt = Date.now()
  const stoppedRaw = await request(
    connection,
    Math.max(config.rpcTimeoutMs, 60_000),
    'session.stop'
  )
  const stoppedObservedAtMs = await nextRecoveryRecordingEvidenceTime()
  if (stoppedRaw?.sessionId !== sessionId || stoppedRaw?.state !== 'idle') {
    throw new Error(
      `Explicit stop did not confirm idle for the same session (${stoppedRaw?.sessionId ?? 'no session'}/${stoppedRaw?.state ?? 'missing state'}; expected ${sessionId}/idle).`
    )
  }
  activeRecoverySessionId = null
  const outputPath = await resolveFinalRecordingPath({
    started: startedRaw,
    stopped: stoppedRaw,
    recordingStatusEvents,
    healthEvents,
    stopRequestedAt,
    timeoutMs: 60_000
  })
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(`Dual recovery recording did not finalize: ${outputPath ?? 'missing path'}`)
  }
  if (!/\.mp4$/i.test(outputPath)) {
    throw new Error(`Dual recovery recording remained non-MP4 after finalization: ${outputPath}`)
  }

  const analyzerReport = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
    intendedFps: startup.video.fps,
    expectAudio: true,
    gates: {
      requireMotion: true,
      minUniqueFrameRatio: 0.05,
      maxTailMismatchMs: 150
    }
  })
  const analyzer = captureRecoveryAnalyzerEvidence(analyzerReport)
  const stopped = {
    sessionId,
    state: 'stopped',
    backendState: stoppedRaw.state,
    observedAt: new Date(stoppedObservedAtMs).toISOString()
  }
  const artifact = await captureArtifactDescriptor(outputPath)
  Object.assign(recording, {
    stopped,
    normalStop: true,
    requestedDurationMs: config.recoveryRecordingMs,
    observedDurationMs: stoppedObservedAtMs - startedObservedAtMs,
    outputPath,
    artifact,
    artifactBytes: artifact.sizeBytes,
    artifactSha256: artifact.sha256,
    analyzer
  })

  recoveryGateCompletedAtMs = Date.now()
  const evidence = {
    identity: { ...identity },
    sessionId,
    appProcessId,
    backendProcessId,
    sequence: ['camera', 'screen'],
    camera,
    screen,
    recording
  }
  const evaluated = evaluateDualCaptureRecoveryRecordingEvidence(evidence, {
    maximumRecoveryDurationMs: config.maximumRecoveryDurationMs,
    maximumDetectionMs: config.maximumRecoveryDetectionMs
  })
  if (evaluated.failures.length > 0) {
    throw new Error(`Dual capture-recovery recording gate failed: ${evaluated.failures.join('; ')}`)
  }
  evidence.summary = evaluated.summary
  updateCheckpoint({ injectedRecoveryEvidence: evidence, recoveryEvents, recoveryObservations })
  return evidence
}

async function runInjectedSourceRecovery(connection, startup, identity, source) {
  const { sessionId } = identity
  const observationStart = recoveryObservations.length
  const method =
    source === 'camera'
      ? 'test.captureRecovery.injectCameraDeliveryDegradation'
      : 'test.captureRecovery.injectScreenDeliveryDegradation'
  let acknowledgement
  try {
    acknowledgement = await backendRequest(connection, method)
  } catch (error) {
    throw new Error(
      `${source} capture-recovery injection RPC failed. It requires a debug backend with smoke RPC enabled: ${error?.message ?? String(error)}`
    )
  }
  const acknowledgementFailures = captureRecoveryArmFailures(acknowledgement)
  if (acknowledgementFailures.length > 0) {
    throw new Error(
      `${source} capture-recovery injection acknowledgement was invalid: ${acknowledgementFailures.join('; ')}`
    )
  }
  const armedAtMs = Date.now()
  const deadline =
    armedAtMs + config.maximumRecoveryDetectionMs + config.maximumRecoveryDurationMs + 8_000
  let sawRecovered = false
  let terminalStatus = null
  while (Date.now() < deadline && !interruptedSignal) {
    const [status] = await Promise.all([
      backendRequest(connection, 'capture.recovery.status'),
      assertRecoveryRecordingSession(connection, sessionId)
    ])
    recordRecoveryObservation(status, 'recovery-poll')
    terminalStatus = status
    if (status?.phase === 'failed') {
      throw new Error(
        `Injected ${source} capture recovery failed: ${status.lastError ?? status.message ?? 'unknown failure'}`
      )
    }
    if (status?.phase === 'recovered') sawRecovered = true
    if (sawRecovered && status?.phase === 'idle') break
    await interruptibleSleep(100)
  }
  if (interruptedSignal) {
    throw new Error(`injected ${source} capture recovery interrupted by ${interruptedSignal}`)
  }
  if (!sawRecovered || terminalStatus?.phase !== 'idle') {
    throw new Error(
      `Injected ${source} capture recovery did not traverse recovered and return to idle before its bounded deadline (last phase ${terminalStatus?.phase ?? 'missing'}).`
    )
  }

  const observations = recoveryObservations.slice(observationStart)
  const evaluated = evaluateCaptureRecoveryEvidence({
    observations,
    maximumRecoveryDurationMs: config.maximumRecoveryDurationMs,
    expectedRecovery: true,
    expectedRecoveryStage: `${source}-delivery`,
    expectedRecoverySource: source,
    faultArmedAtMs: armedAtMs,
    armedSourceGeneration: acknowledgement.sourceGeneration,
    maximumDetectionMs: config.maximumRecoveryDetectionMs
  })
  if (evaluated.failures.length > 0) {
    throw new Error(
      `Injected ${source} capture-recovery gate failed: ${evaluated.failures.join('; ')}`
    )
  }
  const recoveredGeneration =
    evaluated.summary.recoveredGenerations.length === 1
      ? evaluated.summary.recoveredGenerations[0]
      : null
  const cadenceRestore = await collectRecoveryCadenceRestore(connection, {
    source,
    sourceGeneration: recoveredGeneration,
    sources: startup.sources,
    sessionId
  })
  const completedAtMs = Date.now()
  const summary = {
    ...evaluated.summary,
    detectionMs: evaluated.summary.observedDetectionMs,
    recoveryMs: evaluated.summary.observedRecoveryMs,
    oldGeneration: evaluated.summary.preRestartGeneration,
    newGeneration: recoveredGeneration,
    cadenceRestore
  }
  const evidence = {
    identity: { ...identity },
    armedAtMs,
    armedAt: new Date(armedAtMs).toISOString(),
    completedAtMs,
    completedAt: new Date(completedAtMs).toISOString(),
    acknowledgement,
    terminalStatus,
    observations,
    summary
  }
  updateCheckpoint({
    injectedRecoveryProgress: { source, evidence },
    recoveryEvents,
    recoveryObservations
  })
  return evidence
}

async function collectRecoveryCadenceRestore(
  connection,
  { source, sourceGeneration, sources, sessionId }
) {
  const minimumRateFraction = 0.9
  const requiredConsecutiveSamples = 3
  const cadenceMethod =
    source === 'camera'
      ? 'test.captureRecovery.cameraCadenceEvidence'
      : 'test.captureRecovery.screenCadenceEvidence'
  let previousEvidence = await backendRequest(connection, cadenceMethod)
  let previousAtMs = Date.now()
  const samples = []
  for (let index = 0; index < requiredConsecutiveSamples; index += 1) {
    await interruptibleSleep(config.sourceReadyPollMs)
    const [currentEvidence, sourceStatus, recoveryStatus] = await Promise.all([
      backendRequest(connection, cadenceMethod),
      backendRequest(connection, `preview.${source}.status`),
      backendRequest(connection, 'capture.recovery.status'),
      assertRecoveryRecordingSession(connection, sessionId)
    ])
    recordRecoveryObservation(recoveryStatus, 'cadence-restore-rpc')
    if (recoveryStatus?.phase !== 'idle') {
      throw new Error(`${source} recovery left idle during cadence restoration.`)
    }
    const expectedSourceId = source === 'camera' ? sources.camera.id : sources.screen.id
    const observedSourceId = source === 'camera' ? sourceStatus?.cameraId : sourceStatus?.sourceId
    if (sourceStatus?.state !== 'live' || observedSourceId !== expectedSourceId) {
      throw new Error(
        `${source} cadence restoration sampled ${observedSourceId ?? 'no source'}/${sourceStatus?.state ?? 'no state'}; expected live ${expectedSourceId}.`
      )
    }
    const observedAtMs = Date.now()
    const cadenceWindow = captureRecoveryCadenceSample(previousEvidence, currentEvidence, {
      source,
      expectedGeneration: sourceGeneration,
      previousObservedAtMs: previousAtMs,
      observedAtMs
    })
    if (cadenceWindow.failures.length > 0) {
      throw new Error(
        `${source} recovery cadence did not retain its exact generation: ${cadenceWindow.failures.join('; ')}`
      )
    }
    samples.push(cadenceWindow.sample)
    previousEvidence = currentEvidence
    previousAtMs = observedAtMs
  }
  const cadenceRestore = { minimumRateFraction, requiredConsecutiveSamples, samples }
  const cadenceFailures = captureRecoveryCadenceRestoreFailures(cadenceRestore, {
    expectedGeneration: sourceGeneration
  })
  if (cadenceFailures.length > 0) {
    throw new Error(`${source} recovery cadence did not restore: ${cadenceFailures.join('; ')}`)
  }
  return cadenceRestore
}

async function observeRecoveryRecordingBoundary(connection, identity, source, boundary) {
  const { sessionId } = identity
  await assertRecoveryRecordingSession(connection, sessionId)
  const observedAtMs = await nextRecoveryRecordingEvidenceTime()
  return {
    source,
    boundary,
    sessionId,
    appProcessId: identity.appProcessId,
    backendProcessId: identity.backendProcessId,
    state: 'recording',
    observedAt: new Date(observedAtMs).toISOString()
  }
}

async function nextRecoveryRecordingEvidenceTime() {
  while (
    lastRecoveryRecordingEvidenceAtMs !== null &&
    Date.now() <= lastRecoveryRecordingEvidenceAtMs
  ) {
    await interruptibleSleep(1)
  }
  const observedAtMs = Date.now()
  lastRecoveryRecordingEvidenceAtMs = observedAtMs
  return observedAtMs
}

async function assertRecoveryRecordingSession(connection, sessionId) {
  const status = await backendRequest(connection, 'recording.status')
  if (status?.sessionId !== sessionId || status?.state !== 'recording') {
    throw new Error(
      `Capture recovery did not preserve recording session ${sessionId} (${status?.sessionId ?? 'no session'}/${status?.state ?? 'missing state'}).`
    )
  }
  return status
}

function captureRecoverySessionParams(startup, outputDirectoryCapability) {
  return {
    sources: startup.sourceSelection,
    layout: captureDecayLayout(),
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability,
      video: startup.video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: false,
      microphoneSyncOffsetMs: 0
    }
  }
}

function captureRecoveryAnalyzerEvidence(report) {
  const metrics = report?.metrics ?? {}
  const gates = report?.gates ?? {}
  const motionPass =
    report?.verdict?.pass === true &&
    Number.isFinite(metrics.uniqueFrameRatio) &&
    metrics.uniqueFrameRatio >= gates.minUniqueFrameRatio
  const freezePass =
    report?.verdict?.pass === true &&
    Number.isFinite(metrics.longestCorroboratedFreezeMs) &&
    metrics.longestCorroboratedFreezeMs <= gates.maxFreezeMs &&
    Number.isFinite(metrics.maxRepeatedFrameRun) &&
    metrics.maxRepeatedFrameRun <= gates.maxRepeatedFrameRun
  const audioPass =
    report?.verdict?.pass === true &&
    metrics.hasAudio === true &&
    Number.isFinite(metrics.maxAudioGapMs) &&
    metrics.maxAudioGapMs <= gates.maxAudioGapMs
  const avSyncPass =
    report?.verdict?.pass === true &&
    Number.isFinite(metrics.avSkewMs) &&
    metrics.avSkewMs <= gates.avSyncHardFailMs &&
    Number.isFinite(metrics.tailMismatchMs) &&
    metrics.tailMismatchMs <= gates.maxTailMismatchMs
  return {
    verdict:
      report?.verdict?.pass === true && motionPass && freezePass && audioPass && avSyncPass
        ? 'passed'
        : 'failed',
    artifactDurationSeconds: metrics.durationSeconds ?? null,
    motionPass,
    freezePass,
    audioPass,
    avSyncPass,
    metrics: {
      uniqueFrameRatio: metrics.uniqueFrameRatio ?? null,
      longestCorroboratedFreezeMs: metrics.longestCorroboratedFreezeMs ?? null,
      maxRepeatedFrameRun: metrics.maxRepeatedFrameRun ?? null,
      maxAudioGapMs: metrics.maxAudioGapMs ?? null,
      avSkewMs: metrics.avSkewMs ?? null,
      tailMismatchMs: metrics.tailMismatchMs ?? null
    },
    gates: {
      minUniqueFrameRatio: gates.minUniqueFrameRatio ?? null,
      maxFreezeMs: gates.maxFreezeMs ?? null,
      maxRepeatedFrameRun: gates.maxRepeatedFrameRun ?? null,
      maxAudioGapMs: gates.maxAudioGapMs ?? null,
      avSyncHardFailMs: gates.avSyncHardFailMs ?? null,
      maxTailMismatchMs: gates.maxTailMismatchMs ?? null
    },
    failures: report?.verdict?.failures ?? [],
    warnings: report?.verdict?.warnings ?? []
  }
}

function evaluateRecoveryForRun() {
  if (!config.recoveryGate) {
    return evaluateCaptureRecoveryEvidence({
      observations: recoveryObservations,
      maximumRecoveryDurationMs: config.maximumRecoveryDurationMs
    })
  }
  const subsequent = evaluateCaptureRecoveryEvidence({
    observations: recoveryObservations.filter(
      (observation) => observation.observedAtMs > recoveryGateCompletedAtMs
    ),
    maximumRecoveryDurationMs: config.maximumRecoveryDurationMs
  })
  return {
    failures: [...subsequent.failures],
    summary: {
      mode: 'dual-injected-recovery-recording',
      injected: injectedRecoveryEvidence?.summary ?? null,
      subsequent: subsequent.summary
    }
  }
}

async function prepareRealSources(connection) {
  const listed = await backendRequest(connection, 'devices.list', { ffmpegPath })
  const sources = selectNativeSoakSources(listed?.devices ?? [], {
    cameraOverride: process.env.VIDEORC_SOAK_CAMERA_ID,
    screenOverride: process.env.VIDEORC_SOAK_SCREEN_ID,
    microphoneOverride: process.env.VIDEORC_SOAK_MICROPHONE_ID,
    requireMicrophone: config.recoveryGate
  })
  const sourceSelection = sourceSelectionForPreview(sources)
  const video = config.video
  const params = {
    sources: sourceSelection,
    layout: captureDecayLayout(),
    video,
    ffmpegPath
  }

  console.log(`[capture-soak] real camera: ${sources.camera.name} (${sources.camera.id})`)
  console.log(`[capture-soak] real screen: ${sources.screen.name} (${sources.screen.id})`)
  if (sources.microphone) {
    console.log(
      `[capture-soak] real microphone: ${sources.microphone.name} (${sources.microphone.id})`
    )
  }
  console.log('[capture-soak] launching visible motion stimulus on the selected display')
  motionStimulus = await launchScreenMotionStimulus({
    screenSource: sources.screen,
    outputDirectory,
    ffmpegPath,
    verifyVisible: process.env.VIDEORC_SCREEN_MOTION_VERIFY_VISIBLE === '1'
  })

  const releasedStats = await backendRequest(connection, 'diagnostics.stats')
  const releasedSurfaceBaseline = sourceSurfaceSnapshot(releasedStats)
  const surface = await preparePreviewSurface(connection, 'screen', video.fps)
  const cameraStarted = await backendRequest(connection, 'preview.camera.start', params)
  const screenStarted = await backendRequest(connection, 'preview.screen.start', {
    sources: sourceSelection,
    video,
    protectedOverlayWindowIds: [],
    ffmpegPath
  })
  const sceneRequest = {
    sources: sourceSelection,
    layout: captureDecayLayout(),
    video,
    protectedOverlayWindowIds: []
  }
  const sceneCommitted = await backendRequest(
    connection,
    'scene.load_from_capture_config',
    sceneRequest
  )
  const sceneFailures = sceneCommitFailures({ sceneCommitted, sources, video })
  if (sceneFailures.length > 0) {
    throw new Error(`Renderer-safe scene commit failed validation: ${sceneFailures.join('; ')}`)
  }
  const sceneRevision = sceneCommitted.sceneRevision

  const ready = await waitForRealSourceProgress(connection, {
    before: releasedStats,
    sources,
    sceneRevision
  })
  const sourceCadence = realSourceCadenceBaseline({
    readinessPolls: ready.polls,
    cameraStatus: ready.cameraStatus,
    screenStatus: ready.screenStatus,
    compositorTargetFps: effectiveCompositorTargetFps(ready.stats)
  })
  return {
    sampledAt: ready.sampledAt,
    stats: ready.stats,
    activeSurfaceBaseline: sourceSurfaceSnapshot(ready.stats),
    releasedSurfaceBaseline,
    sources,
    sceneRevision,
    sourceCadence,
    video,
    cameraStatus: ready.cameraStatus,
    screenStatus: ready.screenStatus,
    surfaceStatus: ready.surfaceStatus,
    compositorStatus: ready.compositorStatus,
    recoveryStatus: ready.recoveryStatus,
    sourceSelection,
    evidence: {
      devicesListed: (listed?.devices ?? []).length,
      camera: sources.camera,
      screen: sources.screen,
      cameraStarted,
      screenStarted,
      sceneRequest,
      sceneCommitted,
      sourceCadence,
      previewSurface: surface,
      cameraStatus: ready.cameraStatus,
      screenStatus: ready.screenStatus,
      compositorStatus: ready.compositorStatus,
      recoveryStatus: ready.recoveryStatus,
      previewSurfaceStatus: ready.surfaceStatus,
      consecutiveReadyPolls: ready.consecutiveReadyPolls,
      readinessPolls: ready.polls,
      motionStimulus: {
        driver: motionStimulus.driver,
        x: motionStimulus.x,
        y: motionStimulus.y,
        width: motionStimulus.width,
        height: motionStimulus.height,
        visibility: motionStimulus.visibility ?? null
      },
      initialCounters: captureProgressCounters(releasedStats),
      readyCounters: captureProgressCounters(ready.stats)
    }
  }
}

async function waitForRealSourceProgress(connection, { before, sources, sceneRevision }) {
  const deadline = Date.now() + config.sourceReadyTimeoutMs
  let previous = before
  let consecutiveReadyPolls = 0
  const polls = []
  let last = null
  while (Date.now() < deadline && !interruptedSignal) {
    await interruptibleSleep(Math.min(config.sourceReadyPollMs, deadline - Date.now()))
    if (interruptedSignal || Date.now() >= deadline) break

    const [stats, cameraStatus, screenStatus, surfaceStatus, compositorStatus, recoveryStatus] =
      await Promise.all([
        backendRequest(connection, 'diagnostics.stats'),
        backendRequest(connection, 'preview.camera.status'),
        backendRequest(connection, 'preview.screen.status'),
        backendRequest(connection, 'preview.surface.status'),
        backendRequest(connection, 'compositor.status'),
        backendRequest(connection, 'capture.recovery.status')
      ])
    recordRecoveryObservation(recoveryStatus, 'readiness-rpc')
    const sourceFailures = realSourceProgressFailures({
      before: previous,
      after: stats,
      cameraStatus,
      screenStatus,
      compositorStatus,
      sceneRevision,
      sources
    })
    const cadenceFailures = renderCadenceFailures(stats)
    const previewFailures = nativePreviewFailures({
      stats,
      surfaceStatus,
      compositorStatus,
      recoveryStatus,
      requireNative: true
    })
    const pollFailures = [...sourceFailures, ...cadenceFailures, ...previewFailures]
    consecutiveReadyPolls = pollFailures.length === 0 ? consecutiveReadyPolls + 1 : 0
    const sampledAt = Date.now()
    polls.push({
      sampledAt: new Date(sampledAt).toISOString(),
      consecutiveReadyPolls,
      failures: pollFailures,
      cameraStatus,
      screenStatus,
      surfaceStatus,
      diagnostics: {
        previewTransport: stats.previewTransport ?? null,
        previewSurfaceBacking: stats.previewSurfaceBacking ?? null,
        previewFrameAgeMs: stats.previewFrameAgeMs ?? null,
        previewInputToPresentLatencyP95Ms: stats.previewInputToPresentLatencyP95Ms ?? null,
        compositorSceneRevision: compositorStatus.sceneRevision ?? null,
        compositorFrameSceneRevision: compositorStatus.frameSceneRevision ?? null,
        counters: captureProgressCounters(stats)
      }
    })
    last = {
      stats,
      cameraStatus,
      screenStatus,
      surfaceStatus,
      compositorStatus,
      recoveryStatus,
      failures: pollFailures,
      consecutiveReadyPolls,
      polls,
      sampledAt
    }
    previous = stats
    if (consecutiveReadyPolls >= config.sourceReadyConsecutivePolls) return last
  }
  if (interruptedSignal)
    throw new Error(`real-source preflight interrupted by ${interruptedSignal}`)
  throw new Error(
    `Real native source preflight did not produce ${config.sourceReadyConsecutivePolls} consecutive ${config.sourceReadyPollMs}ms polls proving live IDs, advancing callbacks/publications, native-surface/CAMetalLayer identity, finite latency, surface counters, and compositor cadence: ${last?.failures.join('; ') ?? 'no status received'}`
  )
}

async function prepareSyntheticOnly(connection) {
  await requestSafe(connection, 'preview.live.stop')
  await requestSafe(connection, 'preview.camera.stop')
  await requestSafe(connection, 'preview.screen.stop')
  const video = config.video
  const before = await backendRequest(connection, 'diagnostics.stats')
  const releasedSurfaceBaseline = sourceSurfaceSnapshot(before)
  const surface = await preparePreviewSurface(connection, 'synthetic', video.fps)
  const deadline = Date.now() + config.sourceReadyTimeoutMs
  let last = null
  while (Date.now() < deadline && !interruptedSignal) {
    await interruptibleSleep(Math.min(500, config.sourceReadyTimeoutMs))
    const [stats, cameraStatus, screenStatus, surfaceStatus, compositorStatus, recoveryStatus] =
      await Promise.all([
        backendRequest(connection, 'diagnostics.stats'),
        backendRequest(connection, 'preview.camera.status'),
        backendRequest(connection, 'preview.screen.status'),
        backendRequest(connection, 'preview.surface.status'),
        backendRequest(connection, 'compositor.status'),
        backendRequest(connection, 'capture.recovery.status')
      ])
    recordRecoveryObservation(recoveryStatus, 'readiness-rpc')
    const isolationFailures = syntheticIsolationFailures({
      before,
      after: stats,
      cameraStatus,
      screenStatus
    })
    const surfaceFailures =
      surfaceStatus?.state === 'live'
        ? nativePreviewFailures({ stats, surfaceStatus, requireNative: false })
        : [
            `synthetic preview surface state is ${surfaceStatus?.state ?? 'unavailable'}, expected live`
          ]
    const preflightFailures = [...isolationFailures, ...surfaceFailures]
    last = {
      stats,
      cameraStatus,
      screenStatus,
      surfaceStatus,
      compositorStatus,
      recoveryStatus,
      failures: preflightFailures
    }
    if (preflightFailures.length === 0) {
      return {
        sampledAt: Date.now(),
        stats,
        activeSurfaceBaseline: sourceSurfaceSnapshot(stats),
        releasedSurfaceBaseline,
        sources: null,
        sceneRevision: compositorStatus.sceneRevision ?? null,
        video,
        cameraStatus,
        screenStatus,
        surfaceStatus,
        compositorStatus,
        recoveryStatus,
        sourceSelection: {
          screenId: null,
          windowId: null,
          cameraId: null,
          microphoneId: null,
          testPattern: true
        },
        evidence: {
          cameraStatus,
          screenStatus,
          compositorStatus,
          recoveryStatus,
          previewSurfaceStatus: surfaceStatus,
          previewSurface: surface,
          initialCounters: captureProgressCounters(before),
          readyCounters: captureProgressCounters(stats),
          renderFps: stats.renderFps ?? null,
          targetFps: effectiveCompositorTargetFps(stats)
        }
      }
    }
  }
  if (interruptedSignal) throw new Error(`synthetic preflight interrupted by ${interruptedSignal}`)
  throw new Error(
    `Synthetic-only preflight did not isolate real sources and prove compositor cadence: ${last?.failures.join('; ') ?? 'no status received'}`
  )
}

async function stopCaptureGraphAndVerifySurfaceRelease(connection, releasedSurfaceBaseline) {
  const startedAt = Date.now()
  const commandResults = {}
  const cleanupFailures = []
  for (const method of [
    'preview.camera.stop',
    'preview.screen.stop',
    'preview.live.stop',
    'preview.surface.destroy'
  ]) {
    try {
      commandResults[method] = await backendRequest(connection, method)
    } catch (error) {
      const message = error?.message ?? String(error)
      commandResults[method] = { error: message }
      cleanupFailures.push(`${method} failed during surface-release teardown: ${message}`)
    }
  }
  try {
    commandResults.nativeHostDrain = await requestSmokeCommand(
      smoke,
      'drain-native-preview-host-commands',
      {},
      { timeoutMs: config.rpcTimeoutMs }
    )
  } catch (error) {
    const message = error?.message ?? String(error)
    commandResults.nativeHostDrain = { error: message }
    cleanupFailures.push(`native preview host destroy drain failed: ${message}`)
  }

  const deadline = Date.now() + config.surfaceReleaseTimeoutMs
  const polls = []
  let lastStats = null
  let lastSurfaceStatus = null
  let returnFailures = ['surface-release diagnostics were not sampled']
  while (Date.now() < deadline && !interruptedSignal) {
    try {
      ;[lastStats, lastSurfaceStatus] = await Promise.all([
        backendRequest(connection, 'diagnostics.stats'),
        backendRequest(connection, 'preview.surface.status')
      ])
      returnFailures = [
        ...surfaceReturnFailures(lastStats, releasedSurfaceBaseline),
        ...retentionTeardownFailures(lastStats, lastSurfaceStatus)
      ]
      polls.push({
        sampledAt: new Date().toISOString(),
        surfaces: sourceSurfaceSnapshot(lastStats),
        retention: nativeRetentionSnapshot(lastStats, lastSurfaceStatus),
        failures: returnFailures
      })
      if (returnFailures.length === 0) break
    } catch (error) {
      returnFailures = [
        `surface-release diagnostics request failed: ${error?.message ?? String(error)}`
      ]
    }
    await interruptibleSleep(Math.min(250, Math.max(0, deadline - Date.now())))
  }

  if (returnFailures.length > 0) cleanupFailures.push(...returnFailures)
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    releasedSurfaceBaseline,
    commandResults,
    polls,
    finalSurfaceState: sourceSurfaceSnapshot(lastStats),
    finalRetentionState: nativeRetentionSnapshot(lastStats, lastSurfaceStatus),
    failures: cleanupFailures
  }
}

async function stopCaptureGraphBestEffort(connection) {
  await requestSafe(connection, 'preview.camera.stop')
  await requestSafe(connection, 'preview.screen.stop')
  await requestSafe(connection, 'preview.live.stop')
  await requestSafe(connection, 'preview.surface.destroy')
  await smokeRequestSafe('drain-native-preview-host-commands')
}

async function requestSafe(connection, method) {
  try {
    return await backendRequest(connection, method)
  } catch {
    return null
  }
}

async function preparePreviewSurface(connection, source, targetFps) {
  const opened = await requestSmokeCommand(
    smoke,
    'preview-window-open',
    {},
    {
      timeoutMs: config.rpcTimeoutMs
    }
  )
  const created = await backendRequest(connection, 'preview.surface.create', {
    bounds: {
      screenX: 80,
      screenY: 80,
      width: 1280,
      height: 720,
      scaleFactor: 1,
      screenHeight: 900,
      visible: true
    },
    targetFps,
    source
  })
  const host = await requestSmokeCommand(
    smoke,
    'drain-native-preview-host-commands',
    {},
    {
      timeoutMs: config.rpcTimeoutMs
    }
  )
  return { opened, created, host }
}

async function smokeRequestSafe(command) {
  try {
    return await requestSmokeCommand(
      smoke,
      command,
      {},
      {
        timeoutMs: config.rpcTimeoutMs
      }
    )
  } catch {
    return null
  }
}

function captureProgressCounters(stats) {
  return {
    cameraCaptureCallbacks: stats?.previewCameraCaptureCallbackCount ?? null,
    cameraDidDropCallbacks: stats?.previewCameraDidDropCallbackCount ?? null,
    cameraOutOfBuffers: stats?.previewCameraDropReasons?.outOfBuffers ?? null,
    cameraPublications: stats?.previewCameraFrameStorePublications ?? null,
    screenCaptureCallbacks: stats?.previewScreenCaptureCallbackCount ?? null,
    screenPublications: stats?.previewScreenFrameStorePublications ?? null,
    cameraSurfaceLiveCount: stats?.previewCameraSurfaceBacking?.liveCount ?? null,
    cameraSurfacePeakCount: stats?.previewCameraSurfaceBacking?.peakCount ?? null,
    screenSurfaceLiveCount: stats?.previewScreenSurfaceBacking?.liveCount ?? null,
    screenSurfacePeakCount: stats?.previewScreenSurfaceBacking?.peakCount ?? null
  }
}

function requestInterruption(signal) {
  if (terminalCheckpointWritten) return
  if (!interruptedSignal) {
    interruptedSignal = signal
    updateCheckpoint({ status: 'interrupt-requested', interruptedSignal })
  }
  wakeSleep?.()
  // Closing the owned socket rejects any outstanding backend request instead
  // of waiting for its timeout before the signal can finish teardown.
  ws?.close()
}

function handleBackendEvent(event) {
  try {
    const message = JSON.parse(event.data)
    if (message?.event === 'capture.recovery.status') {
      recordRecoveryObservation(message.payload, 'event')
    } else if (message?.event === 'recording.status') {
      recordingStatusEvents.push({ ...message.payload, receivedAt: Date.now() })
    } else if (message?.event === 'health.event') {
      healthEvents.push({ ...message.payload, receivedAt: Date.now() })
    } else if (message?.event === 'events.lagged') {
      const lagged = {
        observedAt: new Date().toISOString(),
        skipped: message?.payload?.skipped ?? null,
        occurredAt: message?.payload?.occurredAt ?? null
      }
      laggedEvents.push(lagged)
      if (!failures.some((failure) => failure.startsWith('backend event stream lagged'))) {
        failures.push(
          `backend event stream lagged (skipped ${lagged.skipped ?? 'unknown'} event(s)); recovery ordering evidence is incomplete`
        )
      }
      updateCheckpoint({ laggedEvents })
      ws?.close()
    }
  } catch {
    // Ignore non-JSON socket noise; RPC samples still persist recovery status.
  }
}

async function backendRequest(connection, method, params) {
  if (interruptedSignal) {
    throw new Error(`${method} interrupted by ${interruptedSignal}`)
  }
  if (laggedEvents.length > 0) {
    throw new Error(`${method} refused because the backend event stream lagged`)
  }
  return request(connection, config.rpcTimeoutMs, method, params)
}

function recordRecoveryObservation(status, origin, observedAtMs = Date.now()) {
  const observation = captureRecoveryObservation(status, observedAtMs, origin)
  recoveryObservations.push(observation)
  if (origin === 'event') {
    recoveryEvents.push(observation)
    updateCheckpoint({ recoveryEvents, recoveryObservations })
  }
  return observation
}

function writeTerminalCheckpoint(status, fields) {
  updateCheckpoint({ ...fields, status })
  terminalCheckpointWritten = true
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

function updateCheckpoint(fields) {
  checkpoint = {
    ...checkpoint,
    ...fields,
    updatedAt: new Date().toISOString(),
    samplesCollected: samples.length,
    failures
  }
  writeCheckpoint()
}

function writeCheckpoint() {
  writeFileSync(checkpointTemporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
  renameSync(checkpointTemporaryPath, checkpointPath)
}

function formatRate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}fps` : 'n/a'
}

function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'n/a'
}

async function captureArtifactDescriptor(path) {
  const artifactStat = statSync(path)
  if (!artifactStat.isFile() || artifactStat.size <= 0) {
    throw new Error(`Capture evidence artifact is missing or empty: ${path}`)
  }
  return {
    path,
    sha256: await sha256File(path),
    sizeBytes: artifactStat.size
  }
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return 1
}
