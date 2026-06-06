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
//   VIDEORC_SMOKE_OUTPUT_DIR        where recordings + reports land
//   VIDEORC_BASELINE_SCREEN_ID / _CAMERA_ID / _MIC_ID   force a specific device id
//   VIDEORC_BASELINE_NO_SCREEN / _NO_CAMERA / _NO_MIC   omit that source
//   VIDEORC_BASELINE_LAYOUT_PRESET  force layout preset; otherwise inferred from selected sources
//   VIDEORC_SMOKE_FFMPEG_PATH / VIDEORC_SMOKE_FFPROBE_PATH

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { analyzeStartupResolution, writeStartupReports } from './lib/startup-resolution-analyzer.mjs'
import { evaluateAcceptance } from './lib/acceptance-gate.mjs'
import { classifyObsParityEvidence } from './lib/obs-parity-evidence.mjs'
import { claimsNativePreview, formatTransportHonesty } from './lib/native-preview-claim.mjs'

const config = {
  recordingMs: Number(process.env.VIDEORC_BASELINE_RECORDING_MS ?? 60000),
  width: Number(process.env.VIDEORC_BASELINE_WIDTH ?? 1920),
  height: Number(process.env.VIDEORC_BASELINE_HEIGHT ?? 1080),
  fps: Number(process.env.VIDEORC_BASELINE_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_BASELINE_BITRATE_KBPS ?? 6000),
  timeoutMs: Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000),
  sampleIntervalMs: Number(process.env.VIDEORC_BASELINE_SAMPLE_MS ?? 2000),
  warmupMs: Number(process.env.VIDEORC_BASELINE_WARMUP_MS ?? 8000),
  ffmpegPath: process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? siblingFfprobe(process.env.VIDEORC_SMOKE_FFMPEG_PATH) ?? 'ffprobe',
  bridgeVideoOutput: process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT ?? 'raw-yuv420p',
  fallbackLivePreview: process.env.VIDEORC_BASELINE_FALLBACK_LIVE_PREVIEW === '1',
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
mkdirSync(config.outputDirectory, { recursive: true })

let exitCode = 0
try {
  const verdict = await main()
  exitCode = config.gate && verdict && !verdict.pass ? 1 : 0
} catch (error) {
  console.error(`real-source baseline failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  if (launched) await stopProcess(launched.process)
}
process.exit(exitCode)

async function main() {
  console.log('Launching dev app for real-source baseline (no preview-motion synthetic mode)…')
  launched = await launchDevApp({
    timeoutMs: config.timeoutMs,
    requiredMarkers: ['backend-ready'],
    // Real sources must flow: do NOT set VIDEORC_SMOKE_PREVIEW_MOTION (that forces
    // synthetic procedural preview). Enable the native surface so the real preview
    // transport is exercised if the renderer creates it.
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: config.outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: config.bridgeVideoOutput,
    },
    onLine: (line) => console.log(line),
  })

  const ws = await connectBackend(launched.connections['backend-ready'], config.timeoutMs)
  const diagnosticsEvents = []
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message.event === 'diagnostics.stats') {
        diagnosticsEvents.push({ ...message.payload, receivedAt: Date.now() })
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
    } else {
      await tryStep('preview.live.stop', async () => {
        await request(ws, config.timeoutMs, 'preview.live.stop')
      })
      await tryStep('preview.surface.create', async () => {
        const status = await request(ws, config.timeoutMs, 'preview.surface.create', {
          bounds: previewSurfaceBounds(),
          targetFps: 60,
          source: previewSurfaceSource(sourceSelection),
        })
        previewTransport = status?.transport ?? previewTransport
      })
    }

    await waitForPreviewSourceReadiness(ws, sources)

    const scenarioStartedAt = Date.now()
    const started = await request(ws, config.timeoutMs, 'session.start', sessionParams(sourceSelection))
    if (started.state !== 'recording') {
      throw new Error(`Expected recording state after start, got ${started.state}.`)
    }
    console.log(`Recording real sources for ${(config.recordingMs / 1000).toFixed(0)}s -> ${started.outputPath ?? '(pending)'}`)

    const snapshots = await sampleDuringRecording(ws, config.recordingMs)
    const stopRequestedAt = Date.now()
    const stopped = await request(ws, config.timeoutMs, 'session.stop')
    const outputPath = stopped.outputPath ?? started.outputPath
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
    })
    const diagnostics = summarizeDiagnostics(diagnosticsEvents, snapshots, scenarioStartedAt, stopRequestedAt)
    writeReports(report)
    const startupReport = await analyzeStartupResolution(outputPath, {
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      expectedWidth: config.width,
      expectedHeight: config.height,
      intendedFps: config.fps,
      syntheticEvidence: diagnostics.encoderBridgeSyntheticFrames,
    })
    const startupPaths = await writeStartupReports(startupReport, {
      ffmpegPath: config.ffmpegPath,
    })
    const claimsNative = claimsNativePreview({ previewTransport, diagnostics })
    const ownership = classifyObsParityEvidence({
      analyzerVerdict: report.verdict,
      startupVerdict: startupReport.verdict,
      diagnostics,
      claimsNative,
    })
    const baselinePath = writeBaselineReport(outputPath, {
      sources,
      previewTransport,
      size,
      diagnostics,
      report,
      startupReport,
      startupPaths,
      ownership,
    })

    // Full real-source acceptance gate: final-file verdict + recording repeats +
    // encoder speed + mic drops/coverage + transport honesty, all enforced together.
    // The Electron proof surface reports metrics, but only native-surface plus a real
    // CAMetalLayer backing is an OBS-native claim.
    const acceptance = evaluateAcceptance({
      analyzerVerdict: report.verdict,
      startupVerdict: startupReport.verdict,
      diagnostics,
      claimsNative,
      requireObsNativePreview: true,
      requireGpuCompositor: true,
      expectAudio: Boolean(sources.microphone),
    })
    printSummary(report, startupReport, diagnostics, previewTransport, baselinePath, acceptance, ownership)
    return acceptance
  } finally {
    ws.close()
  }
}

// --- Source selection -------------------------------------------------------

function selectSources(devices) {
  return {
    screen: pickDevice(devices, 'screen', {
      override: process.env.VIDEORC_BASELINE_SCREEN_ID,
      disabled: process.env.VIDEORC_BASELINE_NO_SCREEN === '1',
      nativePrefix: NATIVE_PREFIX.screen,
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

function pickDevice(devices, kind, { override, disabled, nativePrefix }) {
  if (disabled) return null
  if (override) {
    return devices.find((d) => d.id === override) ?? { id: override, name: '(forced)', kind, status: 'forced' }
  }
  const ofKind = devices.filter((d) => d.kind === kind)
  const available = ofKind.filter((d) => d.status === 'available')
  const pool = available.length ? available : ofKind
  return pool.find((d) => d.id.startsWith(nativePrefix)) ?? pool[0] ?? null
}

function assertRequiredSourcesAvailable(sources) {
  const blockers = [
    requiredSourceBlocker('screen', sources.screen, {
      disabled: process.env.VIDEORC_BASELINE_NO_SCREEN === '1',
      override: process.env.VIDEORC_BASELINE_SCREEN_ID,
      disableHint: 'VIDEORC_BASELINE_NO_SCREEN=1',
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

function requiredSourceBlocker(label, device, { disabled, override, disableHint }) {
  if (disabled || override) return null
  if (!device) return `${label} missing (set ${disableHint} to omit it intentionally)`
  if (device.status !== 'available') {
    return `${label} ${device.name} [${device.id}] is ${device.status} (set ${disableHint} to omit it intentionally)`
  }
  return null
}

function reportSelection(sources, warnings) {
  const describe = (label, device) =>
    `  ${label}: ${device ? `${device.name} [${device.id}] (${device.status})` : 'none'}`
  console.log('Selected real sources:')
  console.log(describe('screen', sources.screen))
  console.log(describe('camera', sources.camera))
  console.log(describe('microphone', sources.microphone))
  for (const warning of warnings) console.log(`  device warning: ${warning}`)
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
    if (previewSourceReady(lastCamera) && previewSourceReady(lastScreen)) {
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

function previewSourceReady(status) {
  if (!status) return true
  return status.state === 'live' && (status.framesCaptured ?? 0) > 0 && (status.frameAgeMs ?? Infinity) <= 2_000
}

function describePreviewReadiness(status) {
  if (!status) return 'not selected'
  return `${status.state ?? 'unknown'} frames=${status.framesCaptured ?? 0} age=${status.frameAgeMs ?? 'n/a'}ms`
}

// --- Diagnostics sampling ---------------------------------------------------

async function sampleDuringRecording(ws, durationMs) {
  const snapshots = []
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    const [diagnostics, compositor, surface] = await Promise.all([
      requestSafe(ws, 'diagnostics.stats'),
      requestSafe(ws, 'compositor.status'),
      requestSafe(ws, 'preview.surface.status'),
    ])
    snapshots.push({ at: Date.now(), diagnostics, compositor, surface })
    await sleep(config.sampleIntervalMs)
  }
  return snapshots
}

function summarizeDiagnostics(events, snapshots, startedAt, stopRequestedAt) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const active = events.filter((s) => {
    const t = s.receivedAt ?? 0
    return s.activeOutputMode === 'record' && t >= startedAt && t <= stopRequestedAt
  })
  const steady = active.filter((s) => (s.receivedAt ?? 0) - startedAt >= config.warmupMs)
  const measured = steady.length ? steady : active
  const collect = (key) => measured.map((s) => num(s[key])).filter((v) => v !== null)
  const captureFps = collect('captureFps')
  const renderFps = collect('renderFps')
  const speed = collect('encoderSpeed')
  const rss = collect('backendRssBytes')
  const ffmpegProcs = collect('activeFfmpegProcesses')
  const ffprobeProcs = collect('activeFfprobeProcesses')

  const compositorSamples = snapshots.map((s) => s.compositor).filter(Boolean)
  const surfaceSamples = snapshots.map((s) => s.surface).filter(Boolean)
  const transports = new Set(measured.map((s) => s.previewTransport).filter(Boolean))
  for (const s of surfaceSamples) if (s.transport) transports.add(s.transport)
  const surfaceBackings = new Set(measured.map((s) => s.previewSurfaceBacking).filter(Boolean))
  for (const s of surfaceSamples) if (s.backing) surfaceBackings.add(s.backing)
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
  const lastDefined = (arr, key) => {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const v = arr[i]?.[key]
      if (typeof v === 'number') return v
    }
    return null
  }

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
    previewSurfaceBacking:
      measured.map((s) => s.previewSurfaceBacking).filter(Boolean).pop() ??
      surfaceSamples.map((s) => s.backing).filter(Boolean).pop() ??
      null,
    encoderBridgeRepeatedFrames: maxOf(measured.map((s) => s.encoderBridgeRepeatedFrames ?? 0)) ?? 0,
    encoderBridgeSyntheticFrames: maxOf(measured.map((s) => s.encoderBridgeSyntheticFrames ?? 0)) ?? 0,
    encoderBridgeSourceAgeMs: maxOf(collect('encoderBridgeSourceAgeMs')),
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
    encoderBridgeCompositorWaitP95Ms:
      maxOf(collect('encoderBridgeCompositorWaitP95Ms')) ?? null,
    encoderBridgeVideoToolboxSubmitP95Ms:
      maxOf(collect('encoderBridgeVideoToolboxSubmitP95Ms')) ?? null,
    encoderBridgeVideoToolboxFifoWriteP95Ms:
      maxOf(collect('encoderBridgeVideoToolboxFifoWriteP95Ms')) ?? null,
    encoderBridgeWriterLoopP95Ms:
      maxOf(collect('encoderBridgeWriterLoopP95Ms')) ?? null,
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
    previewDroppedFrames: maxOf(measured.map((s) => s.previewDroppedFrames ?? 0)) ?? 0,
    minPreviewPresentFps: minOf(collect('previewPresentFps')),
    previewInputToPresentLatencyMs: maxOf(collect('previewInputToPresentLatencyMs')),
    previewInputToPresentLatencyP95Ms: maxOf(collect('previewInputToPresentLatencyP95Ms')),
    previewInputToPresentLatencyP99Ms: maxOf(collect('previewInputToPresentLatencyP99Ms')),
    previewIntervalP95Ms: maxOf(collect('previewRenderFrameTimeP95Ms')),
    previewCompositorFrameLag: maxOf([
      ...collect('previewCompositorFrameLag'),
      ...surfaceSamples.map((s) => num(s.compositorFrameLag)).filter((v) => v !== null),
    ]),
    previewCameraFrameAgeMs: maxOf(collect('previewCameraFrameAgeMs')),
    previewScreenFrameAgeMs: maxOf(collect('previewScreenFrameAgeMs')),
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
    compositorGpuCommandWaitP95Ms: maxOf(collect('compositorGpuCommandWaitP95Ms')),
    compositorGpuTotalP95Ms: maxOf(collect('compositorGpuTotalP95Ms')),
    compositorFrameStorePublishP95Ms: maxOf(collect('compositorFrameStorePublishP95Ms')),
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
    imagePollDuringSession,
    transports: [...transports],
    surfaceBackings: [...surfaceBackings],
    bottlenecks: [...bottlenecks],
  }
}

// --- Report -----------------------------------------------------------------

function writeBaselineReport(outputPath, { sources, previewTransport, size, diagnostics, report, startupReport, startupPaths, ownership }) {
  const base = outputPath.split('/').pop().replace(/\.[^.]+$/, '')
  const reportPath = join(dirname(outputPath), `${base}.baseline.md`)
  const m = report.metrics
  const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'n/a')
  const mib = (v) => (typeof v === 'number' ? `${(v / (1024 * 1024)).toFixed(1)} MiB` : 'n/a')

  const lines = []
  lines.push('# Real-Source Baseline Report')
  lines.push('')
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Platform: ${process.platform}`)
  lines.push(`- Recording: \`${outputPath}\` (${(size / (1024 * 1024)).toFixed(1)} MiB)`)
  lines.push(`- Output: ${config.width}×${config.height} @ ${config.fps}fps, ${config.bitrateKbps}kbps, ${(config.recordingMs / 1000).toFixed(0)}s`)
  lines.push(`- Encoder bridge video output: \`${config.bridgeVideoOutput}\``)
  lines.push('')
  lines.push('## Selected real sources')
  lines.push('')
  lines.push(`- Screen: ${sources.screen ? `${sources.screen.name} \`${sources.screen.id}\`` : 'none'}`)
  lines.push(`- Camera: ${sources.camera ? `${sources.camera.name} \`${sources.camera.id}\`` : 'none'}`)
  lines.push(`- Microphone: ${sources.microphone ? `${sources.microphone.name} \`${sources.microphone.id}\`` : 'none'}`)
  lines.push(`- testPattern: false (real capture)`)
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
  lines.push(`- Recording bridge — repeated-fed ${diagnostics.encoderBridgeRepeatedFrames} | synthetic-filler ${diagnostics.encoderBridgeSyntheticFrames} | source→encode age max ${fmt(diagnostics.encoderBridgeSourceAgeMs, 0)}ms | Metal targets ${diagnostics.encoderBridgeMetalTargetFrames} | Metal handles ${diagnostics.encoderBridgeMetalTargetHandleFrames} | raw copied ${diagnostics.encoderBridgeRawVideoCopiedFrames} | Metal copied ${diagnostics.encoderBridgeMetalTargetCopiedFrames} | zero-copy ${diagnostics.encoderBridgeZeroCopyFrames} | VT output ${diagnostics.encoderBridgeVideoToolboxOutputFrames} (${diagnostics.encoderBridgeVideoToolboxOutputBytes} bytes, ${diagnostics.encoderBridgeVideoToolboxOutputEncodeMs}ms max encode) | VT probe ${diagnostics.encoderBridgeVideoToolboxProbeFrames} (${diagnostics.encoderBridgeVideoToolboxProbeBytes} bytes, ${diagnostics.encoderBridgeVideoToolboxProbeErrors} errors)`)
  lines.push(
    `- Recording bridge timings p95: compositor wait ${fmt(diagnostics.encoderBridgeCompositorWaitP95Ms)}ms | ` +
      `VT submit ${fmt(diagnostics.encoderBridgeVideoToolboxSubmitP95Ms)}ms | ` +
      `H.264 FIFO write ${fmt(diagnostics.encoderBridgeVideoToolboxFifoWriteP95Ms)}ms | ` +
      `writer loop ${fmt(diagnostics.encoderBridgeWriterLoopP95Ms)}ms`
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
  lines.push(`- Preview frame lag/dropped frames: ${fmt(diagnostics.previewCompositorFrameLag, 0)} / ${diagnostics.previewDroppedFrames}`)
  lines.push(`- Preview repeated frames: ${diagnostics.previewRepeatedFrames}`)
  lines.push(`- Source frame age (max): camera ${fmt(diagnostics.previewCameraFrameAgeMs, 0)}ms | screen ${fmt(diagnostics.previewScreenFrameAgeMs, 0)}ms`)
  lines.push(
    `- Screen capture cadence: callback gap p95 ${fmt(diagnostics.previewScreenCaptureGapP95Ms)}ms / max ${fmt(diagnostics.previewScreenCaptureGapMaxMs)}ms | ` +
      `lock ${fmt(diagnostics.previewScreenPixelBufferLockP95Ms)}ms | copy ${fmt(diagnostics.previewScreenRowCopyP95Ms)}ms | publish ${fmt(diagnostics.previewScreenPublishP95Ms)}ms | ` +
      `frame ${diagnostics.previewScreenFrameBytes} bytes | SCK queue depth ${diagnostics.previewScreenCaptureQueueDepth}`
  )
  lines.push(`- Compositor: repeated ${diagnostics.compositorRepeatedFrames} | dropped ${diagnostics.compositorDroppedFrames} | frame age max ${fmt(diagnostics.compositorFrameAgeMs, 0)}ms | frame time p95 ${fmt(diagnostics.compositorFrameTimeP95Ms)}ms`)
  lines.push(
    `- Compositor breakdown p95: source fetch ${fmt(diagnostics.compositorSourceFetchP95Ms)}ms ` +
      `(scene ${fmt(diagnostics.compositorSceneSnapshotP95Ms)}ms, camera ${fmt(diagnostics.compositorCameraFrameFetchP95Ms)}ms, screen ${fmt(diagnostics.compositorScreenFrameFetchP95Ms)}ms) | ` +
      `prepare ${fmt(diagnostics.compositorGpuPrepareP95Ms)}ms | source texture ${fmt(diagnostics.compositorGpuSourceTextureP95Ms)}ms | ` +
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
  lines.push('')
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
  lines.push('')
  lines.push('Still NOT proven here (deferred to the on-hardware native phase):')
  lines.push('- **True CAMetalLayer source-to-present latency**: the Electron proof surface now reports host-present metrics, but the final native Metal layer still needs on-device validation.')
  lines.push('- **Lip-sync**: A/V skew here is a container duration delta, not measured mouth/voice alignment — that needs capture-clock PTS instrumentation (the native part of slice #8). The live mic capture-coverage signal above is the honest gap indicator, since final-file audio gaps are masked by the muxer/aresample.')
  lines.push('')

  writeFileSync(reportPath, lines.join('\n'))
  return reportPath
}

function printSummary(report, startupReport, diagnostics, previewTransport, baselinePath, acceptance, ownership) {
  console.log('')
  console.log('════════ REAL-SOURCE BASELINE ════════')
  console.log(`Acceptance gate: ${acceptance.pass ? 'PASS' : 'FAIL'}`)
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
    `Compositor backend: ${diagnostics.compositorBackend ?? 'unknown'} | CPU fallback frames ${diagnostics.compositorCpuFallbackFrames}` +
      (diagnostics.compositorFallbackReason ? ` | ${diagnostics.compositorFallbackReason}` : '')
  )
  console.log(
    `Recording bridge: Metal targets ${diagnostics.encoderBridgeMetalTargetFrames} | Metal handles ${diagnostics.encoderBridgeMetalTargetHandleFrames} | raw copied ${diagnostics.encoderBridgeRawVideoCopiedFrames} | Metal copied ${diagnostics.encoderBridgeMetalTargetCopiedFrames} | zero-copy ${diagnostics.encoderBridgeZeroCopyFrames} | VT output ${diagnostics.encoderBridgeVideoToolboxOutputFrames}`
  )
  console.log(
    `Recording bridge timings p95: compositor wait ${diagnostics.encoderBridgeCompositorWaitP95Ms ?? 'n/a'}ms | VT submit ${diagnostics.encoderBridgeVideoToolboxSubmitP95Ms ?? 'n/a'}ms | H.264 FIFO write ${diagnostics.encoderBridgeVideoToolboxFifoWriteP95Ms ?? 'n/a'}ms | writer loop ${diagnostics.encoderBridgeWriterLoopP95Ms ?? 'n/a'}ms`
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
    `Compositor outside-render: source refresh p95 ${diagnostics.compositorLiveSourceRefreshP95Ms ?? 'n/a'}ms | surface/status progress p95 ${diagnostics.compositorPreviewSurfaceProgressP95Ms ?? 'n/a'}/${diagnostics.compositorStatusProgressP95Ms ?? 'n/a'}ms`
  )
  console.log(
    `Compositor source freshness: camera misses ${diagnostics.compositorCameraSourceTryLockMisses ?? 'n/a'} / refreshes ${diagnostics.compositorCameraSourceBlockingRefreshes ?? 'n/a'} | ` +
      `screen misses ${diagnostics.compositorScreenSourceTryLockMisses ?? 'n/a'} / refreshes ${diagnostics.compositorScreenSourceBlockingRefreshes ?? 'n/a'}`
  )
  console.log(`Baseline report: ${baselinePath}`)
  console.log('══════════════════════════════════════')
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
  return {
    sources,
    layout: layoutSettings(sources),
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectory: config.outputDirectory,
      ffmpegPath: config.ffmpegPath,
      video: videoSettings(),
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' },
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 },
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

async function requestSafe(ws, method, params) {
  try {
    return await request(ws, config.timeoutMs, method, params)
  } catch {
    return null
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
