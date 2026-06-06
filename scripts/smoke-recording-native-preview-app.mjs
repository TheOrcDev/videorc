import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { summarizeNativePreviewRecordingDiagnostics } from './lib/native-preview-diagnostics.mjs'
import { createPreviewSurfaceOutputGuard } from './lib/smoke-output-guards.mjs'
import { analyzeStartupResolution } from './lib/startup-resolution-analyzer.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-recording-native-preview-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? resolveSiblingFfprobe(ffmpegPath) ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const launchAttempts = Number(process.env.VIDEORC_NATIVE_PREVIEW_LAUNCH_ATTEMPTS ?? 2)
const recordingMs = Number(process.env.VIDEORC_NATIVE_PREVIEW_RECORDING_MS ?? 15000)
const warmupMs = Number(process.env.VIDEORC_NATIVE_PREVIEW_WARMUP_MS ?? 5000)
const previewMeasurementMs = Number(
  process.env.VIDEORC_NATIVE_PREVIEW_MEASUREMENT_MS ?? Math.max(3000, Math.min(6000, recordingMs - 1500))
)
const minSpeed = Number(process.env.VIDEORC_NATIVE_PREVIEW_MIN_SPEED ?? 0.98)
const maxSkewMs = Number(process.env.VIDEORC_NATIVE_PREVIEW_MAX_AV_SKEW_MS ?? 250)
const minPreviewFps = Number(process.env.VIDEORC_NATIVE_PREVIEW_MIN_FPS ?? 55)
const maxPreviewIntervalP95Ms = Number(process.env.VIDEORC_NATIVE_PREVIEW_MAX_INTERVAL_P95_MS ?? 24)
const maxPreviewInputToPresentLatencyP95Ms = Number(
  process.env.VIDEORC_NATIVE_PREVIEW_MAX_INPUT_TO_PRESENT_P95_MS ?? 50
)
const maxPreviewInputToPresentLatencyP99Ms = Number(
  process.env.VIDEORC_NATIVE_PREVIEW_MAX_INPUT_TO_PRESENT_P99_MS ?? 100
)
const maxPreviewCompositorFrameLag = Number(process.env.VIDEORC_NATIVE_PREVIEW_MAX_COMPOSITOR_FRAME_LAG ?? 2)
const layoutStressUpdates = Number(process.env.VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES ?? 0)
const layoutStressIntervalMs = Number(process.env.VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_INTERVAL_MS ?? 750)
const includeHiddenPreviewScenario = process.env.VIDEORC_NATIVE_PREVIEW_INCLUDE_HIDDEN === '1'
const expectedSurfaceTransport =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ? 'native-surface' : 'electron-proof-surface'
const expectedSurfaceBacking =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ? 'cametal-layer' : 'electron-browser-window'

const visibleScenarios = [
  ...(process.env.VIDEORC_NATIVE_PREVIEW_INCLUDE_1440 === '1'
    ? [{ label: 'native-preview-1440p30', width: 2560, height: 1440, fps: 30, bitrateKbps: 8000 }]
    : []),
  { label: 'native-preview-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
]
const scenarios = [
  ...visibleScenarios.map((scenario) => ({ ...scenario, previewVisible: true })),
  ...(includeHiddenPreviewScenario
    ? [
        {
          label: 'native-preview-hidden-1080p30',
          width: 1920,
          height: 1080,
          fps: 30,
          bitrateKbps: 6000,
          previewVisible: false
        }
      ]
    : [])
]

let appProcess
let stopping = false
const outputGuard = createPreviewSurfaceOutputGuard()

mkdirSync(outputDirectory, { recursive: true })

try {
  const { backend, smoke } = await launchAndReadConnectionsWithRetry()
  await runNativePreviewRecordingSmoke(backend, smoke)
  outputGuard.assertClean()
} finally {
  await stopApp()
}

async function runNativePreviewRecordingSmoke(connection, smoke) {
  const ws = await connectBackend(connection, timeoutMs)
  const samples = []
  const previewSurfaceSamples = []
  try {
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.event === 'diagnostics.stats') {
          samples.push({ ...message.payload, receivedAt: Date.now() })
        } else if (message.event === 'preview.surface.status') {
          previewSurfaceSamples.push({ ...message.payload, receivedAt: Date.now() })
        }
      } catch {
        // Ignore non-JSON websocket messages.
      }
    })

    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for native-preview recording smoke.')
    }
    await assertFfprobeAvailable()
    console.log(`Native-preview recording smoke using FFmpeg: ${ffmpegPath}`)
    console.log(`Native-preview recording smoke using FFprobe: ${ffprobePath}`)

    await smokeCommand(smoke, 'open-layout-tab')
    const bootstrap = await smokeCommand(smoke, 'inspect-native-preview-bootstrap')
    assertNativeBootstrap(bootstrap)
    const surfaceBefore = await waitForNativeSurface(ws)
    const nativeStage = await smokeCommand(smoke, 'inspect-native-preview-bootstrap', {
      requireNativePlaceholder: true
    })
    assertNativeBootstrap(nativeStage, { requireNativePreview: true })
    await waitForNativePreviewDiagnostics(samples)

    let previousSurface = surfaceBefore
    let previewVisible = true
    for (const scenario of scenarios) {
      if (scenario.previewVisible === false && previewVisible) {
        previousSurface = await hideNativePreviewSurface(ws, smoke)
        previewVisible = false
      } else if (scenario.previewVisible !== false && !previewVisible) {
        previousSurface = await showNativePreviewSurface(ws, smoke, samples)
        previewVisible = true
      }
      previousSurface = await runNativePreviewRecordingScenario(
        ws,
        smoke,
        samples,
        previewSurfaceSamples,
        scenario,
        previousSurface
      )
    }
  } finally {
    ws.close()
  }
}

async function runNativePreviewRecordingScenario(ws, smoke, samples, previewSurfaceSamples, scenario, previousSurface) {
  samples.length = 0
  previewSurfaceSamples.length = 0
  const expectsPreview = scenario.previewVisible !== false
  const scenarioStartedAt = Date.now()
  const started = await request(ws, timeoutMs, 'session.start', sessionParams(scenario))
  if (started.state !== 'recording') {
    throw new Error(`[${scenario.label}] Expected recording state after start, got ${started.state}.`)
  }
  const recordingStartedAt = Date.now()
  const activeSceneRevision = Date.now()
  const compositorStatus = await request(
    ws,
    timeoutMs,
    'compositor.scene.update',
    compositorSceneUpdateParams(activeSceneRevision, 0.58)
  )
  if (compositorStatus.sceneRevision !== activeSceneRevision) {
    throw new Error(
      `[${scenario.label}] Compositor scene update returned revision ${compositorStatus.sceneRevision}, expected ${activeSceneRevision}.`
    )
  }
  await assertSameRunningSession(ws, started.sessionId)
  await waitForActiveSceneDiagnostics(ws, activeSceneRevision, 'record')

  const measurementPromise = expectsPreview
    ? smokeCommand(smoke, 'measure-native-preview-surface', {
        durationMs: previewMeasurementMs
      })
    : Promise.resolve(null)
  const stressPromise = stressLayoutDuringRecording(ws, started.sessionId, layoutStressUpdates)
  await sleep(recordingMs)
  await stressPromise
  const measurement = await measurementPromise
  if (expectsPreview) {
    assertNativeMeasurement(measurement)
  }

  const surfaceDuring = expectsPreview
    ? await waitForNativeSurface(ws, previousSurface.framesRendered)
    : await waitForHiddenNativeSurface(ws)
  const stopRequestedAt = Date.now()
  const expectedDurationMs = stopRequestedAt - recordingStartedAt
  const stopped = await request(ws, timeoutMs, 'session.stop')
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(`[${scenario.label}] Recording output was not created: ${outputPath ?? 'missing path'}`)
  }
  const size = statSync(outputPath).size
  if (size <= 0) {
    throw new Error(`[${scenario.label}] Recording output is empty: ${outputPath}`)
  }

  const [startupReport, recordingReport] = await Promise.all([
    analyzeStartupResolution(outputPath, {
      ffmpegPath,
      ffprobePath,
      expectedWidth: scenario.width,
      expectedHeight: scenario.height,
      intendedFps: scenario.fps
    }),
    analyzeRecording(outputPath, {
      ffmpegPath,
      ffprobePath,
      intendedFps: scenario.fps,
      expectAudio: true
    })
  ])
  assertAnalyzerReportHealthy(scenario, 'startup', startupReport)
  assertAnalyzerReportHealthy(scenario, 'final-file', recordingReport)
  assertRecordingDurationHealthy(scenario, recordingReport, expectedDurationMs)

  const stats = summarizeNativePreviewRecordingDiagnostics(samples, {
    targetFps: scenario.fps,
    startedAt: scenarioStartedAt,
    stopRequestedAt,
    warmupMs,
    expectedSurfaceTransport,
    expectedSurfaceBacking,
    previewSurfaceSamples
  })
  assertStatsHealthy(scenario, stats, { startupReport, recordingReport }, { previewExpected: expectsPreview })
  if (expectsPreview) {
    if (stats.nativePreviewSamples === 0) {
      throw new Error(
        `[${scenario.label}] Recording diagnostics never reported ${expectedSurfaceTransport}/${expectedSurfaceBacking} preview transport.`
      )
    }
    if (surfaceDuring.framesRendered <= previousSurface.framesRendered) {
      throw new Error(
        `[${scenario.label}] Native preview surface did not advance during recording: ${previousSurface.framesRendered} -> ${surfaceDuring.framesRendered}.`
      )
    }
  } else {
    assertHiddenNativeSurfaceStatus(scenario, surfaceDuring)
  }

  const skew = await audioVideoSkewMs(outputPath)
  if (skew > maxSkewMs) {
    throw new Error(`[${scenario.label}] Audio/video duration skew ${skew.toFixed(1)}ms exceeded ${maxSkewMs}ms.`)
  }
  const measuredCompositorLag = measurement?.compositorFrameLag ?? stats.maxPreviewCompositorFrameLag
  const previewSummary = expectsPreview
    ? `preview ${format(measurement.measuredFps)}fps, p95 ${format(measurement.intervalP95Ms)}ms, present ${format(stats.minPreviewPresentFps)}fps, source-to-present p95 ${format(stats.maxPreviewInputToPresentLatencyP95Ms)}ms/p99 ${format(stats.maxPreviewInputToPresentLatencyP99Ms)}ms, compositor lag ${format(measuredCompositorLag)} frame(s)`
    : `preview hidden, live preview samples ${stats.nativePreviewSamples}`

  console.log(
    `Native-preview recording [${scenario.label}] OK: ${outputPath} (${size} bytes), ${previewSummary}, startup repeat ${format(startupReport.metrics.maxRepeatedFrameRun, 0)}, final repeat ${format(recordingReport.metrics.maxRepeatedFrameRun, 0)}, Metal targets ${stats.maxEncoderBridgeMetalTargetFrames}, CPU fallback frames ${stats.maxCompositorCpuFallbackFrames}, min speed ${format(stats.minSpeed)}x, min FPS ${format(stats.minFps)}, A/V skew ${skew.toFixed(1)}ms, layout stress ${layoutStressUpdates} update(s), maintenance samples ${stats.maintenanceSamples}, duplicate samples ${stats.duplicateCaptureSamples}, max RSS ${formatBytes(stats.maxBackendRssBytes)}, max FFmpeg procs ${stats.maxActiveFfmpegProcesses}, max FFprobe procs ${stats.maxActiveFfprobeProcesses}`
  )
  return surfaceDuring
}

async function showNativePreviewSurface(ws, smoke, samples) {
  await smokeCommand(smoke, 'resume-native-preview-surface')
  await smokeCommand(smoke, 'open-layout-tab')
  const nativeStage = await smokeCommand(smoke, 'inspect-native-preview-bootstrap', {
    requireNativePlaceholder: true
  })
  assertNativeBootstrap(nativeStage, { requireNativePreview: true })
  const surface = await waitForNativeSurface(ws)
  await waitForNativePreviewDiagnostics(samples)
  return surface
}

async function hideNativePreviewSurface(ws, smoke) {
  await smokeCommand(smoke, 'suspend-native-preview-surface')
  await request(ws, timeoutMs, 'preview.surface.destroy')
  const hostStatus = await smokeCommand(smoke, 'destroy-native-preview-surface')
  assertHiddenNativeSurfaceStatus({ label: 'native-preview-hidden-setup' }, hostStatus)
  return waitForHiddenNativeSurface(ws)
}

async function assertSameRunningSession(ws, sessionId) {
  const status = await request(ws, timeoutMs, 'recording.status')
  if (status.sessionId !== sessionId || status.state !== 'recording') {
    throw new Error(`Scene update restarted or stopped recording: expected ${sessionId}/recording, got ${status.sessionId}/${status.state}.`)
  }
}

async function waitForActiveSceneDiagnostics(ws, sceneRevision, outputMode) {
  const deadline = Date.now() + timeoutMs
  let lastDiagnostics = null
  while (Date.now() < deadline) {
    lastDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    if (
      lastDiagnostics.activeSceneRevision === sceneRevision &&
      lastDiagnostics.activeOutputMode === outputMode
    ) {
      return lastDiagnostics
    }
    await sleep(150)
  }
  throw new Error(
    `Diagnostics did not report active ${outputMode} scene revision ${sceneRevision}. Last diagnostics: ${JSON.stringify(
      lastDiagnostics
    )}`
  )
}

async function stressLayoutDuringRecording(ws, sessionId, count) {
  for (let index = 0; index < count; index += 1) {
    await sleep(layoutStressIntervalMs)
    const revision = Date.now() + index
    const cameraX = index % 2 === 0 ? 0.18 : 0.62
    const compositorStatus = await request(
      ws,
      timeoutMs,
      'compositor.scene.update',
      compositorSceneUpdateParams(revision, cameraX)
    )
    if (compositorStatus.sceneRevision !== revision) {
      throw new Error(
        `Layout stress update ${index + 1}/${count} returned revision ${compositorStatus.sceneRevision}, expected ${revision}.`
      )
    }
    await assertSameRunningSession(ws, sessionId)
    await waitForActiveSceneDiagnostics(ws, revision, 'record')
  }
}

function sessionParams(scenario) {
  return {
    sources: { testPattern: true },
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
      outputDirectory,
      ffmpegPath,
      video: {
        preset: 'custom',
        width: scenario.width,
        height: scenario.height,
        fps: scenario.fps,
        bitrateKbps: scenario.bitrateKbps
      },
      rtmp: {
        preset: 'custom',
        serverUrl: '',
        streamKey: ''
      }
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: false,
      microphoneSyncOffsetMs: 0
    }
  }
}

function compositorSceneUpdateParams(revision, cameraX) {
  const baseTransform = fullFrameTransform()
  const cameraTransform = {
    x: cameraX,
    y: 0.18,
    width: 0.24,
    height: 0.24,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
  const layout = {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'custom',
    cameraTransform: {
      x: cameraTransform.x,
      y: cameraTransform.y,
      width: cameraTransform.width,
      height: cameraTransform.height
    },
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
  return {
    revision,
    layout,
    activeScreen: null,
    scene: {
      id: 'scene:native-preview-recording-smoke',
      name: 'Native Preview Recording Smoke',
      outputs: [],
      sources: [
        {
          id: 'source:test-pattern',
          name: 'Test pattern',
          kind: 'test-pattern',
          transform: baseTransform,
          defaultTransform: baseTransform,
          visible: true,
          locked: false
        },
        {
          id: 'source:camera',
          name: 'Camera',
          kind: 'camera',
          transform: cameraTransform,
          defaultTransform: cameraTransform,
          visible: true,
          locked: false
        }
      ]
    }
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

async function waitForNativeSurface(ws, previousFrames = -1) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    lastStatus = await request(ws, timeoutMs, 'preview.surface.status')
    if (
      lastStatus.state === 'live' &&
      lastStatus.transport === expectedSurfaceTransport &&
      lastStatus.backing === expectedSurfaceBacking &&
      (lastStatus.targetFps ?? 0) >= 60 &&
      lastStatus.framesRendered > previousFrames
    ) {
      return lastStatus
    }
    await sleep(150)
  }
  throw new Error(`Native preview surface did not become live. Last status: ${JSON.stringify(lastStatus)}`)
}

async function waitForHiddenNativeSurface(ws) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    lastStatus = await request(ws, timeoutMs, 'preview.surface.status')
    if (
      lastStatus.state !== 'live' &&
      lastStatus.transport === 'unavailable' &&
      lastStatus.backing === 'none' &&
      (lastStatus.framesRendered ?? 0) === 0
    ) {
      return lastStatus
    }
    await sleep(150)
  }
  throw new Error(`Native preview surface did not stay hidden. Last status: ${JSON.stringify(lastStatus)}`)
}

function assertHiddenNativeSurfaceStatus(scenario, status) {
  if (
    status.state === 'live' ||
    status.transport !== 'unavailable' ||
    status.backing !== 'none' ||
    (status.framesRendered ?? 0) !== 0
  ) {
    throw new Error(`[${scenario.label}] Expected hidden native preview surface, got ${JSON.stringify(status)}.`)
  }
}

async function waitForNativePreviewDiagnostics(samples) {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  let lastDiagnostics = null
  while (Date.now() < deadline) {
    for (const sample of samples) {
      if ((sample.receivedAt ?? 0) < startedAt) {
        continue
      }
      lastDiagnostics = sample
      if (
        sample.previewTransport === expectedSurfaceTransport &&
        sample.previewSurfaceBacking === expectedSurfaceBacking &&
        (sample.previewPresentFps ?? 0) >= minPreviewFps
      ) {
        return sample
      }
    }
    await sleep(250)
  }
  throw new Error(
    `Passive diagnostics did not report ${expectedSurfaceTransport}/${expectedSurfaceBacking} preview before recording. Last diagnostics: ${JSON.stringify(lastDiagnostics)}`
  )
}

function assertNativeBootstrap(result, options = {}) {
  if (!result.hasStage || !result.hasSurface) {
    throw new Error(`Preview stage did not render: ${JSON.stringify(result)}`)
  }
  if (!result.hasVideorcBridge || !result.hasCreateNativePreviewSurface || !result.hasUpdateNativePreviewSurfaceBounds) {
    throw new Error(`Native preview bridge is incomplete: ${JSON.stringify(result)}`)
  }
  if (options.requireNativePreview) {
    if (!result.hasNativePlaceholder) {
      throw new Error(`Preview stage did not render the native surface placeholder: ${JSON.stringify(result)}`)
    }
    if ((result.previewImageCount ?? 0) !== 0 || result.hasJpegPollingPreviewImage) {
      throw new Error(`Native preview rendered a JPEG/MJPEG fallback image: ${JSON.stringify(result)}`)
    }
  }
}

function assertNativeMeasurement(measurement) {
  if ((measurement.measuredFps ?? 0) < minPreviewFps) {
    throw new Error(`Native preview measured ${format(measurement.measuredFps)}fps, below ${minPreviewFps}.`)
  }
  if ((measurement.intervalP95Ms ?? Number.POSITIVE_INFINITY) > maxPreviewIntervalP95Ms) {
    throw new Error(
      `Native preview p95 interval ${format(measurement.intervalP95Ms)}ms exceeded ${maxPreviewIntervalP95Ms}ms.`
    )
  }
  if (
    measurement.inputToPresentLatencyP95Ms != null &&
    measurement.inputToPresentLatencyP95Ms > maxPreviewInputToPresentLatencyP95Ms
  ) {
    throw new Error(
      `Native preview source-to-present p95 ${format(measurement.inputToPresentLatencyP95Ms)}ms exceeded ${format(maxPreviewInputToPresentLatencyP95Ms)}ms.`
    )
  }
  if (
    measurement.inputToPresentLatencyP99Ms != null &&
    measurement.inputToPresentLatencyP99Ms > maxPreviewInputToPresentLatencyP99Ms
  ) {
    throw new Error(
      `Native preview source-to-present p99 ${format(measurement.inputToPresentLatencyP99Ms)}ms exceeded ${format(maxPreviewInputToPresentLatencyP99Ms)}ms.`
    )
  }
  if (measurement.compositorFrameLag != null && measurement.compositorFrameLag > maxPreviewCompositorFrameLag) {
    throw new Error(
      `Native preview compositor lag ${format(measurement.compositorFrameLag)} frame(s) exceeded ${format(maxPreviewCompositorFrameLag)}.`
    )
  }
  if ((measurement.blankFrames ?? 0) > 0) {
    throw new Error(`Native preview reported ${measurement.blankFrames} blank frame(s).`)
  }
}

function assertAnalyzerReportHealthy(scenario, name, report) {
  if (report.verdict.pass) {
    return
  }
  const failures = report.verdict.failures?.length ? report.verdict.failures.join('; ') : 'unknown failure'
  throw new Error(`[${scenario.label}] ${name} analyzer failed: ${failures}`)
}

function assertRecordingDurationHealthy(scenario, report, expectedDurationMs) {
  const expectedSeconds = expectedDurationMs / 1000
  const duration = report.metrics.durationSeconds
  if (!Number.isFinite(duration)) {
    throw new Error(`[${scenario.label}] Final recording duration was unavailable.`)
  }
  const toleranceSeconds = 1.5
  if (duration < expectedSeconds - toleranceSeconds || duration > expectedSeconds + toleranceSeconds) {
    throw new Error(
      `[${scenario.label}] Final recording duration ${duration.toFixed(2)}s was outside ${expectedSeconds.toFixed(2)}s ± ${toleranceSeconds.toFixed(2)}s.`
    )
  }
}

function assertStatsHealthy(scenario, stats, reports = {}, options = {}) {
  if (stats.minSpeed === null) {
    throw new Error(`[${scenario.label}] No encoder speed diagnostics were captured after ${warmupMs}ms warm-up.`)
  }
  if (stats.minSpeed < minSpeed) {
    const startupPassed = reports.startupReport?.verdict?.pass === true
    const recordingPassed = reports.recordingReport?.verdict?.pass === true
    if (!startupPassed || !recordingPassed) {
      throw new Error(`[${scenario.label}] Encoder speed ${format(stats.minSpeed)}x fell below ${minSpeed}x.`)
    }
    console.warn(
      `[${scenario.label}] Encoder progress speed dipped to ${format(stats.minSpeed)}x below ${minSpeed}x, but decoded startup and final-file gates passed.`
    )
  }
  if (stats.minFps === null) {
    throw new Error(`[${scenario.label}] No FPS diagnostics were captured after ${warmupMs}ms warm-up.`)
  }
  const minFps = scenario.fps * 0.9
  if (stats.minFps < minFps) {
    const startupPassed = reports.startupReport?.verdict?.pass === true
    const recordingPassed = reports.recordingReport?.verdict?.pass === true
    if (!startupPassed || !recordingPassed) {
      throw new Error(`[${scenario.label}] FPS ${format(stats.minFps)} fell below ${format(minFps)}.`)
    }
    console.warn(
      `[${scenario.label}] Live diagnostics FPS dipped to ${format(stats.minFps)} below ${format(minFps)}, but decoded startup and final-file gates passed.`
    )
  }
  if (options.previewExpected === false) {
    assertHiddenPreviewStats(scenario, stats)
  } else {
    assertVisiblePreviewStats(scenario, stats)
  }
  if (stats.droppedFrames > 0) {
    throw new Error(`[${scenario.label}] FFmpeg reported ${stats.droppedFrames} dropped frame(s).`)
  }
  if ((stats.maxEncoderBridgeMetalTargetFrames ?? 0) <= 0) {
    throw new Error(
      `[${scenario.label}] Recording diagnostics never observed IOSurface-backed Metal target frames.`
    )
  }
  if (stats.micDroppedFrames > 0) {
    throw new Error(`[${scenario.label}] Native microphone reported ${stats.micDroppedFrames} dropped frame(s).`)
  }
  if (stats.maintenanceSamples > 0) {
    throw new Error(`[${scenario.label}] Recording overlapped ${stats.maintenanceSamples} maintenance FFmpeg sample(s).`)
  }
  if (stats.duplicateCaptureSamples > 0) {
    throw new Error(`[${scenario.label}] Recording reported ${stats.duplicateCaptureSamples} duplicate capture diagnostic sample(s).`)
  }
}

function assertVisiblePreviewStats(scenario, stats) {
  if (stats.minPreviewPresentFps === null) {
    throw new Error(`[${scenario.label}] No preview-present diagnostics were captured after ${warmupMs}ms warm-up.`)
  }
  const minPreviewPresentFps = scenario.fps * 0.9
  if (stats.minPreviewPresentFps < minPreviewPresentFps) {
    console.warn(
      `[${scenario.label}] Preview compositor-present diagnostics dipped to ${format(stats.minPreviewPresentFps)} below ${format(minPreviewPresentFps)}, but direct proof-host measurement passed.`
    )
  }
  if (stats.maxPreviewRenderFrameTimeP95Ms !== null && stats.maxPreviewRenderFrameTimeP95Ms > maxPreviewIntervalP95Ms) {
    console.warn(
      `[${scenario.label}] Preview render-interval diagnostics reached ${format(stats.maxPreviewRenderFrameTimeP95Ms)}ms above ${format(maxPreviewIntervalP95Ms)}ms, but direct proof-host interval measurement passed.`
    )
  }
  if (stats.maxPreviewInputToPresentLatencyP95Ms === null) {
    throw new Error(`[${scenario.label}] No preview source-to-present p95 diagnostics were captured after ${warmupMs}ms warm-up.`)
  }
  if (stats.maxPreviewInputToPresentLatencyP95Ms > maxPreviewInputToPresentLatencyP95Ms) {
    throw new Error(
      `[${scenario.label}] Preview source-to-present p95 ${format(stats.maxPreviewInputToPresentLatencyP95Ms)}ms exceeded ${format(maxPreviewInputToPresentLatencyP95Ms)}ms.`
    )
  }
  if (stats.maxPreviewInputToPresentLatencyP99Ms === null) {
    throw new Error(`[${scenario.label}] No preview source-to-present p99 diagnostics were captured after ${warmupMs}ms warm-up.`)
  }
  if (stats.maxPreviewInputToPresentLatencyP99Ms > maxPreviewInputToPresentLatencyP99Ms) {
    throw new Error(
      `[${scenario.label}] Preview source-to-present p99 ${format(stats.maxPreviewInputToPresentLatencyP99Ms)}ms exceeded ${format(maxPreviewInputToPresentLatencyP99Ms)}ms.`
    )
  }
  if (stats.maxPreviewCompositorFrameLag !== null && stats.maxPreviewCompositorFrameLag > maxPreviewCompositorFrameLag) {
    throw new Error(
      `[${scenario.label}] Preview compositor lag ${format(stats.maxPreviewCompositorFrameLag)} frame(s) exceeded ${format(maxPreviewCompositorFrameLag)}.`
    )
  }
}

function assertHiddenPreviewStats(scenario, stats) {
  if (stats.nativePreviewSamples > 0) {
    throw new Error(`[${scenario.label}] Hidden-preview recording still reported ${stats.nativePreviewSamples} live preview sample(s).`)
  }
  const staleFields = [
    ['previewPresentFps', stats.minPreviewPresentFps],
    ['previewInputToPresentLatencyP95Ms', stats.maxPreviewInputToPresentLatencyP95Ms],
    ['previewInputToPresentLatencyP99Ms', stats.maxPreviewInputToPresentLatencyP99Ms],
    ['previewCompositorFrameLag', stats.maxPreviewCompositorFrameLag],
    ['previewRenderFrameTimeP95Ms', stats.maxPreviewRenderFrameTimeP95Ms]
  ].filter(([, value]) => value !== null)
  if (staleFields.length > 0) {
    throw new Error(
      `[${scenario.label}] Hidden-preview diagnostics retained stale preview metrics: ${staleFields
        .map(([name, value]) => `${name}=${format(value)}`)
        .join(', ')}.`
    )
  }
}

async function audioVideoSkewMs(outputPath) {
  const probe = await run(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    outputPath
  ])
  if (probe.status !== 0) {
    throw new Error(`ffprobe failed for ${outputPath}: ${probe.stderr.trim()}`)
  }
  const parsed = JSON.parse(probe.stdout)
  const formatDuration = Number(parsed.format?.duration)
  const durations = new Map()
  for (const stream of parsed.streams ?? []) {
    const duration = Number(stream.duration)
    if (Number.isFinite(duration)) {
      durations.set(stream.codec_type, duration)
    }
  }
  const video = durations.get('video') ?? formatDuration
  const audio = durations.get('audio') ?? formatDuration
  if (!Number.isFinite(video) || !Number.isFinite(audio)) {
    throw new Error(`Could not read audio/video durations from ${outputPath}.`)
  }
  return Math.abs(video - audio) * 1000
}

async function assertFfprobeAvailable() {
  try {
    const result = await run(ffprobePath, ['-version'])
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `exit ${result.status}`)
    }
  } catch (error) {
    throw new Error(`FFprobe is required for A/V skew checks. Set VIDEORC_SMOKE_FFPROBE_PATH. ${error.message}`)
  }
}

async function smokeCommand(smoke, command, params = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      return await sendSmokeCommand(smoke, command, params)
    } catch (error) {
      lastError = error
      if (!String(error?.message ?? error).includes('Main window is not ready')) {
        throw error
      }
      await sleep(150)
    }
  }
  throw lastError ?? new Error(`${command} smoke command timed out.`)
}

async function sendSmokeCommand(smoke, command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, params })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `${command} smoke command failed.`)
  }
  return payload.result
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repoRoot })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      stdout += text
    })
    child.stderr.on('data', (text) => {
      stderr += text
    })
    child.on('error', rejectRun)
    child.on('exit', (code) => resolveRun({ status: code ?? 1, stdout, stderr }))
  })
}

function launchAndReadConnections() {
  return new Promise((resolveConnections, rejectConnections) => {
    const timer = setTimeout(() => {
      rejectConnections(new Error(`Timed out waiting for smoke connections after ${timeoutMs}ms.`))
    }, timeoutMs)
    const connections = { backend: null, smoke: null }

    appProcess = spawn('pnpm', ['dev'], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
        VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
        VIDEORC_SMOKE_PREVIEW_MOTION: '1',
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const maybeResolve = () => {
      if (connections.backend && connections.smoke) {
        clearTimeout(timer)
        resolveConnections(connections)
      }
    }
    const handleOutput = (text) => handleAppOutput(text, connections, maybeResolve)

    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', handleOutput)
    appProcess.stderr.on('data', handleOutput)
    appProcess.on('error', (error) => {
      clearTimeout(timer)
      rejectConnections(error)
    })
    appProcess.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectConnections(
        new Error(`Native-preview recording app exited before smoke completed: code=${code} signal=${signal}`)
      )
    })
  })
}

async function launchAndReadConnectionsWithRetry() {
  let lastError = null
  const attempts = Math.max(1, Math.floor(launchAttempts))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchAndReadConnections()
    } catch (error) {
      lastError = error
      await stopApp()
      appProcess = null
      if (attempt >= attempts) {
        throw error
      }
      console.warn(
        `Native-preview smoke launch attempt ${attempt}/${attempts} failed before connections were ready: ${error.message}`
      )
      await sleep(1000)
    }
  }
  throw lastError ?? new Error('Native-preview smoke failed before launch.')
}

function handleAppOutput(text, connections, maybeResolve) {
  for (const line of text.split(/\r?\n/)) {
    outputGuard.inspectLine(line)
    if (line.trim() && !stopping) {
      console.log(line)
    }

    const backendMarker = '[smoke] backend-ready '
    const backendIndex = line.indexOf(backendMarker)
    if (backendIndex !== -1) {
      connections.backend = JSON.parse(line.slice(backendIndex + backendMarker.length))
      maybeResolve()
      continue
    }

    const smokeMarker = '[smoke] preview-motion-ready '
    const smokeIndex = line.indexOf(smokeMarker)
    if (smokeIndex !== -1) {
      connections.smoke = JSON.parse(line.slice(smokeIndex + smokeMarker.length))
      maybeResolve()
    }
  }
}

function stopApp() {
  return new Promise((resolveStop) => {
    if (!appProcess?.pid || appProcess.killed) {
      stopping = false
      resolveStop()
      return
    }

    const timer = setTimeout(() => {
      killApp('SIGKILL')
      appProcess = null
      stopping = false
      resolveStop()
    }, 5000)

    stopping = true
    appProcess.once('exit', () => {
      clearTimeout(timer)
      appProcess = null
      stopping = false
      resolveStop()
    })
    killApp('SIGTERM')
  })
}

function killApp(signal) {
  if (!appProcess?.pid) {
    return
  }

  try {
    process.kill(-appProcess.pid, signal)
  } catch {
    appProcess.kill(signal)
  }
}

function resolveSiblingFfprobe(path) {
  if (!path.includes('/')) {
    return null
  }
  const candidate = join(dirname(path), 'ffprobe')
  return existsSync(candidate) ? candidate : null
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function format(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a'
}

function formatBytes(value) {
  if (typeof value !== 'number') {
    return 'n/a'
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)}KiB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)}MiB`
}
