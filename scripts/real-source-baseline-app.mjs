#!/usr/bin/env node
// Phase 0 — Real-source baseline harness.
//
// The existing smokes all drive `sources: { testPattern: true }`, so they prove the
// synthetic pipeline, never the real one. This harness drives the REAL path:
//   real screen + real camera + real mic  ->  shared compositor  ->  60s recording,
// samples the live backend diagnostics throughout, then runs the honest final-file
// analyzer on the output and writes an objective baseline report next to it.
//
// It is deliberately a BASELINE (measure + reproduce), not a gate: it reports the
// truth and, unless `--gate` is passed, exits 0 even when the recording is bad — so
// you can capture "this is what a bad real recording actually looks like" (the plan's
// Phase 0 step 2). Pass `--gate` to make the exit code reflect the analyzer verdict.
//
// REQUIREMENTS: a real desktop session with macOS Screen Recording, Camera, and
// Microphone permissions granted to the dev app. This records your screen for the
// configured duration — run it intentionally.
//
//   node scripts/real-source-baseline-app.mjs [--gate]
//
// Env:
//   VIDEORC_BASELINE_RECORDING_MS   recording length (default 60000)
//   VIDEORC_BASELINE_WIDTH/HEIGHT/FPS/BITRATE_KBPS   output video (default 1920x1080@30, 6000)
//   VIDEORC_BASELINE_FALLBACK_LIVE_PREVIEW=1   deliberately launch the legacy FFmpeg MJPEG preview
//   VIDEORC_BASELINE_NO_PREVIEW_SURFACE=1      warm sources, but do not create the proof/native preview surface
//   VIDEORC_BASELINE_REQUIRE_MOTION=1          keep freezedetect as a hard gate for controlled-motion captures
//   VIDEORC_BASELINE_SCREEN_MOTION_STIMULUS=1  launch a visible animated browser window and require motion
//   VIDEORC_BASELINE_AV_SYNC_STIMULUS=1        launch a visible flash+click browser window for lip-sync measurement
//   VIDEORC_BASELINE_MIC_SYNC_OFFSET_MS        microphone sync offset to pass through to the recording session
//   VIDEORC_BASELINE_STREAM=1                  enable record+stream (RTMP) for this session
//   VIDEORC_BASELINE_STREAM_SERVER_URL         RTMP server URL (e.g. rtmp://127.0.0.1:19501/live)
//   VIDEORC_BASELINE_STREAM_KEY                RTMP stream key (never printed; local sinks use a dummy key)
//   VIDEORC_SMOKE_OUTPUT_DIR        where recordings + reports land
//   VIDEORC_BASELINE_SCREEN_ID / _CAMERA_ID / _MIC_ID   force a specific device id
//   VIDEORC_BASELINE_NO_SCREEN / _NO_CAMERA / _NO_MIC   omit that source
//   VIDEORC_BASELINE_LAYOUT_PRESET  force layout preset; otherwise inferred from selected sources
//   VIDEORC_SMOKE_FFMPEG_PATH / VIDEORC_SMOKE_FFPROBE_PATH

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { launchAvSyncStimulus, stopAvSyncStimulus } from './lib/av-sync-stimulus.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { launchScreenMotionStimulus, stopScreenMotionStimulus } from './lib/screen-motion-stimulus.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { analyzeStartupResolution, writeStartupReports } from './lib/startup-resolution-analyzer.mjs'
import { DEFAULT_ACCEPTANCE_GATES, evaluateAcceptance } from './lib/acceptance-gate.mjs'
import { classifyMediaQualityMode } from './lib/media-quality-mode.mjs'
import { classifyObsParityEvidence } from './lib/obs-parity-evidence.mjs'
import { requiredSourceBlocker } from './lib/required-source-blockers.mjs'
import { pickDevice } from './lib/source-selection.mjs'
import { evaluateRequired4kSourcePreflight } from './lib/source-preflight.mjs'
import {
  claimsNativePreview,
  formatTransportHonesty,
  strongestPreviewBacking,
  strongestPreviewTransport,
} from './lib/native-preview-claim.mjs'
import { createPreviewSurfaceOutputGuard } from './lib/smoke-output-guards.mjs'

const config = {
  recordingMs: Number(process.env.VIDEORC_BASELINE_RECORDING_MS ?? 60000),
  width: Number(process.env.VIDEORC_BASELINE_WIDTH ?? 1920),
  height: Number(process.env.VIDEORC_BASELINE_HEIGHT ?? 1080),
  fps: Number(process.env.VIDEORC_BASELINE_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_BASELINE_BITRATE_KBPS ?? 6000),
  timeoutMs: Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000),
  sampleIntervalMs: Number(process.env.VIDEORC_BASELINE_SAMPLE_MS ?? 2000),
  warmupMs: Number(process.env.VIDEORC_BASELINE_WARMUP_MS ?? 8000),
  previewMeasurementMs: Number(process.env.VIDEORC_BASELINE_PREVIEW_MEASUREMENT_MS ?? 5000),
  ffmpegPath: process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? siblingFfprobe(process.env.VIDEORC_SMOKE_FFMPEG_PATH) ?? 'ffprobe',
  // Stream sessions must exercise the backend's DEFAULT bridge selector. On macOS
  // this is the product VideoToolbox H.264 path; raw-YUV is an explicit debug
  // override only. Only force an output when the operator set one explicitly, or
  // for record-only runs (previous behavior).
  bridgeVideoOutput:
    process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT ??
    (process.env.VIDEORC_BASELINE_STREAM === '1' ? null : 'videotoolbox-h264-mpegts'),
  streamEnabled: process.env.VIDEORC_BASELINE_STREAM === '1',
  streamServerUrl: process.env.VIDEORC_BASELINE_STREAM_SERVER_URL ?? '',
  streamKey: process.env.VIDEORC_BASELINE_STREAM_KEY ?? '',
  fallbackLivePreview: process.env.VIDEORC_BASELINE_FALLBACK_LIVE_PREVIEW === '1',
  noPreviewSurface: process.env.VIDEORC_BASELINE_NO_PREVIEW_SURFACE === '1',
  screenMotionStimulus: process.env.VIDEORC_BASELINE_SCREEN_MOTION_STIMULUS === '1',
  avSyncStimulus: process.env.VIDEORC_BASELINE_AV_SYNC_STIMULUS === '1',
  microphoneSyncOffsetMs: Number(process.env.VIDEORC_BASELINE_MIC_SYNC_OFFSET_MS ?? 0),
  requireMotion:
    process.env.VIDEORC_BASELINE_REQUIRE_MOTION === '1' ||
    process.env.VIDEORC_BASELINE_SCREEN_MOTION_STIMULUS === '1',
  outputDirectory: resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-real-source-baseline-${Date.now()}`)
  ),
  gate: process.argv.includes('--gate'),
}

const NATIVE_PREFIX = {
  screen: 'screen:screencapturekit:',
  camera: 'camera:avfoundation-native:',
  microphone: 'microphone:coreaudio:',
}

let launched
let motionStimulus
let avSyncStimulus
const previewSurfaceOutputGuard = createPreviewSurfaceOutputGuard()
mkdirSync(config.outputDirectory, { recursive: true })

let exitCode = 0
try {
  const verdict = await main()
  exitCode = config.gate && verdict && !verdict.pass ? 1 : 0
} catch (error) {
  console.error(`real-source baseline failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  if (motionStimulus) await stopScreenMotionStimulus(motionStimulus)
  if (avSyncStimulus) await stopAvSyncStimulus(avSyncStimulus)
  if (launched) await stopProcess(launched.process)
}
process.exit(exitCode)

async function main() {
  console.log('Launching dev app for real-source baseline (no preview-motion synthetic mode)…')
  const requiresPreviewHostCommandServer = !config.noPreviewSurface && !config.fallbackLivePreview
  launched = await launchDevApp({
    timeoutMs: config.timeoutMs,
    requiredMarkers: requiresPreviewHostCommandServer
      ? ['backend-ready', 'preview-motion-ready']
      : ['backend-ready'],
    // Real sources must flow: do NOT set VIDEORC_SMOKE_PREVIEW_MOTION (that forces
    // synthetic procedural preview). The harness owns preview setup explicitly so the
    // renderer cannot race it with automatic source/surface refreshes.
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: config.outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: config.noPreviewSurface ? '0' : '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: requiresPreviewHostCommandServer ? '1' : '0',
      VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED: requiresPreviewHostCommandServer ? '1' : '0',
      ...(config.streamEnabled ? { VIDEORC_PREMIUM_FEATURES: '1' } : {}),
      // null means "let the backend's default selector decide" (the honest product
      // path for stream sessions); the app-launcher merges over process.env, so the
      // key must be absent entirely, not undefined.
      ...(config.bridgeVideoOutput
        ? { VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: config.bridgeVideoOutput }
        : {}),
    },
    onLine: (line) => {
      previewSurfaceOutputGuard.inspectLine(line)
      console.log(line)
    },
  })

  const ws = await connectBackend(launched.connections['backend-ready'], config.timeoutMs)
  const diagnosticsEvents = []
  const healthEvents = []
  const recordingStatusEvents = []
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message.event === 'diagnostics.stats') {
        diagnosticsEvents.push({ ...message.payload, receivedAt: Date.now() })
      }
      if (message.event === 'health.event') {
        healthEvents.push({ ...message.payload, receivedAt: Date.now() })
      }
      if (message.event === 'recording.status') {
        recordingStatusEvents.push({ ...message.payload, receivedAt: Date.now() })
      }
    } catch {
      // Ignore non-JSON socket noise.
    }
  })

  try {
    const health = await request(ws, config.timeoutMs, 'health.ping', { ffmpegPath: config.ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the baseline run.')
    }

    const devices = await request(ws, config.timeoutMs, 'devices.list', { ffmpegPath: config.ffmpegPath })
    const sources = selectSources(devices.devices ?? [])
    reportSelection(sources, devices.warnings ?? [])
    assertRequiredSourcesAvailable(sources)
    if (config.screenMotionStimulus && !sources.screen) {
      throw new Error('Screen motion stimulus requires a selected real screen source.')
    }
    if (config.avSyncStimulus && !sources.screen) {
      throw new Error('A/V sync stimulus requires a selected real screen source.')
    }
    if (!sources.screen && !sources.camera) {
      throw new Error('No real screen or camera available/selected — cannot run a real-source baseline.')
    }

    const sourceSelection = {
      screenId: sources.screen?.id ?? null,
      windowId: null,
      cameraId: sources.camera?.id ?? null,
      microphoneId: sources.microphone?.id ?? null,
      testPattern: false,
    }
    const preRecordingStartedAt = Date.now()
    try {
      assertRequiredNativeSourcesForAccepted4k(sources)
    } catch (error) {
      return await writeBlockedBeforeEncoding({
        ws,
        sources,
        previewTransport: 'unknown',
        diagnosticsEvents,
        healthEvents,
        scenarioStartedAt: preRecordingStartedAt,
        error,
        failurePrefix: 'pre-recording source validation failed',
      })
    }

    // Mirror the UI: warm the real capturers, then use the compositor preview surface
    // when native preview mode is enabled. The legacy live preview launches a second
    // FFmpeg AVFoundation graph, so keep it opt-in for fallback transport tests only.
    let previewTransport = 'unknown'
    await tryStep('preview.camera.start', async () => {
      if (sources.camera) await request(ws, config.timeoutMs, 'preview.camera.start', previewSourceParams(sourceSelection))
    })
    await tryStep('preview.screen.start', async () => {
      if (sources.screen) await request(ws, config.timeoutMs, 'preview.screen.start', previewSourceParams(sourceSelection))
    })
    if (config.fallbackLivePreview) {
      await tryStep('preview.live.start', async () => {
        const status = await request(ws, config.timeoutMs, 'preview.live.start', {
          sources: sourceSelection,
          layout: layoutSettings(sourceSelection),
          ffmpegPath: config.ffmpegPath,
          video: videoSettings(),
        })
        previewTransport = status?.transport ?? previewTransport
      })
    } else if (config.noPreviewSurface) {
      await tryStep('preview.live.stop', async () => {
        await request(ws, config.timeoutMs, 'preview.live.stop')
      })
      await tryStep('preview.surface.destroy', async () => {
        const status = await request(ws, config.timeoutMs, 'preview.surface.destroy')
        previewTransport = status?.transport ?? 'unavailable'
      })
    } else {
      await tryStep('preview.live.stop', async () => {
        await request(ws, config.timeoutMs, 'preview.live.stop')
      })
      await requiredStep('preview.surface.create', async () => {
        const status = await request(ws, config.timeoutMs, 'preview.surface.create', {
          bounds: previewSurfaceBounds(),
          targetFps: 60,
          source: previewSurfaceSource(sourceSelection),
        })
        const hostStatus = await applyPendingNativePreviewHostCommands(ws)
        previewTransport = hostStatus?.transport ?? status?.transport ?? previewTransport
      })
    }

    if (config.screenMotionStimulus) {
      console.log('Launching visible screen motion stimulus for hard motion gates.')
      motionStimulus = await launchScreenMotionStimulus({ screenSource: sources.screen })
      console.log(
        `Screen motion stimulus window ${motionStimulus.width}x${motionStimulus.height} @ ${motionStimulus.x},${motionStimulus.y}.`
      )
    }
    if (config.avSyncStimulus) {
      console.log('Launching visible flash+click A/V sync stimulus.')
      avSyncStimulus = await launchAvSyncStimulus({ screenSource: sources.screen })
      console.log(`A/V sync stimulus window ${avSyncStimulus.width}x${avSyncStimulus.height} @ ${avSyncStimulus.x},${avSyncStimulus.y}.`)
    }

    try {
      await waitForPreviewSourceReadiness(ws, sources)
    } catch (error) {
      return await writeBlockedBeforeEncoding({
        ws,
        sources,
        previewTransport,
        diagnosticsEvents,
        healthEvents,
        scenarioStartedAt: preRecordingStartedAt,
        error,
        failurePrefix: 'pre-recording source readiness failed',
      })
    }

    const scenarioStartedAt = Date.now()
    let started
    try {
      started = await request(ws, config.timeoutMs, 'session.start', sessionParams(sourceSelection))
    } catch (error) {
      return await writeBlockedBeforeEncoding({
        ws,
        sources,
        previewTransport,
        diagnosticsEvents,
        healthEvents,
        scenarioStartedAt,
        error,
        failurePrefix: 'session.start failed before encoding',
      })
    }
    if (started.state !== 'recording') {
      throw new Error(`Expected recording state after start, got ${started.state}.`)
    }
    console.log(`Recording real sources for ${(config.recordingMs / 1000).toFixed(0)}s -> ${started.outputPath ?? '(pending)'}`)

    const previewMeasurementPromise = measureNativePreviewDuringRecording()
    const snapshots = await sampleDuringRecording(ws, config.recordingMs)
    const previewMeasurement = await previewMeasurementPromise
    if (previewMeasurement?.error) {
      console.log(`Native preview direct measurement failed: ${previewMeasurement.error}`)
    }
    const stopRequestedAt = Date.now()
    const stopped = await request(ws, config.timeoutMs, 'session.stop')
    const outputPath = await resolveFinalRecordingPath({
      started,
      stopped,
      recordingStatusEvents,
      healthEvents,
      stopRequestedAt,
      timeoutMs: config.timeoutMs,
    })
    if (!outputPath || !existsSync(outputPath)) {
      throw new Error(`Recording output was not created: ${outputPath ?? 'missing path'}`)
    }
    const size = statSync(outputPath).size
    console.log(`Recording finished: ${outputPath} (${(size / (1024 * 1024)).toFixed(1)} MiB)`)

    // Honest final-file analysis.
    const report = await analyzeRecording(outputPath, {
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      intendedFps: config.fps,
      expectAudio: Boolean(sources.microphone),
      gates: {
        requireMotion: config.requireMotion,
      },
    })
    const diagnostics = summarizeDiagnostics(diagnosticsEvents, snapshots, scenarioStartedAt, stopRequestedAt, {
      previewMeasurement,
    })
    const analyzerPaths = writeReports(report)
    const startupReport = await analyzeStartupResolution(outputPath, {
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      expectedWidth: config.width,
      expectedHeight: config.height,
      intendedFps: config.fps,
      syntheticEvidence: diagnostics.encoderBridgeSyntheticFrames,
      gates: {
        requireMotion: config.requireMotion,
      },
    })
    const startupPaths = await writeStartupReports(startupReport, {
      ffmpegPath: config.ffmpegPath,
    })
    const claimsNative = claimsNativePreview({ previewTransport, diagnostics })
    const previewSurfaceOutputFailures = previewSurfaceOutputGuard.failures()
    // Full real-source acceptance gate: final-file verdict + recording repeats +
    // encoder speed + mic drops/coverage + transport honesty, all enforced together.
    // The Electron proof surface reports metrics, but only native-surface plus a real
    // CAMetalLayer backing is an OBS-native claim.
    const acceptance = appendPreviewSurfaceOutputFailures(
      evaluateAcceptance(
        {
          analyzerVerdict: report.verdict,
          startupVerdict: startupReport.verdict,
          diagnostics,
          claimsNative,
          requireObsNativePreview: !config.noPreviewSurface,
          requireGpuCompositor: true,
          requestedOutput: requestedOutputSettings(),
          require4kMediaEvidence: requires4kMediaEvidence(),
          expectAudio: Boolean(sources.microphone),
        },
        acceptanceGates()
      ),
      previewSurfaceOutputFailures
    )
    const qualityMode = classifyMediaQualityMode({
      diagnostics,
      claimsNative,
      requestedOutput: requestedOutputSettings(),
      recordingEnabled: true,
      streamEnabled: config.streamEnabled,
      separateOutputEncoders: diagnostics.encoderBridgeSeparateOutputEncodersActive,
      streamOutput: outputProfileFromDiagnostics(diagnostics, 'stream'),
      acceptancePass: acceptance.pass,
    })
    const ownership = classifyObsParityEvidence({
      analyzerVerdict: report.verdict,
      startupVerdict: startupReport.verdict,
      diagnostics,
      claimsNative,
      previewMeasured: !config.noPreviewSurface,
    })
    const baselinePath = writeBaselineReport(outputPath, {
      sources,
      previewTransport,
      size,
      diagnostics,
      report,
      startupReport,
      startupPaths,
      acceptance,
      ownership,
      qualityMode,
      previewSurfaceOutputFailures,
    })
    const evidenceManifestPath = writeEvidenceManifest(outputPath, {
      sources,
      previewTransport,
      diagnostics,
      report,
      startupReport,
      analyzerPaths,
      startupPaths,
      baselinePath,
      acceptance,
      qualityMode,
      previewSurfaceOutputFailures,
    })

    printSummary(
      report,
      startupReport,
      diagnostics,
      previewTransport,
      baselinePath,
      evidenceManifestPath,
      acceptance,
      ownership,
      qualityMode
    )
    return acceptance
  } finally {
    ws.close()
  }
}

// --- Source selection -------------------------------------------------------

function selectSources(devices) {
  const requested4k = requires4kMediaEvidence() ? requestedOutputSettings() : null
  return {
    screen: pickDevice(devices, 'screen', {
      override: process.env.VIDEORC_BASELINE_SCREEN_ID,
      disabled: process.env.VIDEORC_BASELINE_NO_SCREEN === '1',
      nativePrefix: NATIVE_PREFIX.screen,
      minimumWidth: requested4k?.width,
      minimumHeight: requested4k?.height,
    }),
    camera: pickDevice(devices, 'camera', {
      override: process.env.VIDEORC_BASELINE_CAMERA_ID,
      disabled: process.env.VIDEORC_BASELINE_NO_CAMERA === '1',
      nativePrefix: NATIVE_PREFIX.camera,
    }),
    microphone: pickDevice(devices, 'microphone', {
      override: process.env.VIDEORC_BASELINE_MIC_ID,
      disabled: process.env.VIDEORC_BASELINE_NO_MIC === '1',
      nativePrefix: NATIVE_PREFIX.microphone,
    }),
  }
}

function assertRequiredSourcesAvailable(sources) {
  const blockers = [
    requiredSourceBlocker('screen', sources.screen, {
      disabled: process.env.VIDEORC_BASELINE_NO_SCREEN === '1',
      override: process.env.VIDEORC_BASELINE_SCREEN_ID,
      disableHint: 'VIDEORC_BASELINE_NO_SCREEN=1',
      allowForcedOverride: true,
    }),
    requiredSourceBlocker('camera', sources.camera, {
      disabled: process.env.VIDEORC_BASELINE_NO_CAMERA === '1',
      override: process.env.VIDEORC_BASELINE_CAMERA_ID,
      disableHint: 'VIDEORC_BASELINE_NO_CAMERA=1',
    }),
    requiredSourceBlocker('microphone', sources.microphone, {
      disabled: process.env.VIDEORC_BASELINE_NO_MIC === '1',
      override: process.env.VIDEORC_BASELINE_MIC_ID,
      disableHint: 'VIDEORC_BASELINE_NO_MIC=1',
    }),
  ].filter(Boolean)

  if (blockers.length > 0) {
    throw new Error(
      `Real-source baseline requires available native sources: ${blockers.join('; ')}. ` +
        'Grant macOS permissions, force an explicit device id, or disable the source with the listed env var.'
    )
  }
}

function assertRequiredNativeSourcesForAccepted4k(sources) {
  if (!requires4kMediaEvidence()) return
  const preflight = evaluateRequired4kSourcePreflight(sources, requestedOutputSettings(), {
    nativeScreenPrefix: NATIVE_PREFIX.screen,
  })
  if (!preflight.pass) {
    throw new Error(preflight.failures.join(' '))
  }
}

function reportSelection(sources, warnings) {
  const describe = (label, device) =>
    `  ${label}: ${device ? `${device.name} [${device.id}] (${device.status})${formatDeviceDimensions(device)}` : 'none'}`
  console.log('Selected real sources:')
  console.log(describe('screen', sources.screen))
  console.log(describe('camera', sources.camera))
  console.log(describe('microphone', sources.microphone))
  for (const warning of warnings) console.log(`  device warning: ${warning}`)
}

function formatDeviceDimensions(device) {
  return typeof device?.width === 'number' && typeof device?.height === 'number'
    ? ` ${device.width}x${device.height}`
    : ''
}

async function waitForPreviewSourceReadiness(ws, sources) {
  const deadline = Date.now() + Math.min(config.timeoutMs, 15_000)
  let lastCamera = null
  let lastScreen = null
  while (Date.now() < deadline) {
    ;[lastCamera, lastScreen] = await Promise.all([
      sources.camera ? requestSafe(ws, 'preview.camera.status') : Promise.resolve(null),
      sources.screen ? requestSafe(ws, 'preview.screen.status') : Promise.resolve(null),
    ])
    if (previewCameraReady(lastCamera) && previewScreenReady(lastScreen)) {
      console.log(
        `Preview sources ready: camera ${describePreviewReadiness(lastCamera)}, screen ${describePreviewReadiness(lastScreen)}`
      )
      return
    }
    await sleep(250)
  }
  throw new Error(
    `Timed out waiting for preview sources before recording: camera ${describePreviewReadiness(lastCamera)}, screen ${describePreviewReadiness(lastScreen)}`
  )
}

async function writeBlockedBeforeEncoding({
  ws,
  sources,
  previewTransport,
  diagnosticsEvents,
  healthEvents,
  scenarioStartedAt,
  error,
  failurePrefix,
}) {
  await sleep(100)
  const blockedAt = Date.now()
  const snapshots = [await sampleDiagnosticsSnapshot(ws)]
  const diagnostics = summarizeDiagnostics(diagnosticsEvents, snapshots, scenarioStartedAt, blockedAt, {
    includePreStart: true,
  })
  const previewSurfaceOutputFailures = previewSurfaceOutputGuard.failures()
  const qualityMode = classifyMediaQualityMode({
    diagnostics,
    requestedOutput: requestedOutputSettings(),
    recordingEnabled: true,
    streamEnabled: false,
    separateOutputEncoders: diagnostics.encoderBridgeSeparateOutputEncodersActive,
    streamOutput: outputProfileFromDiagnostics(diagnostics, 'stream'),
    acceptancePass: false,
  })
  const baselinePath = writeBlockedStartupReport({
    sources,
    previewTransport,
    diagnostics,
    healthEvents: healthEvents.filter((event) => (event.receivedAt ?? 0) >= scenarioStartedAt - 250),
    error,
    qualityMode,
    previewSurfaceOutputFailures,
  })
  const evidenceManifestPath = writeBlockedEvidenceManifest({
    sources,
    previewTransport,
    diagnostics,
    baselinePath,
    error,
    qualityMode,
    previewSurfaceOutputFailures,
  })
  printBlockedStartupSummary(error, diagnostics, previewTransport, baselinePath, evidenceManifestPath, qualityMode)
  return {
    pass: false,
    failures: [
      `${failurePrefix}: ${error?.message ?? error}`,
      ...previewSurfaceOutputFailureMessages(previewSurfaceOutputFailures),
    ],
    warnings: [],
  }
}

function previewCameraReady(status) {
  if (!status) return true
  return status.state === 'live' && (status.framesCaptured ?? 0) > 0 && (status.frameAgeMs ?? Infinity) <= 2_000
}

function previewScreenReady(status) {
  if (!status) return true
  return status.state === 'live' && (status.framesCaptured ?? 0) > 0
}

function describePreviewReadiness(status) {
  if (!status) return 'not selected'
  const message = status.message ? ` message="${status.message}"` : ''
  return `${status.state ?? 'unknown'} frames=${status.framesCaptured ?? 0} age=${status.frameAgeMs ?? 'n/a'}ms${message}`
}

// --- Diagnostics sampling ---------------------------------------------------

async function measureNativePreviewDuringRecording() {
  if (config.noPreviewSurface || config.fallbackLivePreview) {
    return null
  }
  const smoke = launched?.connections?.['preview-motion-ready']
  if (!smoke) {
    return { error: 'preview host command server was not available' }
  }
  const durationMs = Math.max(1000, Math.min(config.previewMeasurementMs, config.recordingMs))
  try {
    const measurement = await smokeCommand(smoke, 'measure-native-preview-surface', { durationMs })
    return { measurement }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

async function sampleDuringRecording(ws, durationMs) {
  const snapshots = []
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    snapshots.push(await sampleDiagnosticsSnapshot(ws))
    await sleep(config.sampleIntervalMs)
  }
  return snapshots
}

async function sampleDiagnosticsSnapshot(ws) {
  const [diagnostics, compositor, surface, camera, screen] = await Promise.all([
    requestSafe(ws, 'diagnostics.stats'),
    requestSafe(ws, 'compositor.status'),
    requestSafe(ws, 'preview.surface.status'),
    requestSafe(ws, 'preview.camera.status'),
    requestSafe(ws, 'preview.screen.status'),
  ])
  return { at: Date.now(), diagnostics, compositor, surface, camera, screen }
}

function summarizeDiagnostics(events, snapshots, startedAt, stopRequestedAt, options = {}) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const activeEvents = events.filter((s) => {
    const t = s.receivedAt ?? 0
    return t >= startedAt && t <= stopRequestedAt && (options.includePreStart || s.activeOutputMode === 'record')
  })
  const activeSnapshots = options.includePreStart
    ? snapshots
        .filter((s) => s.diagnostics && s.at >= startedAt && s.at <= stopRequestedAt)
        .map((s) => ({ ...s.diagnostics, receivedAt: s.at }))
    : []
  const active = [...activeEvents, ...activeSnapshots]
  const steady = active.filter((s) => (s.receivedAt ?? 0) - startedAt >= config.warmupMs)
  const measured = steady.length ? steady : active
  const collect = (key) => measured.map((s) => num(s[key])).filter((v) => v !== null)
  const collectBooleans = (key) => measured.map((s) => s[key]).filter((value) => typeof value === 'boolean')
  const captureFps = collect('captureFps')
  const renderFps = collect('renderFps')
  const speed = collect('encoderSpeed')
  const rss = collect('backendRssBytes')
  const ffmpegProcs = collect('activeFfmpegProcesses')
  const ffprobeProcs = collect('activeFfprobeProcesses')
  const screenIosurfaceSamples = collectBooleans('previewScreenIosurfaceAvailable')
  const lastValue = (key) => {
    for (let index = measured.length - 1; index >= 0; index -= 1) {
      const value = measured[index]?.[key]
      if (value !== undefined && value !== null) return value
    }
    return null
  }
  const lastSnapshotValue = (samples, key) => {
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const value = samples[index]?.[key]
      if (value !== undefined && value !== null) return value
    }
    return null
  }

  const previewMeasurement = options.previewMeasurement?.measurement ?? null
  const previewMeasurementStatus = previewMeasurement?.status ?? null
  const previewMeasurementError = options.previewMeasurement?.error ?? null
  const compositorSamples = snapshots.map((s) => s.compositor).filter(Boolean)
  const surfaceSamples = [
    ...snapshots.map((s) => s.surface).filter(Boolean),
    ...(previewMeasurementStatus ? [previewMeasurementStatus] : []),
  ]
  const surfaceMetric = (key) => surfaceSamples.map((s) => num(s[key])).filter((v) => v !== null)
  const transportSamples = measured.map((s) => s.previewTransport).filter(Boolean)
  const backingSamples = measured.map((s) => s.previewSurfaceBacking).filter(Boolean)
  const transports = new Set(transportSamples)
  for (const s of surfaceSamples) if (s.transport) transports.add(s.transport)
  for (const s of surfaceSamples) if (s.transport) transportSamples.push(s.transport)
  const surfaceBackings = new Set(backingSamples)
  for (const s of surfaceSamples) if (s.backing) surfaceBackings.add(s.backing)
  for (const s of surfaceSamples) if (s.backing) backingSamples.push(s.backing)
  const bottlenecks = new Set(measured.map((s) => s.bottleneck).filter(Boolean))

  // Transport honesty: how much HTTP image-polling happened DURING the session. A truly
  // native preview never fetches these routes, so any climb means the "native" preview is
  // really PNG/JPEG/MJPEG polling.
  const pollSamples = snapshots.map((s) => s.diagnostics?.previewImagePollCounts).filter(Boolean)
  const pollFirst = pollSamples[0]
  const pollLast = pollSamples[pollSamples.length - 1]
  const pollDelta = (key) =>
    pollFirst && pollLast ? Math.max(0, (pollLast[key] ?? 0) - (pollFirst[key] ?? 0)) : null
  const imagePollDuringSession = {
    cameraPng: pollDelta('cameraPng'),
    screenPng: pollDelta('screenPng'),
    liveJpeg: pollDelta('liveJpeg'),
    liveMjpeg: pollDelta('liveMjpeg'),
  }
  imagePollDuringSession.total =
    pollFirst && pollLast
      ? (imagePollDuringSession.cameraPng ?? 0) +
        (imagePollDuringSession.screenPng ?? 0) +
        (imagePollDuringSession.liveJpeg ?? 0) +
        (imagePollDuringSession.liveMjpeg ?? 0)
      : null

  const minOf = (arr) => (arr.length ? Math.min(...arr) : null)
  const maxOf = (arr) => (arr.length ? Math.max(...arr) : null)
  const anyTrue = (arr) => arr.some((value) => value === true)
  const lastDefined = (arr, key) => {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const v = arr[i]?.[key]
      if (typeof v === 'number') return v
    }
    return null
  }
  const previewDirectMeasuredFps = num(previewMeasurement?.measuredFps ?? previewMeasurementStatus?.presentFps)
  const previewDirectIntervalP95Ms = num(previewMeasurement?.intervalP95Ms ?? previewMeasurementStatus?.intervalP95Ms)
  const previewDirectInputToPresentP95Ms =
    num(previewMeasurement?.inputToPresentLatencyP95Ms ?? previewMeasurementStatus?.inputToPresentLatencyP95Ms)
  const previewDirectInputToPresentP99Ms =
    num(previewMeasurement?.inputToPresentLatencyP99Ms ?? previewMeasurementStatus?.inputToPresentLatencyP99Ms)
  const previewDirectCompositorFrameLag =
    num(previewMeasurement?.compositorFrameLag ?? previewMeasurementStatus?.compositorFrameLag)
  const passivePreviewPresentFps = minOf(collect('previewPresentFps'))
  const passivePreviewIntervalP95Ms = maxOf(collect('previewRenderFrameTimeP95Ms'))
  const previewInputToPresentLatencyMs =
    maxOf([...collect('previewInputToPresentLatencyMs'), ...surfaceMetric('inputToPresentLatencyMs')])
  const previewInputToPresentLatencyP95Ms =
    previewDirectInputToPresentP95Ms ??
    maxOf([...collect('previewInputToPresentLatencyP95Ms'), ...surfaceMetric('inputToPresentLatencyP95Ms')])
  const previewInputToPresentLatencyP99Ms =
    previewDirectInputToPresentP99Ms ??
    maxOf([...collect('previewInputToPresentLatencyP99Ms'), ...surfaceMetric('inputToPresentLatencyP99Ms')])
  const nativePreviewRendererPollIntervalP95Ms =
    maxOf(surfaceMetric('nativePreviewRendererPollIntervalP95Ms'))
  const nativePreviewRendererPollRoundTripP95Ms =
    maxOf(surfaceMetric('nativePreviewRendererPollRoundTripP95Ms'))
  const nativePreviewRendererPresentRoundTripP95Ms =
    maxOf(surfaceMetric('nativePreviewRendererPresentRoundTripP95Ms'))
  const nativePreviewRendererPollInFlightSkips =
    maxOf(surfaceSamples.map((s) => s.nativePreviewRendererPollInFlightSkips ?? 0)) ?? 0
  const nativePreviewMainQueueWaitP95Ms =
    maxOf(surfaceMetric('nativePreviewMainQueueWaitP95Ms'))
  const nativePreviewMainPresentP95Ms =
    maxOf(surfaceMetric('nativePreviewMainPresentP95Ms'))
  const nativePreviewMainQueuedBehindCount =
    maxOf(surfaceSamples.map((s) => s.nativePreviewMainQueuedBehindCount ?? 0)) ?? 0
  const nativePreviewHelperRoundTripP95Ms =
    maxOf(surfaceMetric('nativePreviewHelperRoundTripP95Ms'))
  const nativePreviewMainStatusFetchP95Ms =
    maxOf(surfaceMetric('nativePreviewMainStatusFetchP95Ms'))
  const nativePreviewMainStatusFetchFailures =
    maxOf(surfaceSamples.map((s) => s.nativePreviewMainStatusFetchFailures ?? 0)) ?? 0
  const nativePreviewMainStatusFetchSuccesses =
    maxOf(surfaceSamples.map((s) => s.nativePreviewMainStatusFetchSuccesses ?? 0)) ?? 0
  const nativePreviewMainPresentedStatusAgeMs =
    maxOf(surfaceMetric('nativePreviewMainPresentedStatusAgeMs'))
  const nativePreviewMainPresentedStatusAgeP95Ms =
    maxOf(surfaceMetric('nativePreviewMainPresentedStatusAgeP95Ms'))
  const nativePreviewMainPresentedFrameAgeP95Ms =
    maxOf(surfaceMetric('nativePreviewMainPresentedFrameAgeP95Ms'))

  return {
    sampleCount: measured.length,
    snapshotCount: snapshots.length,
    minCaptureFps: minOf(captureFps),
    minRenderFps: minOf(renderFps),
    minEncoderSpeed: minOf(speed),
    droppedFrames: maxOf(measured.map((s) => s.droppedFrames ?? 0)) ?? 0,
    encodeBackend: measured.map((s) => s.encodeBackend).filter(Boolean).pop() ?? null,
    compositorBackend: measured.map((s) => s.compositorBackend).filter(Boolean).pop() ?? null,
    compositorFallbackReason: measured.map((s) => s.compositorFallbackReason).filter(Boolean).pop() ?? null,
    compositorCpuFallbackFrames: maxOf(measured.map((s) => s.compositorCpuFallbackFrames ?? 0)) ?? 0,
    previewTransport: strongestPreviewTransport(transportSamples),
    previewSurfaceBacking: strongestPreviewBacking(backingSamples),
    previewFramePollingSuppressed: anyTrue([
      ...measured.map((s) => s.previewFramePollingSuppressed),
      ...surfaceSamples.map((s) => s.framePollingSuppressed),
    ]),
    previewSourcePixelsPresent: anyTrue([
      ...measured.map((s) => s.previewSourcePixelsPresent),
      ...surfaceSamples.map((s) => s.sourcePixelsPresent),
    ]),
    previewPendingHostCommandCount:
      maxOf(surfaceSamples.map((s) => s.pendingHostCommandCount ?? 0)) ?? 0,
    encoderBridgeRepeatedFrames: maxOf(measured.map((s) => s.encoderBridgeRepeatedFrames ?? 0)) ?? 0,
    encoderBridgeRepeatedFrameBursts: maxOf(measured.map((s) => s.encoderBridgeRepeatedFrameBursts ?? 0)) ?? 0,
    encoderBridgeMaxRepeatedFrameRun: maxOf(measured.map((s) => s.encoderBridgeMaxRepeatedFrameRun ?? 0)) ?? 0,
    encoderBridgeSyntheticFrames: maxOf(measured.map((s) => s.encoderBridgeSyntheticFrames ?? 0)) ?? 0,
    encoderBridgeSourceAgeMs: maxOf(collect('encoderBridgeSourceAgeMs')),
    encoderBridgeSourceAgeP95Ms:
      maxOf(collect('encoderBridgeSourceAgeP95Ms')) ?? null,
    encoderBridgeRepeatedFrameAgeP95Ms:
      maxOf(collect('encoderBridgeRepeatedFrameAgeP95Ms')) ?? null,
    encoderBridgeRepeatedFrameAgeMaxMs:
      maxOf(collect('encoderBridgeRepeatedFrameAgeMaxMs')) ?? null,
    encoderBridgeMetalTargetFrames: maxOf(measured.map((s) => s.encoderBridgeMetalTargetFrames ?? 0)) ?? 0,
    encoderBridgeRawVideoCopiedFrames:
      maxOf(measured.map((s) => s.encoderBridgeRawVideoCopiedFrames ?? 0)) ?? 0,
    encoderBridgeMetalTargetCopiedFrames:
      maxOf(measured.map((s) => s.encoderBridgeMetalTargetCopiedFrames ?? 0)) ?? 0,
    encoderBridgeMetalTargetHandleFrames:
      maxOf(measured.map((s) => s.encoderBridgeMetalTargetHandleFrames ?? 0)) ?? 0,
    encoderBridgeZeroCopyFrames:
      maxOf(measured.map((s) => s.encoderBridgeZeroCopyFrames ?? 0)) ?? 0,
    encoderBridgeVideoToolboxProbeFrames:
      maxOf(measured.map((s) => s.encoderBridgeVideoToolboxProbeFrames ?? 0)) ?? 0,
    encoderBridgeVideoToolboxProbeBytes:
      maxOf(measured.map((s) => s.encoderBridgeVideoToolboxProbeBytes ?? 0)) ?? 0,
    encoderBridgeVideoToolboxProbeErrors:
      maxOf(measured.map((s) => s.encoderBridgeVideoToolboxProbeErrors ?? 0)) ?? 0,
    encoderBridgeVideoToolboxOutputFrames:
      maxOf(measured.map((s) => s.encoderBridgeVideoToolboxOutputFrames ?? 0)) ?? 0,
    encoderBridgeVideoToolboxOutputBytes:
      maxOf(measured.map((s) => s.encoderBridgeVideoToolboxOutputBytes ?? 0)) ?? 0,
    encoderBridgeVideoToolboxOutputEncodeMs:
      maxOf(collect('encoderBridgeVideoToolboxOutputEncodeMs')) ?? 0,
    recordingOutputWidth: lastDefined(measured, 'recordingOutputWidth'),
    recordingOutputHeight: lastDefined(measured, 'recordingOutputHeight'),
    recordingOutputFps: lastDefined(measured, 'recordingOutputFps'),
    recordingOutputBitrateKbps: lastDefined(measured, 'recordingOutputBitrateKbps'),
    streamOutputWidth: lastDefined(measured, 'streamOutputWidth'),
    streamOutputHeight: lastDefined(measured, 'streamOutputHeight'),
    streamOutputFps: lastDefined(measured, 'streamOutputFps'),
    streamOutputBitrateKbps: lastDefined(measured, 'streamOutputBitrateKbps'),
    encoderBridgeActiveVideoToolboxOutputEncoders:
      maxOf(measured.map((s) => s.encoderBridgeActiveVideoToolboxOutputEncoders ?? 0)) ?? 0,
    encoderBridgeRecordingVideoToolboxOutputFrames:
      maxOf(measured.map((s) => s.encoderBridgeRecordingVideoToolboxOutputFrames ?? 0)) ?? 0,
    encoderBridgeRecordingVideoToolboxOutputBytes:
      maxOf(measured.map((s) => s.encoderBridgeRecordingVideoToolboxOutputBytes ?? 0)) ?? 0,
    encoderBridgeStreamVideoToolboxOutputFrames:
      maxOf(measured.map((s) => s.encoderBridgeStreamVideoToolboxOutputFrames ?? 0)) ?? 0,
    encoderBridgeStreamVideoToolboxOutputBytes:
      maxOf(measured.map((s) => s.encoderBridgeStreamVideoToolboxOutputBytes ?? 0)) ?? 0,
    encoderBridgeSeparateOutputEncodersActive:
      anyTrue(measured.map((s) => s.encoderBridgeSeparateOutputEncodersActive)),
    encoderBridgeCompositorWaitP95Ms:
      maxOf(collect('encoderBridgeCompositorWaitP95Ms')) ?? null,
    encoderBridgeVideoToolboxSubmitP95Ms:
      maxOf(collect('encoderBridgeVideoToolboxSubmitP95Ms')) ?? null,
    encoderBridgeVideoToolboxFifoWriteP95Ms:
      maxOf(collect('encoderBridgeVideoToolboxFifoWriteP95Ms')) ?? null,
    encoderBridgeWriterLoopP95Ms:
      maxOf(collect('encoderBridgeWriterLoopP95Ms')) ?? null,
    encoderBridgeWriterSleepP95Ms:
      maxOf(collect('encoderBridgeWriterSleepP95Ms')) ?? null,
    encoderBridgeWriterActiveP95Ms:
      maxOf(collect('encoderBridgeWriterActiveP95Ms')) ?? null,
    encoderBridgeDeadlineLagP95Ms:
      maxOf(collect('encoderBridgeDeadlineLagP95Ms')) ?? null,
    encoderBridgeDeadlineLagMaxMs:
      maxOf(collect('encoderBridgeDeadlineLagMaxMs')) ?? null,
    encoderBridgeLateDeadlineTicks:
      maxOf(measured.map((s) => s.encoderBridgeLateDeadlineTicks ?? 0)) ?? 0,
    recordingStartupBarrierState: measured.map((s) => s.recordingStartupBarrierState).filter(Boolean).pop() ?? null,
    recordingStartupBarrierWaitMs: maxOf(collect('recordingStartupBarrierWaitMs')),
    recordingStartupBarrierTimeoutReason: measured.map((s) => s.recordingStartupBarrierTimeoutReason).filter(Boolean).pop() ?? null,
    firstSourceFrameMs: lastDefined(measured, 'firstSourceFrameMs'),
    firstFullResolutionCompositorFrameMs: lastDefined(measured, 'firstFullResolutionCompositorFrameMs'),
    firstEncodedFrameMs: lastDefined(measured, 'firstEncodedFrameMs'),
    micCapturedFrames: lastDefined(measured, 'micCapturedFrames'),
    micDroppedFrames: maxOf(measured.map((s) => s.micDroppedFrames ?? 0)) ?? 0,
    minMicCaptureCoverage: minOf(collect('micCaptureCoverage')),
    previewRepeatedFrames: maxOf(measured.map((s) => s.previewRepeatedFrames ?? 0)) ?? 0,
    previewDroppedFrames:
      maxOf([
        ...measured.map((s) => s.previewDroppedFrames ?? 0),
        ...surfaceSamples.map((s) => s.droppedFrames ?? 0),
      ]) ?? 0,
    minPreviewPresentFps: previewDirectMeasuredFps ?? passivePreviewPresentFps,
    previewInputToPresentLatencyMs,
    previewInputToPresentLatencyP95Ms,
    previewInputToPresentLatencyP99Ms,
    previewIntervalP95Ms: previewDirectIntervalP95Ms ?? passivePreviewIntervalP95Ms,
    previewDirectMeasuredFps,
    previewDirectIntervalP95Ms,
    previewDirectInputToPresentP95Ms,
    previewDirectInputToPresentP99Ms,
    previewDirectCompositorFrameLag,
    previewDirectBlankFrames: num(previewMeasurement?.blankFrames) ?? 0,
    nativePreviewRendererPollIntervalP95Ms,
    nativePreviewRendererPollRoundTripP95Ms,
    nativePreviewRendererPresentRoundTripP95Ms,
    nativePreviewRendererPollInFlightSkips,
    nativePreviewMainQueueWaitP95Ms,
    nativePreviewMainPresentP95Ms,
    nativePreviewMainQueuedBehindCount,
    nativePreviewHelperRoundTripP95Ms,
    nativePreviewMainStatusFetchP95Ms,
    nativePreviewMainStatusFetchFailures,
    nativePreviewMainStatusFetchSuccesses,
    nativePreviewMainPresentedStatusAgeMs,
    nativePreviewMainPresentedStatusAgeP95Ms,
    nativePreviewMainPresentedFrameAgeP95Ms,
    previewMeasurementError,
    previewCompositorFrameLag: maxOf([
      ...collect('previewCompositorFrameLag'),
      ...surfaceSamples.map((s) => num(s.compositorFrameLag)).filter((v) => v !== null),
    ]),
    previewCameraFrameAgeMs: maxOf(collect('previewCameraFrameAgeMs')),
    previewCameraState: lastValue('previewCameraState'),
    previewCameraDeviceUniqueId: lastValue('previewCameraDeviceUniqueId'),
    previewCameraStatusMessage: lastValue('previewCameraStatusMessage'),
    previewCameraRequestedWidth: maxOf(collect('previewCameraRequestedWidth')),
    previewCameraRequestedHeight: maxOf(collect('previewCameraRequestedHeight')),
    previewCameraActualWidth: maxOf(collect('previewCameraActualWidth')),
    previewCameraActualHeight: maxOf(collect('previewCameraActualHeight')),
    previewCameraSelectedFormatWidth: maxOf(collect('previewCameraSelectedFormatWidth')),
    previewCameraSelectedFormatHeight: maxOf(collect('previewCameraSelectedFormatHeight')),
    previewCameraSelectedFormatMinFps: maxOf(collect('previewCameraSelectedFormatMinFps')),
    previewCameraSelectedFormatMaxFps: maxOf(collect('previewCameraSelectedFormatMaxFps')),
    previewCameraCaptureGapP95Ms: maxOf(collect('previewCameraCaptureGapP95Ms')),
    previewCameraCaptureGapP99Ms: maxOf(collect('previewCameraCaptureGapP99Ms')),
    previewCameraCaptureGapMaxMs: maxOf(collect('previewCameraCaptureGapMaxMs')),
    previewCameraSamplePtsGapP95Ms: maxOf(collect('previewCameraSamplePtsGapP95Ms')),
    previewCameraSamplePtsGapP99Ms: maxOf(collect('previewCameraSamplePtsGapP99Ms')),
    previewCameraSamplePtsGapMaxMs: maxOf(collect('previewCameraSamplePtsGapMaxMs')),
    previewCameraPixelBufferLockP95Ms: maxOf(collect('previewCameraPixelBufferLockP95Ms')),
    previewCameraRowCopyP95Ms: maxOf(collect('previewCameraRowCopyP95Ms')),
    previewCameraPublishP95Ms: maxOf(collect('previewCameraPublishP95Ms')),
    previewCameraFrameBytes: maxOf(collect('previewCameraFrameBytes')) ?? 0,
    previewCameraCapabilityDeviceId: lastValue('previewCameraCapabilityDeviceId'),
    previewCameraCapabilityFormats: lastValue('previewCameraCapabilityFormats') ?? [],
    previewCameraCapabilityError: lastValue('previewCameraCapabilityError'),
    previewScreenMessage: lastValue('previewScreenMessage') ?? lastSnapshotValue(snapshots.map((s) => s.screen), 'message'),
    previewScreenFrameAgeMs: maxOf(collect('previewScreenFrameAgeMs')),
    previewScreenNativeWidth: maxOf(collect('previewScreenNativeWidth')),
    previewScreenNativeHeight: maxOf(collect('previewScreenNativeHeight')),
    previewScreenRequestedWidth: maxOf(collect('previewScreenRequestedWidth')),
    previewScreenRequestedHeight: maxOf(collect('previewScreenRequestedHeight')),
    previewScreenActualWidth: maxOf(collect('previewScreenActualWidth')),
    previewScreenActualHeight: maxOf(collect('previewScreenActualHeight')),
    previewScreenIosurfaceAvailable: screenIosurfaceSamples.length ? anyTrue(screenIosurfaceSamples) : null,
    previewScreenCaptureGapP95Ms: maxOf(collect('previewScreenCaptureGapP95Ms')),
    previewScreenCaptureGapMaxMs: maxOf(collect('previewScreenCaptureGapMaxMs')),
    previewScreenPixelBufferLockP95Ms: maxOf(collect('previewScreenPixelBufferLockP95Ms')),
    previewScreenRowCopyP95Ms: maxOf(collect('previewScreenRowCopyP95Ms')),
    previewScreenPublishP95Ms: maxOf(collect('previewScreenPublishP95Ms')),
    previewScreenFrameBytes: maxOf(collect('previewScreenFrameBytes')) ?? 0,
    previewScreenCaptureQueueDepth: maxOf(collect('previewScreenCaptureQueueDepth')) ?? 0,
    compositorRepeatedFrames: maxOf(compositorSamples.map((s) => s.repeatedFrames ?? 0)) ?? 0,
    compositorDroppedFrames: maxOf(compositorSamples.map((s) => s.droppedFrames ?? 0)) ?? 0,
    compositorFrameAgeMs: maxOf(compositorSamples.map((s) => num(s.frameAgeMs)).filter((v) => v !== null)),
    compositorFrameTimeP95Ms: maxOf(compositorSamples.map((s) => num(s.frameTimeP95Ms)).filter((v) => v !== null)),
    compositorSourceFetchP95Ms: maxOf(collect('compositorSourceFetchP95Ms')),
    compositorSceneSnapshotP95Ms: maxOf(collect('compositorSceneSnapshotP95Ms')),
    compositorCameraFrameFetchP95Ms: maxOf(collect('compositorCameraFrameFetchP95Ms')),
    compositorScreenFrameFetchP95Ms: maxOf(collect('compositorScreenFrameFetchP95Ms')),
    compositorGpuPrepareP95Ms: maxOf(collect('compositorGpuPrepareP95Ms')),
    compositorGpuSourceTextureP95Ms: maxOf(collect('compositorGpuSourceTextureP95Ms')),
    compositorSourceIosurfaceImportFrames:
      maxOf(measured.map((s) => s.compositorSourceIosurfaceImportFrames ?? 0)) ?? 0,
    compositorSourceCvpixelbufferImportFrames:
      maxOf(measured.map((s) => s.compositorSourceCvpixelbufferImportFrames ?? 0)) ?? 0,
    compositorSourceByteUploadFrames:
      maxOf(measured.map((s) => s.compositorSourceByteUploadFrames ?? 0)) ?? 0,
    compositorSourceImportFailures:
      maxOf(measured.map((s) => s.compositorSourceImportFailures ?? 0)) ?? 0,
    compositorCameraSourceIosurfaceImportFrames:
      maxOf(measured.map((s) => s.compositorCameraSourceIosurfaceImportFrames ?? 0)) ?? 0,
    compositorCameraSourceCvpixelbufferImportFrames:
      maxOf(measured.map((s) => s.compositorCameraSourceCvpixelbufferImportFrames ?? 0)) ?? 0,
    compositorCameraSourceByteUploadFrames:
      maxOf(measured.map((s) => s.compositorCameraSourceByteUploadFrames ?? 0)) ?? 0,
    compositorCameraSourceImportFailures:
      maxOf(measured.map((s) => s.compositorCameraSourceImportFailures ?? 0)) ?? 0,
    compositorScreenSourceIosurfaceImportFrames:
      maxOf(measured.map((s) => s.compositorScreenSourceIosurfaceImportFrames ?? 0)) ?? 0,
    compositorScreenSourceCvpixelbufferImportFrames:
      maxOf(measured.map((s) => s.compositorScreenSourceCvpixelbufferImportFrames ?? 0)) ?? 0,
    compositorScreenSourceByteUploadFrames:
      maxOf(measured.map((s) => s.compositorScreenSourceByteUploadFrames ?? 0)) ?? 0,
    compositorScreenSourceImportFailures:
      maxOf(measured.map((s) => s.compositorScreenSourceImportFailures ?? 0)) ?? 0,
    compositorSourceImportP95Ms: maxOf(collect('compositorSourceImportP95Ms')),
    compositorGpuCommandWaitP95Ms: maxOf(collect('compositorGpuCommandWaitP95Ms')),
    compositorGpuTotalP95Ms: maxOf(collect('compositorGpuTotalP95Ms')),
    compositorFrameStorePublishP95Ms: maxOf(collect('compositorFrameStorePublishP95Ms')),
    compositorTickGapP95Ms: maxOf(collect('compositorTickGapP95Ms')),
    compositorTickGapMaxMs: maxOf(collect('compositorTickGapMaxMs')),
    compositorLiveSourceRefreshP95Ms: maxOf(collect('compositorLiveSourceRefreshP95Ms')),
    compositorPreviewSurfaceProgressP95Ms: maxOf(collect('compositorPreviewSurfaceProgressP95Ms')),
    compositorStatusProgressP95Ms: maxOf(collect('compositorStatusProgressP95Ms')),
    compositorPreviewSurfaceLockContentions:
      maxOf(measured.map((s) => s.compositorPreviewSurfaceLockContentions ?? 0)) ?? 0,
    compositorStatusLockContentions:
      maxOf(measured.map((s) => s.compositorStatusLockContentions ?? 0)) ?? 0,
    compositorCameraSourceTryLockMisses:
      maxOf(measured.map((s) => s.compositorCameraSourceTryLockMisses ?? 0)) ?? 0,
    compositorScreenSourceTryLockMisses:
      maxOf(measured.map((s) => s.compositorScreenSourceTryLockMisses ?? 0)) ?? 0,
    compositorCameraSourceBlockingRefreshes:
      maxOf(measured.map((s) => s.compositorCameraSourceBlockingRefreshes ?? 0)) ?? 0,
    compositorScreenSourceBlockingRefreshes:
      maxOf(measured.map((s) => s.compositorScreenSourceBlockingRefreshes ?? 0)) ?? 0,
    maxBackendRssBytes: maxOf(rss),
    maxActiveFfmpegProcesses: maxOf(ffmpegProcs) ?? 0,
    maxActiveFfprobeProcesses: maxOf(ffprobeProcs) ?? 0,
    maintenanceSamples: measured.filter((s) => s.ffmpegMaintenanceRunning).length,
    duplicateCaptureSamples: measured.filter(
      (s) => Array.isArray(s.duplicateCaptureSources) && s.duplicateCaptureSources.length > 0
    ).length,
    mediaDimensions: summarizeMediaDimensions(snapshots),
    imagePollDuringSession,
    transports: [...transports],
    surfaceBackings: [...surfaceBackings],
    bottlenecks: [...bottlenecks],
  }
}

function summarizeMediaDimensions(snapshots) {
  const compositorSamples = snapshots.map((s) => s.compositor).filter(Boolean)
  const surfaceSamples = snapshots.map((s) => s.surface).filter(Boolean)
  const cameraStatusSamples = snapshots.map((s) => s.camera).filter(Boolean)
  const screenStatusSamples = snapshots.map((s) => s.screen).filter(Boolean)
  const compositorSourceSamples = compositorSamples.flatMap((s) => s.sources ?? [])

  return {
    requestedOutput: requestedOutputSettings(),
    cameraSource: summarizeDimensionSamples(cameraStatusSamples, {
      idKeys: ['cameraId', 'deviceUniqueId'],
      fpsKeys: ['sourceFps', 'targetFps'],
      stateKey: 'state',
    }),
    screenSource: summarizeDimensionSamples(screenStatusSamples, {
      idKeys: ['sourceId'],
      fpsKeys: ['sourceFps', 'targetFps'],
      stateKey: 'state',
    }),
    screenSourceNative: summarizeDimensionSamples(remapDimensionSamples(screenStatusSamples, 'nativeWidth', 'nativeHeight'), {
      idKeys: ['sourceId'],
      fpsKeys: ['sourceFps', 'targetFps'],
      stateKey: 'state',
    }),
    screenSourceRequested: summarizeDimensionSamples(remapDimensionSamples(screenStatusSamples, 'requestedWidth', 'requestedHeight'), {
      idKeys: ['sourceId'],
      fpsKeys: ['sourceFps', 'targetFps'],
      stateKey: 'state',
    }),
    screenSourceActual: summarizeDimensionSamples(remapDimensionSamples(screenStatusSamples, 'actualWidth', 'actualHeight'), {
      idKeys: ['sourceId'],
      fpsKeys: ['sourceFps', 'targetFps'],
      stateKey: 'state',
    }),
    compositorTarget: summarizeDimensionSamples(compositorSamples, {
      fpsKeys: ['targetFps', 'renderFps'],
      stateKey: 'state',
    }),
    compositorMetalTarget: summarizeDimensionSamples(
      compositorSamples.map((s) => ({
        width: s.metalTargetWidth,
        height: s.metalTargetHeight,
        state: s.state,
        targetFps: s.targetFps,
      })),
      { fpsKeys: ['targetFps'], stateKey: 'state' }
    ),
    compositorCameraSource: summarizeDimensionSamples(
      compositorSourceSamples.filter((s) => s.kind === 'camera'),
      { idKeys: ['sourceId'], fpsKeys: ['sourceFps'], stateKey: 'state' }
    ),
    compositorScreenSource: summarizeDimensionSamples(
      compositorSourceSamples.filter((s) => s.kind === 'screen'),
      { idKeys: ['sourceId'], fpsKeys: ['sourceFps'], stateKey: 'state' }
    ),
    previewDrawable: summarizeDimensionSamples(surfaceSamples, {
      fpsKeys: ['targetFps', 'presentFps'],
      stateKey: 'state',
      bounds: summarizeSurfaceBounds(surfaceSamples),
    }),
  }
}

function remapDimensionSamples(samples, widthKey, heightKey) {
  return samples.map((sample) => ({
    ...sample,
    width: sample?.[widthKey],
    height: sample?.[heightKey],
  }))
}

function summarizeDimensionSamples(samples, options = {}) {
  const dimensions = []
  for (const sample of samples) {
    const width = finiteNumber(sample?.width)
    const height = finiteNumber(sample?.height)
    if (width !== null && height !== null) {
      dimensions.push({ width, height })
    }
  }
  const latest = dimensions[dimensions.length - 1] ?? null
  const max = dimensions.reduce((best, current) => {
    if (!best) return current
    return current.width * current.height > best.width * best.height ? current : best
  }, null)
  const observed = [...new Set(dimensions.map((d) => `${Math.round(d.width)}x${Math.round(d.height)}`))]
  const ids = uniqueValues(samples, options.idKeys ?? [])
  const states = options.stateKey ? uniqueValues(samples, [options.stateKey]) : []
  const fps = collectFinite(samples, options.fpsKeys ?? [])

  return {
    latest,
    max,
    observed,
    ids,
    states,
    fpsMin: fps.length ? Math.min(...fps) : null,
    fpsMax: fps.length ? Math.max(...fps) : null,
    sampleCount: samples.length,
    bounds: options.bounds ?? null,
  }
}

function summarizeSurfaceBounds(samples) {
  const boundsSamples = samples.map((sample) => sample.bounds).filter(Boolean)
  const latest = boundsSamples[boundsSamples.length - 1] ?? null
  if (!latest) return null
  const scale = finiteNumber(latest.scaleFactor) ?? 1
  return {
    css: {
      width: finiteNumber(latest.width),
      height: finiteNumber(latest.height),
    },
    drawable: {
      width: finiteNumber(latest.width) != null ? finiteNumber(latest.width) * scale : null,
      height: finiteNumber(latest.height) != null ? finiteNumber(latest.height) * scale : null,
    },
    scaleFactor: scale,
  }
}

function uniqueValues(samples, keys) {
  const values = []
  for (const sample of samples) {
    for (const key of keys) {
      const value = sample?.[key]
      if (value !== undefined && value !== null && value !== '') values.push(String(value))
    }
  }
  return [...new Set(values)]
}

function collectFinite(samples, keys) {
  const values = []
  for (const sample of samples) {
    for (const key of keys) {
      const value = finiteNumber(sample?.[key])
      if (value !== null) values.push(value)
    }
  }
  return values
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// --- Report -----------------------------------------------------------------

function writeBaselineReport(
  outputPath,
  {
    sources,
    previewTransport,
    size,
    diagnostics,
    report,
    startupReport,
    startupPaths,
    acceptance,
    ownership,
    qualityMode,
    previewSurfaceOutputFailures = [],
  }
) {
  const base = outputPath.split('/').pop().replace(/\.[^.]+$/, '')
  const reportPath = join(dirname(outputPath), `${base}.baseline.md`)
  const m = report.metrics
  const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'n/a')
  const fmtMs = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(d)}ms` : 'n/a')
  const mib = (v) => (typeof v === 'number' ? `${(v / (1024 * 1024)).toFixed(1)} MiB` : 'n/a')

  const lines = []
  lines.push('# Real-Source Baseline Report')
  lines.push('')
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Platform: ${process.platform}`)
  lines.push(`- Recording: \`${outputPath}\` (${(size / (1024 * 1024)).toFixed(1)} MiB)`)
  lines.push(`- Evidence manifest: \`${evidenceManifestPathForOutput(outputPath)}\``)
  lines.push(`- Latest evidence copy: \`${latestEvidenceManifestPath()}\``)
  lines.push(`- Output: ${config.width}×${config.height} @ ${config.fps}fps, ${config.bitrateKbps}kbps, ${(config.recordingMs / 1000).toFixed(0)}s`)
  lines.push(`- Encoder bridge video output: \`${config.bridgeVideoOutput}\``)
  lines.push(`- Media quality mode: \`${qualityMode.mode}\` - ${qualityMode.label}`)
  lines.push(`- Motion required: ${config.requireMotion ? 'yes' : 'no'}${config.screenMotionStimulus ? ' (screen stimulus)' : ''}`)
  lines.push(`- Microphone sync offset: ${config.microphoneSyncOffsetMs}ms`)
  if (config.avSyncStimulus) {
    lines.push('- A/V sync stimulus: preview cadence FPS/interval gates relaxed; use the motion stimulus gate for preview smoothness.')
  }
  lines.push('')
  lines.push('## Selected real sources')
  lines.push('')
  lines.push(`- Screen: ${sources.screen ? `${sources.screen.name} \`${sources.screen.id}\`` : 'none'}`)
  lines.push(`- Camera: ${sources.camera ? `${sources.camera.name} \`${sources.camera.id}\`` : 'none'}`)
  lines.push(`- Microphone: ${sources.microphone ? `${sources.microphone.name} \`${sources.microphone.id}\`` : 'none'}`)
  lines.push(`- testPattern: false (real capture)`)
  if (config.screenMotionStimulus) {
    const stimulusWindow = motionStimulus
      ? `${motionStimulus.width}x${motionStimulus.height} @ ${motionStimulus.x},${motionStimulus.y}`
      : 'window unavailable'
    lines.push(`- screenMotionStimulus: true (${motionStimulus?.browserPath ?? 'browser'}; ${stimulusWindow})`)
  }
  if (config.avSyncStimulus) {
    const stimulusWindow = avSyncStimulus
      ? `${avSyncStimulus.width}x${avSyncStimulus.height} @ ${avSyncStimulus.x},${avSyncStimulus.y}`
      : 'window unavailable'
    lines.push(`- avSyncStimulus: true (${avSyncStimulus?.browserPath ?? 'browser'}; ${stimulusWindow})`)
  }
  lines.push('')
  lines.push('## Final-file verdict (honest analyzer)')
  lines.push('')
  lines.push(`**${report.verdict.pass ? 'PASS' : 'FAIL'}**`)
  if (report.verdict.failures.length) {
    lines.push('')
    for (const f of report.verdict.failures) lines.push(`- ❌ ${f}`)
  }
  if (report.verdict.warnings.length) {
    lines.push('')
    for (const w of report.verdict.warnings) lines.push(`- ⚠️ ${w}`)
  }
  lines.push('')
  lines.push('### Final-file metrics')
  lines.push('')
  lines.push(`- Codec/encoder: ${m.codec ?? 'n/a'} / ${m.encoderTag ?? 'n/a'} (${m.width}×${m.height} ${m.pixFmt ?? ''})`.trim())
  lines.push(`- Frames: observed ${m.observedFrames ?? 'n/a'} vs expected ~${m.expectedFrames ?? 'n/a'} | observed fps ${fmt(m.observedFps, 2)}`)
  lines.push(`- Frame pacing: mean ${fmt(m.meanIntervalMs)}ms | max gap ${fmt(m.maxFrameGapMs)}ms | jitter ${fmt(m.frameJitterMs)}ms`)
  lines.push(`- Freeze: longest ${fmt(m.longestFreezeMs)}ms / ${m.freezeCount} segment(s)`)
  lines.push(`- Repeated frames: max run ${m.maxRepeatedFrameRun ?? 'n/a'} / ${m.repeatedBurstCount} burst(s)`)
  lines.push(`- Audio gaps: max ${fmt(m.maxAudioGapMs)}ms / ${m.audioGapCount ?? 0} | silence longest ${fmt(m.longestSilenceMs)}ms`)
  lines.push(`- A/V skew: ${m.avSkewMs == null ? 'n/a' : `${fmt(m.avSkewMs)}ms`}`)
  lines.push('')
  if (startupReport) {
    const s = startupReport.metrics
    lines.push('## Startup-resolution verdict (first 2 seconds)')
    lines.push('')
    lines.push(`**${startupReport.verdict.pass ? 'PASS' : 'FAIL'}**`)
    if (startupReport.verdict.failures.length) {
      lines.push('')
      for (const f of startupReport.verdict.failures) lines.push(`- FAIL: ${f}`)
    }
    if (startupReport.verdict.warnings.length) {
      lines.push('')
      for (const w of startupReport.verdict.warnings) lines.push(`- WARN: ${w}`)
    }
    lines.push('')
    lines.push(`- Report: \`${startupPaths?.mdPath ?? 'n/a'}\``)
    if (startupPaths?.thumbnailPath) lines.push(`- Thumbnail sheet: \`${startupPaths.thumbnailPath}\``)
    lines.push(`- Metadata resolution: ${s.metadataWidth ?? 'n/a'}x${s.metadataHeight ?? 'n/a'} | expected ${s.expectedWidth ?? 'n/a'}x${s.expectedHeight ?? 'n/a'}`)
    lines.push(`- Startup frames: decoded ${s.startupFrameCount} | expected ~${s.expectedStartupFrames ?? 'n/a'} | hashes ${s.hashCount}`)
    lines.push(`- Dimension mismatches: ${s.dimensionMismatchCount} | preview-sized frames: ${s.previewSizedFrameCount}`)
    lines.push(`- Repeated frames: max run ${s.maxRepeatedFrameRun ?? 'n/a'} / ${s.repeatedBurstCount} burst(s)`)
    lines.push(`- Near-black frames: ${s.blackFrameCount} | letterbox/pillarbox candidates: ${s.letterboxCandidateCount}`)
    lines.push(`- Synthetic evidence: ${s.syntheticEvidence == null ? 'not available' : `${s.syntheticEvidence} diagnostic frame(s)`}`)
    lines.push('')
  }
  append4kMediaPathEvidence(lines, {
    sources,
    diagnostics,
    report,
    startupReport,
  })
  lines.push('## Media quality mode')
  lines.push('')
  lines.push(`- Mode: \`${qualityMode.mode}\` - ${qualityMode.description}`)
  lines.push(`- Acceptance gate: ${acceptance?.pass ? 'PASS' : 'FAIL'}`)
  if (qualityMode.reasons.length) {
    for (const reason of qualityMode.reasons) lines.push(`- Evidence: ${reason}`)
  }
  lines.push('- Scope: diagnostics/reporting vocabulary only. UI health remains Ready/Live/Degraded/Blocked until a later native-preview UI slice promotes this mode.')
  lines.push('')
  lines.push('## Live diagnostics during recording')
  lines.push('')
  lines.push(`- Preview transport(s) reported: ${diagnostics.transports.join(', ') || 'unknown'} (baseline preview request said: ${previewTransport})`)
  lines.push(
    `- Preview surface backing(s) reported: ${diagnostics.surfaceBackings.join(', ') || 'unknown'} ` +
      `(strict OBS backing: ${diagnostics.previewSurfaceBacking ?? 'unknown'})`
  )
  {
    const p = diagnostics.imagePollDuringSession
    const honest = p.total === 0 ? '✅ none (consistent with native)' : `⚠️ ${p.total} image-poll request(s) during session — NOT native`
    lines.push(
      `- Transport honesty — image-poll requests during session: ${honest} ` +
        `(camera.png ${p.cameraPng ?? 'n/a'}, screen.png ${p.screenPng ?? 'n/a'}, live.jpg ${p.liveJpeg ?? 'n/a'}, live.mjpeg ${p.liveMjpeg ?? 'n/a'})`
    )
  }
  lines.push(`- Bottlenecks observed: ${diagnostics.bottlenecks.join(', ') || 'none'}`)
  lines.push(`- Encode backend (requested): ${diagnostics.encodeBackend ?? 'unknown'}`)
  lines.push(
    `- Compositor backend: ${diagnostics.compositorBackend ?? 'unknown'} | CPU fallback frames ${diagnostics.compositorCpuFallbackFrames}` +
      (diagnostics.compositorFallbackReason ? ` | reason: ${diagnostics.compositorFallbackReason}` : '')
  )
  lines.push(`- Encoder: min speed ${fmt(diagnostics.minEncoderSpeed, 2)}x | dropped ${diagnostics.droppedFrames}`)
  lines.push(`- Recording bridge — repeated-fed ${diagnostics.encoderBridgeRepeatedFrames} (${diagnostics.encoderBridgeRepeatedFrameBursts} burst(s), max run ${diagnostics.encoderBridgeMaxRepeatedFrameRun}) | synthetic-filler ${diagnostics.encoderBridgeSyntheticFrames} | source→encode age p95/max ${fmt(diagnostics.encoderBridgeSourceAgeP95Ms)}/${fmt(diagnostics.encoderBridgeSourceAgeMs, 0)}ms | repeat age p95/max ${fmt(diagnostics.encoderBridgeRepeatedFrameAgeP95Ms)}/${fmt(diagnostics.encoderBridgeRepeatedFrameAgeMaxMs, 0)}ms | Metal targets ${diagnostics.encoderBridgeMetalTargetFrames} | Metal handles ${diagnostics.encoderBridgeMetalTargetHandleFrames} | raw copied ${diagnostics.encoderBridgeRawVideoCopiedFrames} | Metal copied ${diagnostics.encoderBridgeMetalTargetCopiedFrames} | zero-copy ${diagnostics.encoderBridgeZeroCopyFrames} | VT output ${diagnostics.encoderBridgeVideoToolboxOutputFrames} (${diagnostics.encoderBridgeVideoToolboxOutputBytes} bytes, ${diagnostics.encoderBridgeVideoToolboxOutputEncodeMs}ms max encode) | split encoders ${diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders} (separate ${formatBoolean(diagnostics.encoderBridgeSeparateOutputEncodersActive)}, record ${diagnostics.encoderBridgeRecordingVideoToolboxOutputFrames}/${diagnostics.encoderBridgeRecordingVideoToolboxOutputBytes} bytes, stream ${diagnostics.encoderBridgeStreamVideoToolboxOutputFrames}/${diagnostics.encoderBridgeStreamVideoToolboxOutputBytes} bytes) | VT probe ${diagnostics.encoderBridgeVideoToolboxProbeFrames} (${diagnostics.encoderBridgeVideoToolboxProbeBytes} bytes, ${diagnostics.encoderBridgeVideoToolboxProbeErrors} errors)`)
  lines.push(
    `- Recording bridge timings p95: compositor wait ${fmt(diagnostics.encoderBridgeCompositorWaitP95Ms)}ms | ` +
      `VT submit ${fmt(diagnostics.encoderBridgeVideoToolboxSubmitP95Ms)}ms | ` +
      `H.264 FIFO write ${fmt(diagnostics.encoderBridgeVideoToolboxFifoWriteP95Ms)}ms | ` +
      `writer total ${fmt(diagnostics.encoderBridgeWriterLoopP95Ms)}ms | ` +
      `writer sleep/active ${fmt(diagnostics.encoderBridgeWriterSleepP95Ms)}/${fmt(diagnostics.encoderBridgeWriterActiveP95Ms)}ms | ` +
      `deadline lag p95/max ${fmt(diagnostics.encoderBridgeDeadlineLagP95Ms)}/${fmt(diagnostics.encoderBridgeDeadlineLagMaxMs)}ms (${diagnostics.encoderBridgeLateDeadlineTicks} late tick(s))`
  )
  lines.push(
    `- Startup barrier: ${diagnostics.recordingStartupBarrierState ?? 'unknown'} | wait ${fmt(diagnostics.recordingStartupBarrierWaitMs, 0)}ms | ` +
      `first source ${fmt(diagnostics.firstSourceFrameMs, 0)}ms | full-res compositor ${fmt(diagnostics.firstFullResolutionCompositorFrameMs, 0)}ms | encoding ${fmt(diagnostics.firstEncodedFrameMs, 0)}ms`
  )
  if (diagnostics.recordingStartupBarrierTimeoutReason) {
    lines.push(`- Startup barrier timeout reason: ${diagnostics.recordingStartupBarrierTimeoutReason}`)
  }
  lines.push(`- Capture/render fps (min): ${fmt(diagnostics.minCaptureFps, 1)} / ${fmt(diagnostics.minRenderFps, 1)}`)
  lines.push(
    `- Mic: captured ${diagnostics.micCapturedFrames ?? 'n/a'} | dropped ${diagnostics.micDroppedFrames} | min capture coverage ${fmt(diagnostics.minMicCaptureCoverage, 2)} (1.0 = no gaps)`
  )
  lines.push(
    `- Preview present: min fps ${fmt(diagnostics.minPreviewPresentFps, 1)} | source-to-present max ${fmt(diagnostics.previewInputToPresentLatencyMs, 0)}ms ` +
      `(p95 ${fmt(diagnostics.previewInputToPresentLatencyP95Ms, 0)}ms / p99 ${fmt(diagnostics.previewInputToPresentLatencyP99Ms, 0)}ms) | interval p95 max ${fmt(diagnostics.previewIntervalP95Ms)}ms`
  )
  lines.push(
    `- Native preview handoff timings p95: renderer poll interval ${fmtMs(diagnostics.nativePreviewRendererPollIntervalP95Ms)} | ` +
      `renderer poll RTT ${fmtMs(diagnostics.nativePreviewRendererPollRoundTripP95Ms)} | ` +
      `renderer present RTT ${fmtMs(diagnostics.nativePreviewRendererPresentRoundTripP95Ms)} | ` +
      `main queue wait ${fmtMs(diagnostics.nativePreviewMainQueueWaitP95Ms)} | ` +
      `main present ${fmtMs(diagnostics.nativePreviewMainPresentP95Ms)} | ` +
      `helper RTT ${fmtMs(diagnostics.nativePreviewHelperRoundTripP95Ms)} | ` +
      `renderer poll in-flight skips ${diagnostics.nativePreviewRendererPollInFlightSkips} | ` +
      `main queued-behind ${diagnostics.nativePreviewMainQueuedBehindCount}`
  )
  lines.push(
    `- Native preview status refresh: fetch p95 ${fmtMs(diagnostics.nativePreviewMainStatusFetchP95Ms)} | ` +
      `success/fail ${diagnostics.nativePreviewMainStatusFetchSuccesses}/${diagnostics.nativePreviewMainStatusFetchFailures} | ` +
      `presented status age current/p95 ${fmtMs(diagnostics.nativePreviewMainPresentedStatusAgeMs)}/${fmtMs(diagnostics.nativePreviewMainPresentedStatusAgeP95Ms)} | ` +
      `presented frame age p95 ${fmtMs(diagnostics.nativePreviewMainPresentedFrameAgeP95Ms)}`
  )
  if (diagnostics.previewMeasurementError) {
    lines.push(`- Native preview direct measurement: failed (${diagnostics.previewMeasurementError})`)
  } else if (diagnostics.previewDirectMeasuredFps != null) {
    lines.push(
      `- Native preview direct measurement: ${fmt(diagnostics.previewDirectMeasuredFps, 1)}fps | ` +
        `interval p95 ${fmt(diagnostics.previewDirectIntervalP95Ms)}ms | ` +
        `source-to-present p95/p99 ${fmt(diagnostics.previewDirectInputToPresentP95Ms, 0)}/${fmt(diagnostics.previewDirectInputToPresentP99Ms, 0)}ms | ` +
        `compositor lag ${fmt(diagnostics.previewDirectCompositorFrameLag, 0)} | blanks ${diagnostics.previewDirectBlankFrames}`
    )
  }
  lines.push(`- Preview frame lag/dropped frames: ${fmt(diagnostics.previewCompositorFrameLag, 0)} / ${diagnostics.previewDroppedFrames}`)
  lines.push(
    `- Preview source pixels: ${diagnostics.previewSourcePixelsPresent ? 'present' : 'not proven'} | frame polling suppressed during run: ${diagnostics.previewFramePollingSuppressed ? 'yes' : 'no'}`
  )
  lines.push(`- Preview host commands pending: ${diagnostics.previewPendingHostCommandCount}`)
  lines.push(`- Preview repeated frames: ${diagnostics.previewRepeatedFrames}`)
  lines.push(`- Source frame age (max): camera ${fmt(diagnostics.previewCameraFrameAgeMs, 0)}ms | screen ${fmt(diagnostics.previewScreenFrameAgeMs, 0)}ms`)
  lines.push(
    `- Camera capture cadence: callback gap p95 ${fmt(diagnostics.previewCameraCaptureGapP95Ms)}ms / max ${fmt(diagnostics.previewCameraCaptureGapMaxMs)}ms | ` +
      `sample PTS gap p95 ${fmt(diagnostics.previewCameraSamplePtsGapP95Ms)}ms / max ${fmt(diagnostics.previewCameraSamplePtsGapMaxMs)}ms | ` +
      `lock ${fmt(diagnostics.previewCameraPixelBufferLockP95Ms)}ms | copy ${fmt(diagnostics.previewCameraRowCopyP95Ms)}ms | publish ${fmt(diagnostics.previewCameraPublishP95Ms)}ms | ` +
      `frame ${diagnostics.previewCameraFrameBytes} bytes`
  )
  lines.push(
    `- Screen capture cadence: callback gap p95 ${fmt(diagnostics.previewScreenCaptureGapP95Ms)}ms / max ${fmt(diagnostics.previewScreenCaptureGapMaxMs)}ms | ` +
      `lock ${fmt(diagnostics.previewScreenPixelBufferLockP95Ms)}ms | copy ${fmt(diagnostics.previewScreenRowCopyP95Ms)}ms | publish ${fmt(diagnostics.previewScreenPublishP95Ms)}ms | ` +
      `frame ${diagnostics.previewScreenFrameBytes} bytes | SCK queue depth ${diagnostics.previewScreenCaptureQueueDepth}`
  )
  lines.push(
    `- Compositor: repeated ${diagnostics.compositorRepeatedFrames} | dropped ${diagnostics.compositorDroppedFrames} | ` +
      `frame age max ${fmt(diagnostics.compositorFrameAgeMs, 0)}ms | frame time p95 ${fmt(diagnostics.compositorFrameTimeP95Ms)}ms | ` +
      `tick gap p95 ${fmt(diagnostics.compositorTickGapP95Ms)}ms / max ${fmt(diagnostics.compositorTickGapMaxMs)}ms`
  )
  lines.push(
    `- Compositor breakdown p95: source fetch ${fmt(diagnostics.compositorSourceFetchP95Ms)}ms ` +
      `(scene ${fmt(diagnostics.compositorSceneSnapshotP95Ms)}ms, camera ${fmt(diagnostics.compositorCameraFrameFetchP95Ms)}ms, screen ${fmt(diagnostics.compositorScreenFrameFetchP95Ms)}ms) | ` +
      `prepare ${fmt(diagnostics.compositorGpuPrepareP95Ms)}ms | source texture ${fmt(diagnostics.compositorGpuSourceTextureP95Ms)}ms | source import ${fmt(diagnostics.compositorSourceImportP95Ms)}ms | ` +
      `command wait ${fmt(diagnostics.compositorGpuCommandWaitP95Ms)}ms | Metal total ${fmt(diagnostics.compositorGpuTotalP95Ms)}ms | ` +
      `frame-store publish ${fmt(diagnostics.compositorFrameStorePublishP95Ms)}ms`
  )
  lines.push(
    `- Compositor outside-render p95: source refresh ${fmt(diagnostics.compositorLiveSourceRefreshP95Ms)}ms | ` +
      `surface progress ${fmt(diagnostics.compositorPreviewSurfaceProgressP95Ms)}ms (${diagnostics.compositorPreviewSurfaceLockContentions} lock skips) | ` +
      `status progress ${fmt(diagnostics.compositorStatusProgressP95Ms)}ms (${diagnostics.compositorStatusLockContentions} lock skips)`
  )
  lines.push(
    `- Compositor source freshness: camera try-lock misses ${diagnostics.compositorCameraSourceTryLockMisses} / blocking refreshes ${diagnostics.compositorCameraSourceBlockingRefreshes} | ` +
      `screen try-lock misses ${diagnostics.compositorScreenSourceTryLockMisses} / blocking refreshes ${diagnostics.compositorScreenSourceBlockingRefreshes}`
  )
  lines.push(`- Backend RSS max: ${mib(diagnostics.maxBackendRssBytes)} | ffmpeg procs ${diagnostics.maxActiveFfmpegProcesses} | ffprobe procs ${diagnostics.maxActiveFfprobeProcesses}`)
  lines.push(`- Maintenance overlap samples: ${diagnostics.maintenanceSamples} | duplicate-capture samples: ${diagnostics.duplicateCaptureSamples}`)
  if (previewSurfaceOutputFailures.length) {
    lines.push('')
    lines.push('## Preview Surface Host Output Guard')
    lines.push('')
    lines.push('**FAIL**')
    for (const failure of previewSurfaceOutputFailures) {
      lines.push(`- ${failure}`)
    }
  }
  lines.push('## Problem ownership triage')
  lines.push('')
  if (ownership?.length) {
    for (const item of ownership) {
      lines.push(`### ${item.area}`)
      lines.push('')
      lines.push(`- Status: ${item.status}`)
      lines.push(`- Owner: ${item.owner}`)
      lines.push(`- Evidence: ${item.evidence.length ? item.evidence.join('; ') : 'none'}`)
      lines.push(`- Next step: ${item.nextStep}`)
      lines.push('')
    }
  } else {
    lines.push('- No ownership triage was produced for this run.')
    lines.push('')
  }
  lines.push('## Honest-metric status')
  lines.push('')
  lines.push('Now measured (trust the values above):')
  lines.push('- **Compositor repeated frames** — real per-tick source-sequence diff (was structurally always 0).')
  lines.push('- **Recording repeated / synthetic-filler frames** — the encoder bridge now counts stale re-feeds and source→encode age.')
  lines.push('- **Requested encode backend** — software-x264 vs hardware-videotoolbox is recorded.')
  lines.push('- **Final-file freeze / repeated-frame bursts / pacing** — the analyzer verdict above decodes the actual artifact.')
  lines.push('- **Transport honesty** — image-poll request counts (above) reveal whether a "native" preview is really PNG/JPEG/MJPEG polling.')
  lines.push('- **Live mic capture** — dropped frames and the capture-coverage gap signal now update during the run, not only at stop.')
  if (claimsNativePreview({ previewTransport, diagnostics }) && diagnostics.previewSourcePixelsPresent) {
    lines.push('- **Native CAMetalLayer source-to-present latency** — diagnostics saw native-surface/cametal-layer presents with source-pixel proof while fallback image polling was suppressed.')
  }
  lines.push('')
  lines.push('Still NOT proven here:')
  if (!claimsNativePreview({ previewTransport, diagnostics }) || !diagnostics.previewSourcePixelsPresent) {
    lines.push('- **True CAMetalLayer source-to-present latency**: this run did not prove native-surface/cametal-layer presents with source pixels.')
  }
  lines.push('- **OBS side-by-side visual quality**: screen text sharpness, cursor edges, camera detail, crop/mirror behavior, and color still need a human comparison at the same preview size.')
  lines.push('- **Lip-sync**: A/V skew here is a container duration delta, not measured mouth/voice alignment — that needs capture-clock PTS instrumentation (the native part of slice #8). The live mic capture-coverage signal above is the honest gap indicator, since final-file audio gaps are masked by the muxer/aresample.')
  lines.push('')

  writeFileSync(reportPath, lines.join('\n'))
  return reportPath
}

function writeEvidenceManifest(
  outputPath,
  {
    sources,
    previewTransport,
    diagnostics,
    report,
    startupReport,
    analyzerPaths,
    startupPaths,
    baselinePath,
    acceptance,
    qualityMode,
    previewSurfaceOutputFailures = [],
  }
) {
  const manifestPath = evidenceManifestPathForOutput(outputPath)
  const manifest = {
    generatedAtIso: new Date().toISOString(),
    platform: process.platform,
    command: {
      argv: process.argv.slice(2),
      gate: config.gate,
    },
    request: realSourceGateRequest(),
    result: {
      blockedBeforeEncoding: false,
      acceptancePass: acceptance?.pass === true,
      acceptanceFailures: acceptance?.failures ?? [],
      finalFilePass: report?.verdict?.pass === true,
      startupPass: startupReport?.verdict?.pass === true,
      mediaQualityMode: qualityMode?.mode ?? 'unknown',
      mediaQualityLabel: qualityMode?.label ?? 'unknown',
      mediaQualityReasons: qualityMode?.reasons ?? [],
    },
    paths: {
      recording: outputPath,
      baselineReport: baselinePath,
      evidenceManifest: manifestPath,
      qualityJson: analyzerPaths?.jsonPath ?? null,
      qualityReport: analyzerPaths?.mdPath ?? null,
      startupJson: startupPaths?.jsonPath ?? null,
      startupReport: startupPaths?.mdPath ?? null,
      startupThumbnail: startupPaths?.thumbnailPath ?? null,
    },
    sources: selectedSourcesManifest(sources),
    diagnostics: gateDiagnosticsManifest(diagnostics, {
      finalMetrics: report?.metrics,
      finalFilePath: report?.file ?? outputPath,
      startupMetrics: startupReport?.metrics,
      previewTransport,
      previewSurfaceOutputFailures,
    }),
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeLatestEvidenceManifest(manifest)
  return manifestPath
}

function writeBlockedEvidenceManifest({
  sources,
  previewTransport,
  diagnostics,
  baselinePath,
  error,
  qualityMode,
  previewSurfaceOutputFailures = [],
}) {
  const manifestPath = evidenceManifestPathForReport(baselinePath)
  const manifest = {
    generatedAtIso: new Date().toISOString(),
    platform: process.platform,
    command: {
      argv: process.argv.slice(2),
      gate: config.gate,
    },
    request: realSourceGateRequest(),
    result: {
      blockedBeforeEncoding: true,
      acceptancePass: false,
      acceptanceFailures: [
        `session.start failed before encoding: ${error?.message ?? error}`,
        ...previewSurfaceOutputFailureMessages(previewSurfaceOutputFailures),
      ],
      finalFilePass: false,
      startupPass: false,
      mediaQualityMode: qualityMode?.mode ?? 'unknown',
      mediaQualityLabel: qualityMode?.label ?? 'unknown',
      mediaQualityReasons: qualityMode?.reasons ?? [],
    },
    paths: {
      recording: null,
      baselineReport: baselinePath,
      evidenceManifest: manifestPath,
      qualityJson: null,
      qualityReport: null,
      startupJson: null,
      startupReport: null,
      startupThumbnail: null,
    },
    sources: selectedSourcesManifest(sources),
    diagnostics: gateDiagnosticsManifest(diagnostics, {
      finalMetrics: null,
      startupMetrics: null,
      previewTransport,
      previewSurfaceOutputFailures,
    }),
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeLatestEvidenceManifest(manifest)
  return manifestPath
}

function evidenceManifestPathForOutput(outputPath) {
  const base = outputPath.split('/').pop().replace(/\.[^.]+$/, '')
  return join(dirname(outputPath), `${base}.evidence.json`)
}

function evidenceManifestPathForReport(reportPath) {
  return reportPath.replace(/\.md$/, '.evidence.json')
}

function latestEvidenceManifestPath() {
  return join(config.outputDirectory, 'latest-real-source-evidence.json')
}

function writeLatestEvidenceManifest(manifest) {
  writeFileSync(
    latestEvidenceManifestPath(),
    `${JSON.stringify(
      {
        ...manifest,
        latestPointer: {
          updatedAtIso: new Date().toISOString(),
          canonicalEvidenceManifest: manifest.paths?.evidenceManifest ?? null,
        },
      },
      null,
      2
    )}\n`
  )
}

function realSourceGateRequest() {
  return {
    width: config.width,
    height: config.height,
    fps: config.fps,
    bitrateKbps: config.bitrateKbps,
    recordingMs: config.recordingMs,
    bridgeVideoOutput: config.bridgeVideoOutput ?? 'backend-default',
    streamEnabled: config.streamEnabled,
    // Stream key is never written to evidence; mirror the backend's redaction shape.
    streamRedactedUrl: config.streamEnabled ? `${config.streamServerUrl.replace(/\/+$/, '')}/••••` : null,
    requireMotion: config.requireMotion,
    screenMotionStimulus: config.screenMotionStimulus,
    avSyncStimulus: config.avSyncStimulus,
    microphoneSyncOffsetMs: config.microphoneSyncOffsetMs,
    noPreviewSurface: config.noPreviewSurface,
    fallbackLivePreview: config.fallbackLivePreview,
    requestedOutput: requestedOutputSettings(),
    require4kMediaEvidence: requires4kMediaEvidence(),
  }
}

function selectedSourcesManifest(sources) {
  return {
    screen: sourceManifest(sources.screen),
    camera: sourceManifest(sources.camera),
    microphone: sourceManifest(sources.microphone),
  }
}

function sourceManifest(source) {
  if (!source) return null
  return {
    id: source.id ?? null,
    name: source.name ?? null,
    width: source.width ?? null,
    height: source.height ?? null,
  }
}

function gateDiagnosticsManifest(
  diagnostics,
  { finalMetrics, finalFilePath = null, startupMetrics, previewTransport, previewSurfaceOutputFailures = [] }
) {
  return {
    previewTransportRequested: previewTransport,
    previewTransportsObserved: diagnostics.transports,
    previewSurfaceBacking: diagnostics.previewSurfaceBacking ?? null,
    previewSurfaceBackingsObserved: diagnostics.surfaceBackings,
    imagePollDuringSession: diagnostics.imagePollDuringSession,
    previewSourcePixelsPresent: diagnostics.previewSourcePixelsPresent,
    previewFramePollingSuppressed: diagnostics.previewFramePollingSuppressed,
    previewPendingHostCommandCount: diagnostics.previewPendingHostCommandCount,
    previewInputToPresentLatencyP95Ms: diagnostics.previewInputToPresentLatencyP95Ms,
    previewInputToPresentLatencyP99Ms: diagnostics.previewInputToPresentLatencyP99Ms,
    previewIntervalP95Ms: diagnostics.previewIntervalP95Ms,
    previewCompositorFrameLag: diagnostics.previewCompositorFrameLag,
    compositorBackend: diagnostics.compositorBackend ?? null,
    compositorCpuFallbackFrames: diagnostics.compositorCpuFallbackFrames,
    mediaDimensions: diagnostics.mediaDimensions ?? null,
    previewScreenMessage: diagnostics.previewScreenMessage ?? null,
    encoderBridgeRawVideoCopiedFrames: diagnostics.encoderBridgeRawVideoCopiedFrames,
    encoderBridgeMetalTargetCopiedFrames: diagnostics.encoderBridgeMetalTargetCopiedFrames,
    encoderBridgeMetalTargetFrames: diagnostics.encoderBridgeMetalTargetFrames,
    encoderBridgeMetalTargetHandleFrames: diagnostics.encoderBridgeMetalTargetHandleFrames,
    encoderBridgeZeroCopyFrames: diagnostics.encoderBridgeZeroCopyFrames,
    encoderBridgeVideoToolboxOutputFrames: diagnostics.encoderBridgeVideoToolboxOutputFrames,
    encoderBridgeVideoToolboxOutputBytes: diagnostics.encoderBridgeVideoToolboxOutputBytes,
    recordingOutput: outputProfileFromDiagnostics(diagnostics, 'recording'),
    streamOutput: outputProfileFromDiagnostics(diagnostics, 'stream'),
    encoderBridgeActiveVideoToolboxOutputEncoders:
      diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders,
    encoderBridgeRecordingVideoToolboxOutputFrames:
      diagnostics.encoderBridgeRecordingVideoToolboxOutputFrames,
    encoderBridgeRecordingVideoToolboxOutputBytes:
      diagnostics.encoderBridgeRecordingVideoToolboxOutputBytes,
    encoderBridgeStreamVideoToolboxOutputFrames:
      diagnostics.encoderBridgeStreamVideoToolboxOutputFrames,
    encoderBridgeStreamVideoToolboxOutputBytes:
      diagnostics.encoderBridgeStreamVideoToolboxOutputBytes,
    encoderBridgeSeparateOutputEncodersActive:
      diagnostics.encoderBridgeSeparateOutputEncodersActive,
    encoderBridgeVideoToolboxProbeErrors: diagnostics.encoderBridgeVideoToolboxProbeErrors,
    encoderBridgeRepeatedFrames: diagnostics.encoderBridgeRepeatedFrames,
    encoderBridgeMaxRepeatedFrameRun: diagnostics.encoderBridgeMaxRepeatedFrameRun,
    encoderBridgeSyntheticFrames: diagnostics.encoderBridgeSyntheticFrames,
    encoderBridgeSourceAgeP95Ms: diagnostics.encoderBridgeSourceAgeP95Ms,
    micDroppedFrames: diagnostics.micDroppedFrames,
    minMicCaptureCoverage: diagnostics.minMicCaptureCoverage,
    minEncoderSpeed: diagnostics.minEncoderSpeed,
    finalFile: finalMetrics
      ? {
          path: finalFilePath,
          width: finalMetrics.width ?? null,
          height: finalMetrics.height ?? null,
          durationSeconds: finalMetrics.durationSeconds ?? null,
          observedFrames: finalMetrics.observedFrames ?? null,
          observedFps: finalMetrics.observedFps ?? null,
          maxRepeatedFrameRun: finalMetrics.maxRepeatedFrameRun ?? null,
          longestFreezeMs: finalMetrics.longestFreezeMs ?? null,
          avSkewMs: finalMetrics.avSkewMs ?? null,
        }
      : null,
    startup: startupMetrics
      ? {
          metadataWidth: startupMetrics.metadataWidth ?? null,
          metadataHeight: startupMetrics.metadataHeight ?? null,
          expectedWidth: startupMetrics.expectedWidth ?? null,
          expectedHeight: startupMetrics.expectedHeight ?? null,
          startupFrameCount: startupMetrics.startupFrameCount ?? null,
          dimensionMismatchCount: startupMetrics.dimensionMismatchCount ?? null,
          previewSizedFrameCount: startupMetrics.previewSizedFrameCount ?? null,
          maxRepeatedFrameRun: startupMetrics.maxRepeatedFrameRun ?? null,
        }
      : null,
    previewSurfaceOutputFailures,
  }
}

function append4kMediaPathEvidence(lines, { sources, diagnostics, report, startupReport, blocked = false }) {
  const media = diagnostics.mediaDimensions ?? {}
  const requested = media.requestedOutput ?? requestedOutputSettings()
  const final = report?.metrics ?? {}
  const startup = startupReport?.metrics ?? {}

  lines.push('## 4K media path evidence')
  lines.push('')
  lines.push(
    `- Requested output/encoder target: ${formatRequestedOutput(requested)}${blocked ? ' (blocked before encoding)' : ''}`
  )
  lines.push(
    `- Source selected IDs: screen ${sources.screen?.id ?? 'none'}; camera ${sources.camera?.id ?? 'none'}; microphone ${sources.microphone?.id ?? 'none'}`
  )
  lines.push(
    `- Source native/requested/actual: camera native ${formatDimensionSummary(media.cameraSource)} / requested ${formatRequestedSource(requested)} / compositor actual ${formatDimensionSummary(media.compositorCameraSource)}`
  )
  lines.push(
    `- Camera source health: state ${diagnostics.previewCameraState ?? 'n/a'} | selected ${formatDimension(diagnostics.previewCameraSelectedFormatWidth, diagnostics.previewCameraSelectedFormatHeight)} @ ${formatRange(diagnostics.previewCameraSelectedFormatMinFps, diagnostics.previewCameraSelectedFormatMaxFps)}fps | requested ${formatDimension(diagnostics.previewCameraRequestedWidth, diagnostics.previewCameraRequestedHeight)} @ ${requested.fps ?? 'n/a'}fps | actual ${formatDimension(diagnostics.previewCameraActualWidth, diagnostics.previewCameraActualHeight)} @ ${formatRange(diagnostics.previewCameraSourceFps, diagnostics.previewCameraSourceFps)}fps | dropped ${diagnostics.previewCameraDroppedFrames ?? 'n/a'}`
  )
  lines.push(
    `- Camera frame intervals: callback p95 ${formatMilliseconds(diagnostics.previewCameraCaptureGapP95Ms)} / p99 ${formatMilliseconds(diagnostics.previewCameraCaptureGapP99Ms)} / max ${formatMilliseconds(diagnostics.previewCameraCaptureGapMaxMs)} | PTS p95 ${formatMilliseconds(diagnostics.previewCameraSamplePtsGapP95Ms)} / p99 ${formatMilliseconds(diagnostics.previewCameraSamplePtsGapP99Ms)} / max ${formatMilliseconds(diagnostics.previewCameraSamplePtsGapMaxMs)} | copy lock ${formatMilliseconds(diagnostics.previewCameraPixelBufferLockP95Ms)} / rows ${formatMilliseconds(diagnostics.previewCameraRowCopyP95Ms)} / publish ${formatMilliseconds(diagnostics.previewCameraPublishP95Ms)}`
  )
  lines.push(
    `- Camera capability matrix: ${formatCameraCapabilityMatrix(diagnostics.previewCameraCapabilityFormats)}${diagnostics.previewCameraCapabilityError ? ` | error ${diagnostics.previewCameraCapabilityError}` : ''}`
  )
  lines.push(
    `- Source native/requested/actual: screen native ${formatDimensionSummary(media.screenSourceNative ?? media.screenSource)} / requested ${formatDimensionSummaryOr(media.screenSourceRequested, formatRequestedSource(requested))} / actual ${formatDimensionSummary(media.screenSourceActual ?? media.screenSource)} / compositor actual ${formatDimensionSummary(media.compositorScreenSource)}`
  )
  lines.push(
    `- Screen source health: source fps ${formatRange(media.screenSourceActual?.fpsMin, media.screenSourceActual?.fpsMax)} | dropped ${diagnostics.previewScreenDroppedFrames ?? 'n/a'} | IOSurface ${formatBoolean(diagnostics.previewScreenIosurfaceAvailable)} | SCK queue depth ${diagnostics.previewScreenCaptureQueueDepth ?? 'n/a'}${diagnostics.previewScreenMessage ? ` | message ${diagnostics.previewScreenMessage}` : ''}`
  )
  lines.push(
    `- Compositor target: ${formatDimensionSummary(media.compositorTarget)} | Metal target ${formatDimensionSummary(media.compositorMetalTarget)}`
  )
  lines.push(
    `- Preview drawable: ${formatDimensionSummary(media.previewDrawable)}${formatPreviewBoundsSuffix(media.previewDrawable)}`
  )
  lines.push(
    `- Encoder input/output dimensions: requested ${formatDimension(requested.width, requested.height)} | Metal/VT input ${formatDimensionSummary(media.compositorMetalTarget)} | final file ${formatDimension(final.width, final.height)}`
  )
  lines.push(
    `- Startup/final dimensions: startup metadata ${formatDimension(startup.metadataWidth, startup.metadataHeight)} | startup target ${formatDimension(startup.targetWidth, startup.targetHeight)} | first frame ${formatFrameDimension(startup.firstStartupFrame)} | final file ${formatDimension(final.width, final.height)}`
  )
  lines.push(
    `- Source import counters: total IOSurface ${diagnostics.compositorSourceIosurfaceImportFrames ?? 0}; CVPixelBuffer ${diagnostics.compositorSourceCvpixelbufferImportFrames ?? 0}; byte upload ${diagnostics.compositorSourceByteUploadFrames ?? 0}; failures ${diagnostics.compositorSourceImportFailures ?? 0}; import p95 ${formatMilliseconds(diagnostics.compositorSourceImportP95Ms)} | screen IOSurface ${diagnostics.compositorScreenSourceIosurfaceImportFrames ?? 0}; screen CVPixelBuffer ${diagnostics.compositorScreenSourceCvpixelbufferImportFrames ?? 0}; screen byte upload ${diagnostics.compositorScreenSourceByteUploadFrames ?? 0}; screen failures ${diagnostics.compositorScreenSourceImportFailures ?? 0} | camera IOSurface ${diagnostics.compositorCameraSourceIosurfaceImportFrames ?? 0}; camera CVPixelBuffer ${diagnostics.compositorCameraSourceCvpixelbufferImportFrames ?? 0}; camera byte upload ${diagnostics.compositorCameraSourceByteUploadFrames ?? 0}; camera failures ${diagnostics.compositorCameraSourceImportFailures ?? 0}`
  )
  lines.push(
    `- Copy/fallback counters: compositor CPU fallback ${diagnostics.compositorCpuFallbackFrames}; raw copied ${diagnostics.encoderBridgeRawVideoCopiedFrames}; Metal copied ${diagnostics.encoderBridgeMetalTargetCopiedFrames}; Metal targets ${diagnostics.encoderBridgeMetalTargetFrames}; Metal handles ${diagnostics.encoderBridgeMetalTargetHandleFrames}; zero-copy ${diagnostics.encoderBridgeZeroCopyFrames}; VT output ${diagnostics.encoderBridgeVideoToolboxOutputFrames}; VT probe ${diagnostics.encoderBridgeVideoToolboxProbeFrames}; image polls ${diagnostics.imagePollDuringSession?.total ?? 'n/a'}`
  )
  lines.push(
    `- Split output proof: recording ${formatOutputProfile(outputProfileFromDiagnostics(diagnostics, 'recording'))}; stream ${formatOutputProfile(outputProfileFromDiagnostics(diagnostics, 'stream'))}; active VT encoders ${diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders}; separate ${formatBoolean(diagnostics.encoderBridgeSeparateOutputEncodersActive)}; record frames/bytes ${diagnostics.encoderBridgeRecordingVideoToolboxOutputFrames}/${diagnostics.encoderBridgeRecordingVideoToolboxOutputBytes}; stream frames/bytes ${diagnostics.encoderBridgeStreamVideoToolboxOutputFrames}/${diagnostics.encoderBridgeStreamVideoToolboxOutputBytes}`
  )
  lines.push(
    `- Dimension triage: ${dimensionTriage({ requested, media, final, startup, blocked })}`
  )
  lines.push('')
}

function dimensionTriage({ requested, media, final, startup, blocked }) {
  if (blocked) return 'recording blocked before encoder/final-file dimensions existed'
  const problems = []
  if (dimensionBelow(media.cameraSource?.max, requested) || dimensionBelow(media.screenSource?.max, requested)) {
    problems.push('source below requested output')
  }
  if (dimensionBelow(media.compositorTarget?.max, requested)) {
    problems.push('compositor target below requested output')
  }
  if (dimensionBelow(media.compositorMetalTarget?.max, requested)) {
    problems.push('Metal target below requested output')
  }
  if (dimensionBelow(media.previewDrawable?.max, requested)) {
    problems.push('preview drawable below requested output')
  }
  if (dimensionMismatch(startup.metadataWidth, startup.metadataHeight, requested)) {
    problems.push('startup metadata mismatch')
  }
  if (dimensionMismatch(final.width, final.height, requested)) {
    problems.push('final-file mismatch')
  }
  return problems.length ? problems.join('; ') : 'no dimension mismatch detected from collected evidence'
}

function dimensionBelow(dimension, requested) {
  if (!dimension || !requested?.width || !requested?.height) return false
  return dimension.width < requested.width || dimension.height < requested.height
}

function dimensionMismatch(width, height, requested) {
  if (!requested?.width || !requested?.height) return false
  if (width == null || height == null) return false
  return width !== requested.width || height !== requested.height
}

function formatDimensionSummary(summary) {
  if (!summary || summary.sampleCount === 0) return 'not reported'
  const parts = []
  parts.push(`latest ${formatDimensionObject(summary.latest)}`)
  parts.push(`max ${formatDimensionObject(summary.max)}`)
  if (summary.observed?.length) parts.push(`observed ${summary.observed.join(', ')}`)
  if (summary.fpsMin != null || summary.fpsMax != null) {
    parts.push(`fps ${formatRange(summary.fpsMin, summary.fpsMax)}`)
  }
  if (summary.states?.length) parts.push(`state ${summary.states.join('/')}`)
  if (summary.ids?.length) parts.push(`id ${summary.ids.join(', ')}`)
  return parts.join('; ')
}

function formatDimensionSummaryOr(summary, fallback) {
  return !summary || summary.sampleCount === 0 ? fallback : formatDimensionSummary(summary)
}

function formatBoolean(value) {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : 'n/a'
}

function formatMilliseconds(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}ms` : 'n/a'
}

function formatCameraCapabilityMatrix(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return 'not reported'
  const ranked = [...formats].sort((left, right) => {
    const leftPixels = (finiteNumber(left.width) ?? 0) * (finiteNumber(left.height) ?? 0)
    const rightPixels = (finiteNumber(right.width) ?? 0) * (finiteNumber(right.height) ?? 0)
    return rightPixels - leftPixels || (finiteNumber(right.maxFps) ?? 0) - (finiteNumber(left.maxFps) ?? 0)
  })
  const examples = ranked.slice(0, 8).map((format) => {
    const minFps = finiteNumber(format.minFps)
    const maxFps = finiteNumber(format.maxFps)
    const fps = minFps === maxFps ? `${formatNumber(maxFps)}fps` : `${formatNumber(minFps)}-${formatNumber(maxFps)}fps`
    return `${formatDimension(format.width, format.height)}@${fps}`
  })
  return `${formats.length} ranges; top ${examples.join(', ')}`
}

function formatPreviewBoundsSuffix(summary) {
  const bounds = summary?.bounds
  if (!bounds) return ''
  const css = formatDimension(bounds.css?.width, bounds.css?.height)
  const drawable = formatDimension(bounds.drawable?.width, bounds.drawable?.height)
  return ` | bounds CSS ${css}, drawable ${drawable}, scale ${bounds.scaleFactor ?? 'n/a'}`
}

function formatRequestedOutput(output) {
  return `${formatDimension(output.width, output.height)} @ ${output.fps ?? 'n/a'}fps, ${output.bitrateKbps ?? 'n/a'}kbps`
}

function outputProfileFromDiagnostics(diagnostics, prefix) {
  const width = diagnostics?.[`${prefix}OutputWidth`]
  const height = diagnostics?.[`${prefix}OutputHeight`]
  const fps = diagnostics?.[`${prefix}OutputFps`]
  const bitrateKbps = diagnostics?.[`${prefix}OutputBitrateKbps`]
  if (
    typeof width !== 'number' &&
    typeof height !== 'number' &&
    typeof fps !== 'number' &&
    typeof bitrateKbps !== 'number'
  ) {
    return null
  }
  return {
    width: typeof width === 'number' ? width : null,
    height: typeof height === 'number' ? height : null,
    fps: typeof fps === 'number' ? fps : null,
    bitrateKbps: typeof bitrateKbps === 'number' ? bitrateKbps : null,
  }
}

function formatOutputProfile(profile) {
  return profile ? formatRequestedOutput(profile) : 'not reported'
}

function formatRequestedSource(output) {
  return `${formatDimension(output.width, output.height)} @ ${output.fps ?? 'n/a'}fps`
}

function formatFrameDimension(frame) {
  return frame ? formatDimension(frame.width, frame.height) : 'n/a'
}

function formatDimensionObject(dimension) {
  return dimension ? formatDimension(dimension.width, dimension.height) : 'n/a'
}

function formatDimension(width, height) {
  const w = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : null
  const h = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : null
  return w != null && h != null ? `${w}x${h}` : 'n/a'
}

function formatRange(min, max) {
  if (min == null && max == null) return 'n/a'
  if (min === max || max == null) return `${formatNumber(min)}`
  if (min == null) return `${formatNumber(max)}`
  return `${formatNumber(min)}-${formatNumber(max)}`
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(value % 1 === 0 ? 0 : 1) : 'n/a'
}

function writeBlockedStartupReport({
  sources,
  previewTransport,
  diagnostics,
  healthEvents,
  error,
  qualityMode,
  previewSurfaceOutputFailures = [],
}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = join(config.outputDirectory, `videorc-session-${stamp}.blocked-start.md`)
  const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'n/a')
  const errorMessage = error?.message ?? String(error)
  const blockedCadence = blockedStartupCameraCadence(errorMessage, healthEvents)
  const cameraCallbackP95 = fmtOrFallback(diagnostics.previewCameraCaptureGapP95Ms, blockedCadence?.callbackP95)
  const cameraSamplePtsP95 = fmtOrFallback(diagnostics.previewCameraSamplePtsGapP95Ms, blockedCadence?.samplePtsP95)
  const cameraFrameAge = fmtOrFallback(diagnostics.previewCameraFrameAgeMs, blockedCadence?.frameAge, 0)

  const lines = []
  lines.push('# Real-Source Baseline Blocked Before Encoding')
  lines.push('')
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Platform: ${process.platform}`)
  lines.push(`- Output request: ${config.width}x${config.height} @ ${config.fps}fps, ${config.bitrateKbps}kbps`)
  lines.push(`- Encoder bridge video output: \`${config.bridgeVideoOutput}\``)
  lines.push(`- Media quality mode: \`${qualityMode.mode}\` - ${qualityMode.label}`)
  lines.push('- Result: BLOCKED before encoding')
  lines.push(`- Start error: ${errorMessage}`)
  lines.push('')
  lines.push('## Selected real sources')
  lines.push('')
  lines.push(`- Screen: ${sources.screen ? `${sources.screen.name} \`${sources.screen.id}\`` : 'none'}`)
  lines.push(`- Camera: ${sources.camera ? `${sources.camera.name} \`${sources.camera.id}\`` : 'none'}`)
  lines.push(`- Microphone: ${sources.microphone ? `${sources.microphone.name} \`${sources.microphone.id}\`` : 'none'}`)
  lines.push('- testPattern: false (real capture)')
  lines.push('')
  lines.push('## Health events during start')
  lines.push('')
  if (healthEvents.length) {
    for (const event of healthEvents) {
      lines.push(`- ${event.level ?? 'unknown'} ${event.code ?? 'unknown'}: ${event.message ?? 'no message'}`)
    }
  } else {
    lines.push('- None observed on the socket before the start request failed.')
  }
  lines.push('')
  lines.push('## Live diagnostics at block')
  lines.push('')
  lines.push(`- Preview transport(s): ${diagnostics.transports.join(', ') || 'unknown'} (baseline preview request said: ${previewTransport})`)
  lines.push(
    `- Preview surface backing(s): ${diagnostics.surfaceBackings.join(', ') || 'unknown'} ` +
      `(strict backing: ${diagnostics.previewSurfaceBacking ?? 'unknown'})`
  )
  lines.push(
    `- Startup barrier: ${diagnostics.recordingStartupBarrierState ?? 'unknown'} | wait ${fmt(diagnostics.recordingStartupBarrierWaitMs, 0)}ms | ` +
      `timeout ${diagnostics.recordingStartupBarrierTimeoutReason ?? 'n/a'}`
  )
  if (blockedCadence) {
    lines.push(
      `- Startup block cadence: sample PTS p95 ${blockedCadence.samplePtsP95}, threshold ${blockedCadence.threshold}, ` +
        `callback p95 ${blockedCadence.callbackP95}, frame age ${blockedCadence.frameAge}`
    )
  }
  if (sources.camera) {
    lines.push(
      `- Camera capture cadence: callback gap p95 ${cameraCallbackP95} / max ${fmt(diagnostics.previewCameraCaptureGapMaxMs)}ms | ` +
        `sample PTS gap p95 ${cameraSamplePtsP95} / max ${fmt(diagnostics.previewCameraSamplePtsGapMaxMs)}ms | ` +
        `frame age ${cameraFrameAge} | frame ${diagnostics.previewCameraFrameBytes} bytes`
    )
  }
  if (sources.screen) {
    lines.push(
      `- Screen capture cadence: callback gap p95 ${fmt(diagnostics.previewScreenCaptureGapP95Ms)}ms / max ${fmt(diagnostics.previewScreenCaptureGapMaxMs)}ms | ` +
        `frame age ${fmt(diagnostics.previewScreenFrameAgeMs, 0)}ms | frame ${diagnostics.previewScreenFrameBytes} bytes${diagnostics.previewScreenMessage ? ` | message ${diagnostics.previewScreenMessage}` : ''}`
    )
  }
  lines.push(`- Image polls at block: ${diagnostics.imagePollDuringSession.total ?? 'n/a'}`)
  lines.push(
    `- Preview source pixels at block: ${diagnostics.previewSourcePixelsPresent ? 'present' : 'not proven'} | frame polling suppressed: ${diagnostics.previewFramePollingSuppressed ? 'yes' : 'no'}`
  )
  lines.push(`- Preview host commands pending at block: ${diagnostics.previewPendingHostCommandCount}`)
  lines.push(`- Compositor backend: ${diagnostics.compositorBackend ?? 'unknown'} | CPU fallback frames ${diagnostics.compositorCpuFallbackFrames}`)
  lines.push(`- Mic: captured ${diagnostics.micCapturedFrames ?? 'n/a'} | dropped ${diagnostics.micDroppedFrames}`)
  if (previewSurfaceOutputFailures.length) {
    lines.push('')
    lines.push('## Preview Surface Host Output Guard')
    lines.push('')
    lines.push('**FAIL**')
    for (const failure of previewSurfaceOutputFailures) {
      lines.push(`- ${failure}`)
    }
  }
  lines.push('')
  append4kMediaPathEvidence(lines, {
    sources,
    diagnostics,
    report: null,
    startupReport: null,
    blocked: true,
  })
  lines.push('## Media quality mode')
  lines.push('')
  lines.push(`- Mode: \`${qualityMode.mode}\` - ${qualityMode.description}`)
  for (const reason of qualityMode.reasons) lines.push(`- Evidence: ${reason}`)
  lines.push('- Scope: diagnostics/reporting vocabulary only. The blocked startup state remains the user-facing health signal.')
  lines.push('')
  lines.push('## Problem ownership triage')
  lines.push('')
  lines.push('- First 2 seconds: startup guard/camera cadence. No MP4 was written, so the run avoided encoding damaged startup frames.')
  lines.push('- Preview lag: not measured in this blocked run; rerun after cadence settles or with a source preset that passes startup.')
  lines.push('- Preview quality: not measured in this blocked run; native CAMetalLayer acceptance is still required before claiming OBS-native quality.')
  lines.push('')
  lines.push('## Gate verdict')
  lines.push('')
  lines.push('- Non-gated baseline mode records this as a failed OBS-parity verdict, not a harness crash.')
  lines.push('- `--gate` mode should fail because recording did not start.')
  lines.push('')

  writeFileSync(reportPath, lines.join('\n'))
  return reportPath
}

function appendPreviewSurfaceOutputFailures(acceptance, failures) {
  const outputFailures = previewSurfaceOutputFailureMessages(failures)
  if (outputFailures.length === 0) {
    return acceptance
  }
  return {
    ...acceptance,
    pass: false,
    failures: [...(acceptance.failures ?? []), ...outputFailures],
  }
}

function previewSurfaceOutputFailureMessages(failures) {
  return (failures ?? []).map((failure) => `preview-surface: host emitted handler error: ${failure}`)
}

function acceptanceGates() {
  if (!config.avSyncStimulus) return DEFAULT_ACCEPTANCE_GATES
  return {
    ...DEFAULT_ACCEPTANCE_GATES,
    minPreviewPresentFps: 0,
    maxPreviewIntervalP95Ms: Number.POSITIVE_INFINITY,
  }
}

function printSummary(
  report,
  startupReport,
  diagnostics,
  previewTransport,
  baselinePath,
  evidenceManifestPath,
  acceptance,
  ownership,
  qualityMode
) {
  const fmtMs = (value) => typeof value === 'number' && Number.isFinite(value) ? `${value}ms` : 'n/a'
  console.log('')
  console.log('════════ REAL-SOURCE BASELINE ════════')
  console.log(
    `Acceptance gate: ${acceptance.pass ? 'PASS' : 'FAIL'}` +
      (config.avSyncStimulus ? ' (A/V sync stimulus; preview cadence gate relaxed)' : '')
  )
  console.log(`Media quality mode: ${qualityMode.mode} (${qualityMode.label})`)
  if (qualityMode.reasons.length) console.log(`Quality evidence: ${qualityMode.reasons.join('; ')}`)
  for (const f of acceptance.failures) console.log(`  ✗ ${f}`)
  console.log(`Final-file verdict: ${report.verdict.pass ? 'PASS' : 'FAIL'}`)
  for (const f of report.verdict.failures) console.log(`  ❌ ${f}`)
  for (const w of report.verdict.warnings) console.log(`  ⚠️  ${w}`)
  console.log(`Startup verdict: ${startupReport.verdict.pass ? 'PASS' : 'FAIL'}`)
  for (const f of startupReport.verdict.failures) console.log(`  ✗ ${f}`)
  for (const w of startupReport.verdict.warnings) console.log(`  ! ${w}`)
  console.log(`Preview transport: ${previewTransport} (diagnostics saw: ${diagnostics.transports.join(', ') || 'unknown'})`)
  console.log(`Encoder bridge video output: ${config.bridgeVideoOutput}`)
  console.log(
    `Preview backing: ${diagnostics.previewSurfaceBacking ?? 'unknown'} (saw: ${diagnostics.surfaceBackings.join(', ') || 'unknown'})`
  )
  console.log(
    `Transport honesty: ${formatTransportHonesty({ previewTransport, diagnostics })}`
  )
  console.log(
    `Preview source pixels: ${diagnostics.previewSourcePixelsPresent ? 'present' : 'not proven'} | frame polling suppressed: ${diagnostics.previewFramePollingSuppressed ? 'yes' : 'no'}`
  )
  if (diagnostics.previewMeasurementError) {
    console.log(`Native preview direct measurement: failed (${diagnostics.previewMeasurementError})`)
  } else if (diagnostics.previewDirectMeasuredFps != null) {
    console.log(
      `Native preview direct measurement: ${diagnostics.previewDirectMeasuredFps.toFixed(1)}fps | interval p95 ${diagnostics.previewDirectIntervalP95Ms ?? 'n/a'}ms | source-to-present p95/p99 ${diagnostics.previewDirectInputToPresentP95Ms ?? 'n/a'}/${diagnostics.previewDirectInputToPresentP99Ms ?? 'n/a'}ms | compositor lag ${diagnostics.previewDirectCompositorFrameLag ?? 'n/a'} | blanks ${diagnostics.previewDirectBlankFrames}`
    )
  }
  console.log(
    `Native preview handoff timings p95: renderer poll interval ${fmtMs(diagnostics.nativePreviewRendererPollIntervalP95Ms)} | renderer poll RTT ${fmtMs(diagnostics.nativePreviewRendererPollRoundTripP95Ms)} | renderer present RTT ${fmtMs(diagnostics.nativePreviewRendererPresentRoundTripP95Ms)} | main queue wait ${fmtMs(diagnostics.nativePreviewMainQueueWaitP95Ms)} | main present ${fmtMs(diagnostics.nativePreviewMainPresentP95Ms)} | helper RTT ${fmtMs(diagnostics.nativePreviewHelperRoundTripP95Ms)} | renderer poll skips ${diagnostics.nativePreviewRendererPollInFlightSkips} | main queued-behind ${diagnostics.nativePreviewMainQueuedBehindCount}`
  )
  console.log(
    `Native preview status refresh: fetch p95 ${fmtMs(diagnostics.nativePreviewMainStatusFetchP95Ms)} | success/fail ${diagnostics.nativePreviewMainStatusFetchSuccesses}/${diagnostics.nativePreviewMainStatusFetchFailures} | presented status age current/p95 ${fmtMs(diagnostics.nativePreviewMainPresentedStatusAgeMs)}/${fmtMs(diagnostics.nativePreviewMainPresentedStatusAgeP95Ms)} | presented frame age p95 ${fmtMs(diagnostics.nativePreviewMainPresentedFrameAgeP95Ms)}`
  )
  console.log(`Preview host commands pending: ${diagnostics.previewPendingHostCommandCount}`)
  console.log(
    `Compositor backend: ${diagnostics.compositorBackend ?? 'unknown'} | CPU fallback frames ${diagnostics.compositorCpuFallbackFrames}` +
      (diagnostics.compositorFallbackReason ? ` | ${diagnostics.compositorFallbackReason}` : '')
  )
  console.log(
    `Recording bridge: repeated ${diagnostics.encoderBridgeRepeatedFrames} (${diagnostics.encoderBridgeRepeatedFrameBursts} burst(s), max run ${diagnostics.encoderBridgeMaxRepeatedFrameRun}) | source age p95/max ${diagnostics.encoderBridgeSourceAgeP95Ms ?? 'n/a'}/${diagnostics.encoderBridgeSourceAgeMs ?? 'n/a'}ms | repeat age p95/max ${diagnostics.encoderBridgeRepeatedFrameAgeP95Ms ?? 'n/a'}/${diagnostics.encoderBridgeRepeatedFrameAgeMaxMs ?? 'n/a'}ms | Metal targets ${diagnostics.encoderBridgeMetalTargetFrames} | Metal handles ${diagnostics.encoderBridgeMetalTargetHandleFrames} | raw copied ${diagnostics.encoderBridgeRawVideoCopiedFrames} | Metal copied ${diagnostics.encoderBridgeMetalTargetCopiedFrames} | zero-copy ${diagnostics.encoderBridgeZeroCopyFrames} | VT output ${diagnostics.encoderBridgeVideoToolboxOutputFrames} | split encoders ${diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders} (separate ${formatBoolean(diagnostics.encoderBridgeSeparateOutputEncodersActive)})`
  )
  console.log(
    `Recording bridge timings p95: compositor wait ${diagnostics.encoderBridgeCompositorWaitP95Ms ?? 'n/a'}ms | VT submit ${diagnostics.encoderBridgeVideoToolboxSubmitP95Ms ?? 'n/a'}ms | H.264 FIFO write ${diagnostics.encoderBridgeVideoToolboxFifoWriteP95Ms ?? 'n/a'}ms | writer total ${diagnostics.encoderBridgeWriterLoopP95Ms ?? 'n/a'}ms | writer sleep/active ${diagnostics.encoderBridgeWriterSleepP95Ms ?? 'n/a'}/${diagnostics.encoderBridgeWriterActiveP95Ms ?? 'n/a'}ms | deadline lag p95/max ${diagnostics.encoderBridgeDeadlineLagP95Ms ?? 'n/a'}/${diagnostics.encoderBridgeDeadlineLagMaxMs ?? 'n/a'}ms (${diagnostics.encoderBridgeLateDeadlineTicks ?? 0} late tick(s))`
  )
  const activeOwners = (ownership ?? []).filter((item) => item.status !== 'pass')
  console.log(
    `Problem owners: ${
      activeOwners.length
        ? activeOwners.map((item) => `${item.area} -> ${item.owner}`).join('; ')
        : 'none from automated metrics'
    }`
  )
  console.log(`Encoder min speed: ${diagnostics.minEncoderSpeed ?? 'n/a'}x | mic dropped: ${diagnostics.micDroppedFrames}`)
  console.log(
    `Screen capture: gap p95 ${diagnostics.previewScreenCaptureGapP95Ms ?? 'n/a'}ms / max ${diagnostics.previewScreenCaptureGapMaxMs ?? 'n/a'}ms | copy p95 ${diagnostics.previewScreenRowCopyP95Ms ?? 'n/a'}ms | publish p95 ${diagnostics.previewScreenPublishP95Ms ?? 'n/a'}ms`
  )
  console.log(
    `Compositor outside-render: tick gap p95/max ${diagnostics.compositorTickGapP95Ms ?? 'n/a'}/${diagnostics.compositorTickGapMaxMs ?? 'n/a'}ms | source refresh p95 ${diagnostics.compositorLiveSourceRefreshP95Ms ?? 'n/a'}ms | surface/status progress p95 ${diagnostics.compositorPreviewSurfaceProgressP95Ms ?? 'n/a'}/${diagnostics.compositorStatusProgressP95Ms ?? 'n/a'}ms`
  )
  console.log(
    `Compositor source freshness: camera misses ${diagnostics.compositorCameraSourceTryLockMisses ?? 'n/a'} / refreshes ${diagnostics.compositorCameraSourceBlockingRefreshes ?? 'n/a'} | ` +
      `screen misses ${diagnostics.compositorScreenSourceTryLockMisses ?? 'n/a'} / refreshes ${diagnostics.compositorScreenSourceBlockingRefreshes ?? 'n/a'}`
  )
  console.log(`Baseline report: ${baselinePath}`)
  console.log(`Evidence manifest: ${evidenceManifestPath}`)
  console.log(`Latest evidence copy: ${latestEvidenceManifestPath()}`)
  console.log('══════════════════════════════════════')
}

function printBlockedStartupSummary(
  error,
  diagnostics,
  previewTransport,
  baselinePath,
  evidenceManifestPath,
  qualityMode
) {
  const cadence = blockedStartupCameraCadence(error?.message ?? String(error), [])
  console.log('')
  console.log('════════ REAL-SOURCE BASELINE ════════')
  console.log('Acceptance gate: FAIL')
  console.log(`Media quality mode: ${qualityMode.mode} (${qualityMode.label})`)
  if (qualityMode.reasons.length) console.log(`Quality evidence: ${qualityMode.reasons.join('; ')}`)
  console.log(`Start blocked before encoding: ${error?.message ?? error}`)
  console.log(`Preview transport: ${previewTransport} (diagnostics saw: ${diagnostics.transports.join(', ') || 'unknown'})`)
  console.log(
    `Camera capture: callback p95 ${fmtOrFallback(diagnostics.previewCameraCaptureGapP95Ms, cadence?.callbackP95)} / ` +
      `sample PTS p95 ${fmtOrFallback(diagnostics.previewCameraSamplePtsGapP95Ms, cadence?.samplePtsP95)} / ` +
      `frame age ${fmtOrFallback(diagnostics.previewCameraFrameAgeMs, cadence?.frameAge, 0)}`
  )
  console.log(`Blocked-start report: ${baselinePath}`)
  console.log(`Evidence manifest: ${evidenceManifestPath}`)
  console.log(`Latest evidence copy: ${latestEvidenceManifestPath()}`)
  console.log('══════════════════════════════════════')
}

function blockedStartupCameraCadence(errorMessage, healthEvents) {
  const messages = [errorMessage, ...healthEvents.map((event) => event.message).filter(Boolean)]
  for (const message of messages) {
    const match = /sample PTS p95 ([^,]+), threshold ([^,]+), callback p95 ([^,]+), frame age ([^)]+)\)/.exec(message)
    if (match) {
      return {
        samplePtsP95: match[1],
        threshold: match[2],
        callbackP95: match[3],
        frameAge: match[4],
      }
    }
  }
  return null
}

function fmtOrFallback(value, fallback, decimals = 1) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value.toFixed(decimals)}ms`
  return fallback ?? 'n/a'
}

// --- Param builders ---------------------------------------------------------

function layoutSettings(sources) {
  return {
    layoutPreset: baselineLayoutPreset(sources),
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
    sideBySideCameraSide: 'right',
  }
}

function videoSettings() {
  return { preset: 'custom', width: config.width, height: config.height, fps: config.fps, bitrateKbps: config.bitrateKbps }
}

function requestedOutputSettings() {
  return { width: config.width, height: config.height, fps: config.fps, bitrateKbps: config.bitrateKbps }
}

function requires4kMediaEvidence() {
  return config.width >= 3840 && config.height >= 2160 && config.fps >= 30
}

function previewSourceParams(sources) {
  return { sources, layout: layoutSettings(sources), video: videoSettings() }
}

function previewSurfaceSource(sources) {
  if (sources.windowId) return 'window'
  if (sources.screenId) return 'screen'
  if (sources.cameraId) return 'camera'
  return 'synthetic'
}

function previewSurfaceBounds() {
  return {
    screenX: 80,
    screenY: 80,
    width: 1280,
    height: 720,
    scaleFactor: 1,
    screenHeight: 900,
  }
}

function sessionParams(sources) {
  if (config.streamEnabled && (!config.streamServerUrl || !config.streamKey)) {
    throw new Error(
      'VIDEORC_BASELINE_STREAM=1 requires VIDEORC_BASELINE_STREAM_SERVER_URL and VIDEORC_BASELINE_STREAM_KEY.'
    )
  }
  return {
    sources,
    layout: layoutSettings(sources),
    output: {
      recordEnabled: true,
      streamEnabled: config.streamEnabled,
      outputDirectory: config.outputDirectory,
      ffmpegPath: config.ffmpegPath,
      video: videoSettings(),
      rtmp: config.streamEnabled
        ? { preset: 'custom', serverUrl: config.streamServerUrl, streamKey: config.streamKey }
        : { preset: 'custom', serverUrl: '', streamKey: '' },
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: false,
      microphoneSyncOffsetMs: config.microphoneSyncOffsetMs,
    },
  }
}

function baselineLayoutPreset(sources) {
  const forced = process.env.VIDEORC_BASELINE_LAYOUT_PRESET
  if (forced) return forced
  const hasScreen = Boolean(sources.screenId || sources.windowId)
  const hasCamera = Boolean(sources.cameraId)
  if (hasScreen && hasCamera) return 'screen-camera'
  if (hasScreen) return 'screen-only'
  if (hasCamera) return 'camera-only'
  return 'screen-camera'
}

// --- Helpers ----------------------------------------------------------------

async function tryStep(label, fn) {
  try {
    await fn()
  } catch (error) {
    console.log(`  (${label} skipped: ${error?.message ?? error})`)
  }
}

async function requiredStep(label, fn) {
  try {
    await fn()
  } catch (error) {
    throw new Error(`${label} failed: ${error?.message ?? error}`)
  }
}

async function requestSafe(ws, method, params) {
  try {
    return await request(ws, config.timeoutMs, method, params)
  } catch {
    return null
  }
}

async function applyPendingNativePreviewHostCommands(ws) {
  const smoke = launched?.connections?.['preview-motion-ready']
  if (!smoke) {
    throw new Error('Preview host command server was not available for visible-preview baseline.')
  }
  const commands = await request(ws, config.timeoutMs, 'preview.surface.take_native_host_commands')
  if (!Array.isArray(commands)) {
    throw new Error('Backend returned an invalid native preview host command batch.')
  }
  if (commands.length === 0) {
    return await smokeCommand(smoke, 'native-preview-surface-status')
  }
  console.log(`Applying ${commands.length} native preview host command(s) to Electron preview host.`)
  return await smokeCommand(smoke, 'apply-native-preview-host-commands', { commands })
}

async function smokeCommand(smoke, command, params = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, params }),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`${command} smoke command returned invalid JSON: ${text.slice(0, 200)}`)
    }
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error ?? `${command} smoke command failed.`)
    }
    return payload.result
  } finally {
    clearTimeout(timer)
  }
}

function siblingFfprobe(ffmpegPath) {
  if (!ffmpegPath || !ffmpegPath.includes('/')) return null
  const candidate = join(dirname(ffmpegPath), 'ffprobe')
  return existsSync(candidate) ? candidate : null
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
