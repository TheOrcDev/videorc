// Recording resolution × fps matrix smoke (recording-quality plan Q5).
//
// Records every shipping-relevant recording profile through the REAL dev app
// and backend (testPattern source), then holds each artifact to the strict
// analyzer gates PLUS the quality-law gates the 2026-07 audit added:
//
//   - colorimetry tagged BT.709 video-range (requireColorTags)
//   - spec-valid H.264 level for the real macroblock rate (requireValidLevel)
//   - 2s keyframe cadence (keyframeMaxIntervalSeconds)
//   - bounded A/V stop tail (maxTailMismatchMs)
//   - exact requested dimensions and fps
//
// The 640×360 layout smoke cannot see any of these regressions — this matrix
// is the gate that would have caught the 60fps second-class pipeline, the
// under-spec level tags, and the untagged color that shipped before it.
//
// Usage: pnpm smoke:recording-matrix
//   VIDEORC_MATRIX_ONLY=1080p60,4K30   run a subset by label
//   VIDEORC_MATRIX_RECORDING_MS=6000   per-combo capture length
//   VIDEORC_SMOKE_OUTPUT_DIR=...       artifact + report directory

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  countTransientFifoPauseMarkers,
  evaluateSharedRecordStreamPressure,
  evaluateTransientFifoPressure,
  missingRecordingMatrixResultFailures
} from './lib/transient-fifo-pressure-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-recording-matrix-${Date.now()}`)
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-recording-matrix-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const recordingMs = Number(process.env.VIDEORC_MATRIX_RECORDING_MS ?? 6000)
const sharedStreamPort = Number(process.env.VIDEORC_MATRIX_SHARED_RTMP_PORT ?? 19619)
const sharedStreamTarget = {
  port: sharedStreamPort,
  streamKey: 'matrix-shared-pressure',
  serverUrl: `rtmp://127.0.0.1:${sharedStreamPort}/live`,
  listenUrl: `rtmp://127.0.0.1:${sharedStreamPort}/live/matrix-shared-pressure`,
  recvPath: join(outputDirectory, 'shared-transient-fifo-stream.flv')
}

mkdirSync(outputDirectory, { recursive: true })

// Every shipping recording profile plus the 60fps combos the encoder bridge
// now serves. 4K60 must use its experimental preset at the EXACT pinned
// values (validate_video_profile_policy rejects any deviation).
const MATRIX = [
  { label: '1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
  { label: '1080p60', width: 1920, height: 1080, fps: 60, bitrateKbps: 12000 },
  { label: '1440p30', width: 2560, height: 1440, fps: 30, bitrateKbps: 8000 },
  { label: '1440p60', width: 2560, height: 1440, fps: 60, bitrateKbps: 16000 },
  { label: '4K30', width: 3840, height: 2160, fps: 30, bitrateKbps: 30000 },
  {
    label: '4K60',
    width: 3840,
    height: 2160,
    fps: 60,
    bitrateKbps: 50000,
    preset: 'record-4k60-experimental'
  },
  { label: 'vertical-1080p30', width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 },
  { label: 'vertical-1440p30', width: 1440, height: 2560, fps: 30, bitrateKbps: 8000 },
  { label: 'vertical-4K30', width: 2160, height: 3840, fps: 30, bitrateKbps: 30000 },
  { label: 'floor-360p24', width: 640, height: 360, fps: 24, bitrateKbps: 2000 }
].filter(
  (combo) =>
    !process.env.VIDEORC_MATRIX_ONLY ||
    process.env.VIDEORC_MATRIX_ONLY.split(',').includes(combo.label)
)

const HARD_COMBOS = MATRIX.filter((combo) => ['4K30', '1080p60'].includes(combo.label)).map(
  (combo) => (combo.label === '4K30' ? { ...combo, stress: true } : combo)
)
const TRANSIENT_FIFO_COMBO = MATRIX.find((combo) => combo.label === '4K30')
const SHARED_TRANSIENT_FIFO_COMBO = MATRIX.find((combo) => combo.label === '1080p30')
const EXPECTED_RESULT_LABELS = [
  ...MATRIX.map((combo) => combo.label),
  ...HARD_COMBOS.map((combo) => `${combo.label}:hard`),
  ...(process.platform === 'darwin' && TRANSIENT_FIFO_COMBO
    ? [`${TRANSIENT_FIFO_COMBO.label}:transient-fifo-pressure`]
    : []),
  ...(process.platform === 'darwin' && SHARED_TRANSIENT_FIFO_COMBO
    ? [`${SHARED_TRANSIENT_FIFO_COMBO.label}:shared-transient-fifo-pressure`]
    : [])
]

// The strict quality-law gates. requireMotion stays off: the test pattern is
// deliberately reused from the layout smoke and can be near-static.
const MATRIX_GATES = Object.freeze({
  requireMotion: false,
  requireColorTags: true,
  requireValidLevel: true,
  keyframeMaxIntervalSeconds: 2.5,
  maxTailMismatchMs: 100
})

function sessionParams({ outputDirectoryCapability, combo, streamTarget = null }) {
  return {
    sources: { testPattern: true },
    layout: {
      layoutPreset: combo.width >= combo.height ? 'screen-camera' : 'vertical-camera-top',
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
      streamEnabled: Boolean(streamTarget),
      ...(outputDirectoryCapability ? { outputDirectoryCapability } : {}),
      video: {
        preset: combo.preset ?? 'custom',
        width: combo.width,
        height: combo.height,
        fps: combo.fps,
        bitrateKbps: combo.bitrateKbps
      },
      rtmp: {
        preset: 'custom',
        serverUrl: streamTarget?.serverUrl ?? '',
        streamKey: streamTarget?.streamKey ?? ''
      }
    }
  }
}

// Stress combos (full-canvas incompressible noise at 4K) make the encoder
// deliberately encoder-bound: the contract is SURVIVAL (no mid-recording
// death), preview liveness, colorimetry, and level — not frame cadence. A
// slideshow under impossible content is the designed degradation; dying is
// the 0.9.44 bug.
const STRESS_GATES = Object.freeze({
  ...MATRIX_GATES,
  frameCountTolerance: Number.POSITIVE_INFINITY,
  cadenceMismatchTolerancePct: Number.POSITIVE_INFINITY,
  maxDurationStretchRatio: Number.POSITIVE_INFINITY,
  keyframeMaxIntervalSeconds: null,
  maxTailMismatchMs: null
})

// The deterministic FIFO pause intentionally sheds frames before encoding and
// preserves their timestamps as visible gaps. Keep every other artifact law,
// then let the incident-specific gate below prove that the frame-count delta
// is exactly accounted for by bounded pre-encode skips (never lost H.264 AUs).
const TRANSIENT_FIFO_GATES = Object.freeze({
  ...MATRIX_GATES,
  frameCountTolerance: Number.POSITIVE_INFINITY,
  cadenceMismatchTolerancePct: Number.POSITIVE_INFINITY
})

async function recordCombo({
  ws,
  smoke,
  combo,
  streamTarget = null,
  assertPreviewLiveness = false,
  stress = false,
  requireTransientFifoPressure = false,
  getTransientFifoPauseFiredCount = () => 0
}) {
  // The output-directory capability is single-use: one grant per session.start.
  const { capabilityId } = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )
  const transientFifoPauseFiredBefore = getTransientFifoPauseFiredCount()
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams({ outputDirectoryCapability: capabilityId, combo, streamTarget })
  )
  if (started.state !== 'recording') {
    throw new Error(`session.start state ${started.state}: ${started.message ?? ''}`)
  }
  let livenessFailure = null
  if (assertPreviewLiveness) {
    // The 0.9.44 regression starved the compositor mid-recording (encoder
    // held the whole target ring): the preview froze while the session ran.
    // Prove the compositor keeps rendering DURING the recording.
    const sampleGapMs = Math.min(2000, Math.max(1000, recordingMs / 3))
    await new Promise((resolveSleep) => setTimeout(resolveSleep, sampleGapMs))
    const first = await request(ws, timeoutMs, 'compositor.status')
    await new Promise((resolveSleep) => setTimeout(resolveSleep, sampleGapMs))
    const second = await request(ws, timeoutMs, 'compositor.status')
    const advanced = (second.framesRendered ?? 0) - (first.framesRendered ?? 0)
    const expected = (combo.fps * sampleGapMs) / 1000
    if (!(advanced >= expected * 0.25)) {
      livenessFailure =
        `compositor stalled during recording: ${advanced} frames rendered in ` +
        `${sampleGapMs}ms (expected ≈${expected.toFixed(0)})`
    }
    await new Promise((resolveSleep) =>
      setTimeout(resolveSleep, Math.max(0, recordingMs - 2 * sampleGapMs))
    )
  } else {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, recordingMs))
  }
  const activeStatus = await request(ws, timeoutMs, 'recording.status')
  const streamTargetsSnapshot = streamTarget
    ? await request(ws, timeoutMs, 'stream.targets.snapshot')
    : null
  const diagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
  const bridgeDiagnostics = Object.fromEntries(
    [
      'encodeBackend',
      'encoderBridgeInputFps',
      'encoderBridgeQueueDepth',
      'encoderBridgeOutputQueueOldestFrameAgeMs',
      'encoderBridgeOutputQueueCapacityPressureEvents',
      'encoderBridgeOutputQueueHighWaterFrames',
      'encoderBridgeOutputQueueOldestFrameAgeHighWaterMs',
      'encoderBridgeOutputLastProgressAgeMs',
      'encoderBridgeOutputPressureRecoveryEvents',
      'encoderBridgeOutputPreEncodeSkippedFrames',
      'encoderBridgeVideoToolboxPendingEncodeFrames',
      'encoderBridgeVideoToolboxPendingFifoFrames',
      'encoderBridgeEncodedAccessUnitDroppedFrames',
      'encoderBridgeOutputQueueDroppedFrames',
      'encoderBridgeDroppedFrames',
      'encoderBridgeRepeatedFrames',
      'encoderBridgeEncodedOutputFrames',
      'encoderBridgeEncodedOutputBytes',
      'encoderBridgeEncodedOutputErrors',
      'encoderBridgeActiveEncodedOutputEncoders',
      'encoderBridgeSeparateOutputEncodersActive',
      'encoderBridgeEffectiveVideoOutput',
      'encoderBridgeRecordingEncodedOutputFrames',
      'encoderBridgeRecordingEncodedOutputBytes',
      'encoderBridgeStreamEncodedOutputFrames',
      'encoderBridgeStreamEncodedOutputBytes',
      'streamOutputTotalBytes',
      'encoderBridgeEncodedSubmitP95Ms',
      'encoderBridgeEncodedFifoWriteP95Ms',
      'encoderBridgeCompositorWaitP95Ms',
      'encoderBridgeWriterLoopP95Ms',
      'encoderBridgeWriterActiveP95Ms',
      'encoderBridgeDeadlineLagP95Ms',
      'encoderBridgeDeadlineLagMaxMs',
      'encoderBridgeError'
    ]
      .filter((key) => diagnostics[key] !== undefined)
      .map((key) => [key, diagnostics[key]])
  )
  const transientFifoPauseFiredCount =
    getTransientFifoPauseFiredCount() - transientFifoPauseFiredBefore
  if (requireTransientFifoPressure) {
    bridgeDiagnostics.transientFifoTestPauseFiredCount = transientFifoPauseFiredCount
  }
  if (
    process.env.VIDEORC_MATRIX_PRINT_BRIDGE_DIAGNOSTICS === '1' ||
    process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1'
  ) {
    console.log(`[matrix:${combo.label}] bridge diagnostics ${JSON.stringify(bridgeDiagnostics)}`)
  }
  const stopped = await request(ws, timeoutMs, 'session.stop')
  let transientFifoCleanFfmpegExitCount = 0
  let lifecycleEntries = []
  if (requireTransientFifoPressure) {
    const sessionId = stopped.sessionId ?? started.sessionId
    if (!sessionId) {
      throw new Error('transient FIFO pressure session returned no session ID for exit evidence')
    }
    const healthEvents = await request(ws, timeoutMs, 'sessions.healthEvents.list', {
      sessionId,
      limit: 120
    })
    transientFifoCleanFfmpegExitCount = (healthEvents.events ?? []).filter(
      (event) => event.code === 'transient-fifo-ffmpeg-exit-zero'
    ).length
    bridgeDiagnostics.transientFifoCleanFfmpegExitCount = transientFifoCleanFfmpegExitCount
    const lifecycleLogs = await waitForEncoderBridgeLifecycleLogs(ws, sessionId)
    lifecycleEntries = lifecycleLogs.entries ?? []
  }
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error('recording produced no output file')
  }

  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: combo.fps,
    expectAudio: true,
    gates: stress
      ? STRESS_GATES
      : requireTransientFifoPressure
        ? TRANSIENT_FIFO_GATES
        : MATRIX_GATES
  })
  writeReports(quality)

  const failures = [...quality.verdict.failures]
  if (livenessFailure) {
    failures.push(livenessFailure)
  }
  if (requireTransientFifoPressure) {
    failures.push(
      ...evaluateTransientFifoPressure({
        activeStatus,
        stoppedStatus: stopped,
        diagnostics,
        qualityMetrics: quality.metrics,
        testPauseFiredCount: transientFifoPauseFiredCount,
        cleanFfmpegExitCount: transientFifoCleanFfmpegExitCount
      })
    )
  }
  const { width, height } = quality.metrics
  if (width !== combo.width || height !== combo.height) {
    failures.push(`dimensions ${width}x${height} != requested ${combo.width}x${combo.height}`)
  }
  const observedFps = quality.metrics.observedFps
  if (
    !stress &&
    !requireTransientFifoPressure &&
    observedFps != null &&
    Math.abs(observedFps - combo.fps) > combo.fps * 0.02
  ) {
    failures.push(`observed fps ${observedFps.toFixed(2)} != requested ${combo.fps}`)
  }
  return {
    combo: combo.label,
    outputPath,
    sizeBytes: statSync(outputPath).size,
    failures,
    warnings: quality.verdict.warnings,
    metrics: quality.metrics,
    bridgeDiagnostics,
    transientFifoPauseFiredCount,
    transientFifoCleanFfmpegExitCount,
    activeStatus,
    stoppedStatus: stopped,
    diagnostics,
    sessionId: stopped.sessionId ?? started.sessionId,
    streamTargetsSnapshot,
    lifecycleEntries
  }
}

async function runPass({
  passLabel,
  combos,
  extraEnv = {},
  assertPreviewLiveness = false,
  requireTransientFifoPressure = false,
  streamTarget = null,
  requireSharedRecordStream = false
}) {
  const passResults = []
  let transientFifoPauseFiredCount = 0
  let stopApp = async () => {}
  let listener = null
  try {
    if (requireSharedRecordStream && (!streamTarget || combos.length !== 1)) {
      throw new Error('shared record+stream pressure pass requires one combo and one RTMP target')
    }
    const launch = await launchDevApp({
      env: {
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_SMOKE_STATE_DIR: outputDirectory,
        VIDEORC_USER_DATA_DIR: userDataDir,
        ...extraEnv
      },
      timeoutMs,
      requiredMarkers: ['backend-ready', 'preview-motion-ready'],
      onLine: (line) => {
        transientFifoPauseFiredCount += countTransientFifoPauseMarkers(line)
        if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1') console.log(line)
      }
    })
    stopApp = launch.stop
    const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
    const smoke = launch.connections['preview-motion-ready']

    if (streamTarget) {
      listener = spawnLocalRtmpListener(streamTarget)
      await sleep(1500)
      if (listener.proc.exitCode !== null) {
        throw new Error(
          `local RTMP listener exited before session start: ${listener.stderr().trim() || `code ${listener.proc.exitCode}`}`
        )
      }
    }

    for (const combo of combos) {
      const label = `${combo.label}${passLabel ? `:${passLabel}` : ''}`
      try {
        const result = await recordCombo({
          ws,
          smoke,
          combo,
          streamTarget,
          assertPreviewLiveness,
          stress: combo.stress ?? false,
          requireTransientFifoPressure,
          getTransientFifoPauseFiredCount: () => transientFifoPauseFiredCount
        })
        if (streamTarget) {
          const listenerExit = await finishLocalRtmpListener(listener)
          listener = null
          const streamEvidence = await analyzeSharedStreamArtifact(
            streamTarget,
            combo,
            listenerExit
          )
          result.streamArtifact = streamEvidence
          result.failures.push(...streamEvidence.failures)
          if (requireSharedRecordStream) {
            result.failures.push(
              ...evaluateSharedRecordStreamPressure({
                diagnostics: result.diagnostics,
                streamTargetsSnapshot: result.streamTargetsSnapshot,
                lifecycleEntries: result.lifecycleEntries,
                sessionId: result.sessionId,
                streamArtifactBytes: streamEvidence.sizeBytes
              })
            )
          }
        }
        result.combo = label
        passResults.push(result)
        const status = result.failures.length === 0 ? 'PASS' : 'FAIL'
        console.log(
          `Recording matrix [${label}] ${status}: ${(result.sizeBytes / 1024).toFixed(0)}KB, ` +
            `level ${result.metrics.level != null ? (result.metrics.level / 10).toFixed(1) : '?'}, ` +
            `color ${result.metrics.colorSpace ?? 'unknown'}/${result.metrics.colorRange ?? 'unknown'}, ` +
            `tail ${result.metrics.tailMismatchMs == null ? 'n/a' : `${result.metrics.tailMismatchMs.toFixed(0)}ms`}`
        )
        for (const failure of result.failures) {
          console.error(`  ❌ ${failure}`)
        }
      } catch (error) {
        passResults.push({ combo: label, failures: [String(error?.message ?? error)] })
        console.error(`Recording matrix [${label}] FAIL: ${String(error?.message ?? error)}`)
        // A start-time refusal leaves no live session; a mid-recording error may.
        try {
          await request(ws, timeoutMs, 'session.stop')
        } catch {
          // No live session to stop — expected for start-time refusals.
        }
      }
    }
  } finally {
    if (listener) {
      await stopLocalRtmpListener(listener.proc)
    }
    await stopApp()
  }
  return passResults
}

async function waitForEncoderBridgeLifecycleLogs(ws, sessionId) {
  const deadline = Date.now() + 5000
  let last = { entries: [] }
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'sessions.logs.list', { sessionId, limit: 120 })
    const lifecycle = (last.entries ?? []).filter(
      (entry) => entry.code === 'encoder-bridge-writer-lifecycle'
    )
    if (lifecycle.some((entry) => entry.message?.includes('resource-released'))) {
      return last
    }
    await sleep(100)
  }
  return last
}

function spawnLocalRtmpListener(target) {
  const stderrChunks = []
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
  proc.stderr.on('data', (chunk) => stderrChunks.push(chunk))
  proc.on('error', (error) => stderrChunks.push(String(error?.message ?? error)))
  return { proc, stderr: () => stderrChunks.join('') }
}

async function finishLocalRtmpListener(listener) {
  const naturalExit = await waitForChildExit(listener.proc, 2500)
  if (naturalExit) {
    return { ...naturalExit, forced: false, stderr: listener.stderr() }
  }
  await stopLocalRtmpListener(listener.proc)
  return {
    code: listener.proc.exitCode,
    signal: listener.proc.signalCode,
    forced: true,
    stderr: listener.stderr()
  }
}

async function stopLocalRtmpListener(proc) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return
  try {
    proc.kill('SIGTERM')
  } catch {
    return
  }
  if (await waitForChildExit(proc, 2000)) return
  try {
    proc.kill('SIGKILL')
  } catch {
    // The owned listener exited between the bounded waits.
  }
  await waitForChildExit(proc, 1000)
}

function waitForChildExit(proc, waitMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode })
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      proc.off('exit', onExit)
      resolveExit(null)
    }, waitMs)
    const onExit = (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    }
    proc.once('exit', onExit)
  })
}

async function analyzeSharedStreamArtifact(target, combo, listenerExit) {
  const sizeBytes = existsSync(target.recvPath) ? statSync(target.recvPath).size : 0
  const failures = []
  if (sizeBytes <= 0) {
    failures.push(
      `shared record+stream listener produced no FLV artifact: ${target.recvPath} ` +
        `(${listenerExit.stderr.trim() || 'no listener error'})`
    )
    return { path: target.recvPath, sizeBytes, listenerExit, failures }
  }
  const quality = await analyzeRecording(target.recvPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: combo.fps,
    expectAudio: false,
    gates: {
      ...TRANSIENT_FIFO_GATES,
      // The listener's FLV shutdown edge is independent of the recording
      // artifact's audio-tail law. Decode, timestamp, color, level, and
      // keyframe gates remain armed for the actual bytes a platform received.
      maxTailMismatchMs: null
    }
  })
  writeReports(quality)
  failures.push(
    ...quality.verdict.failures.map((failure) => `shared livestream artifact: ${failure}`)
  )
  if (quality.metrics.width !== combo.width || quality.metrics.height !== combo.height) {
    failures.push(
      `shared livestream dimensions ${quality.metrics.width}x${quality.metrics.height} ` +
        `!= requested ${combo.width}x${combo.height}`
    )
  }
  if (!((quality.metrics.durationSeconds ?? 0) >= 2)) {
    failures.push(
      `shared livestream duration ${quality.metrics.durationSeconds ?? 'missing'}s was below 2s`
    )
  }
  return {
    path: target.recvPath,
    sizeBytes,
    listenerExit,
    failures,
    metrics: quality.metrics,
    warnings: quality.verdict.warnings
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

const results = []
let launchedOk = false
try {
  results.push(...(await runPass({ passLabel: '', combos: MATRIX })))
  launchedOk = true
  // Hard-content pass: per-frame noise makes the encoder do real-content
  // work, surfacing bridge-pressure defects (encoder behind realtime, ring
  // starvation, latency-contract kills) that the easy 64x64 pattern hides —
  // 0.9.44 shipped its mid-recording-crash regression through green gates
  // exactly that way. Preview must stay live THROUGH the recording.
  // 1080p60 must hold FULL cadence under noise (proven headroom); 4K noise is
  // beyond any real content, so 4K30 runs as a survival stress combo.
  if (HARD_COMBOS.length > 0) {
    results.push(
      ...(await runPass({
        passLabel: 'hard',
        combos: HARD_COMBOS,
        extraEnv: { VIDEORC_SYNTHETIC_HARD_CONTENT: '1' },
        assertPreviewLiveness: true
      }))
    )
  }
  // Deterministic reproduction for the 2026-08-25 owner failure: pause the
  // macOS VideoToolbox FIFO worker once for 700ms after the session is warm.
  // The maintained gate requires the reproduced depth 16/16 and oldest
  // >=528/250ms queue shape, followed by a recovery transition. Recovery must
  // preserve every encoded access unit, keep the compositor and session live,
  // and finish as MP4 with a clean FFmpeg exit on the user's stop.
  if (process.platform === 'darwin' && TRANSIENT_FIFO_COMBO) {
    results.push(
      ...(await runPass({
        passLabel: 'transient-fifo-pressure',
        combos: [TRANSIENT_FIFO_COMBO],
        extraEnv: {
          VIDEORC_TEST_VT_FIFO_PAUSE_AFTER_FRAMES: '60',
          // Reproduce the owner's 528ms/16-frame incident shape, rather than
          // the old 350ms probe that could recover without filling the queue.
          VIDEORC_TEST_VT_FIFO_PAUSE_MS: '700'
        },
        assertPreviewLiveness: true,
        requireTransientFifoPressure: true
      }))
    )
  }
  // The owner incident occurred while one encoder fed BOTH the local
  // recording and livestream. Keep that fallback failure domain covered even
  // though current capable hardware normally selects isolated record/stream
  // encoders: the debug-only selector is accepted only behind the backend's
  // smoke-RPC authority. The local RTMP receiver proves that the shared stream
  // remains live through the same depth-16/528ms burst, while the recording
  // still stops on user request and finalizes as a fully analyzed MP4.
  if (process.platform === 'darwin' && SHARED_TRANSIENT_FIFO_COMBO) {
    results.push(
      ...(await runPass({
        passLabel: 'shared-transient-fifo-pressure',
        combos: [SHARED_TRANSIENT_FIFO_COMBO],
        extraEnv: {
          VIDEORC_TEST_FORCE_SHARED_ENCODER_OUTPUT: '1',
          VIDEORC_TEST_VT_FIFO_PAUSE_AFTER_FRAMES: '60',
          VIDEORC_TEST_VT_FIFO_PAUSE_MS: '700'
        },
        assertPreviewLiveness: true,
        requireTransientFifoPressure: true,
        streamTarget: sharedStreamTarget,
        requireSharedRecordStream: true
      }))
    )
  }
} catch (error) {
  console.error(`Recording matrix pass failed to launch: ${String(error?.message ?? error)}`)
}

results.push(
  ...missingRecordingMatrixResultFailures({
    expectedLabels: EXPECTED_RESULT_LABELS,
    results
  })
)

const resultsPath = join(outputDirectory, 'recording-matrix-results.json')
try {
  writeFileSync(resultsPath, JSON.stringify(results, null, 1))
} catch {
  // The console summary below is the primary output.
}

const failed = results.filter((result) => result.failures.length > 0)
if (!launchedOk || results.length === 0) {
  console.error('Recording matrix smoke did not produce any results.')
  process.exit(1)
}
console.log(
  `\nRecording matrix: ${results.length - failed.length}/${results.length} combos PASS ` +
    `(reports in ${outputDirectory})`
)
if (failed.length > 0) {
  console.error(`Failing combos: ${failed.map((result) => result.combo).join(', ')}`)
  process.exit(1)
}
