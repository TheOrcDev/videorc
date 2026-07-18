import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertEncoderBridgeVideoOutputHealthy } from './lib/encoder-bridge-output-gates.mjs'
import { resolveExistingSiblingFfprobe } from './lib/ffmpeg-sibling-paths.mjs'
import { performanceAppSpawnSpec, smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { assertSmokeCommandConnection } from './lib/smoke-command-client.mjs'
import { assertSourceCompleteCompositorHealthy } from './lib/native-preview-source-gates.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import {
  minimumProofSourceFrameDelta,
  resolveNativePreviewLatencyBudgets,
  summarizeNativePreviewRecordingDiagnostics
} from './lib/native-preview-diagnostics.mjs'
import { createPreviewSurfaceOutputGuard } from './lib/smoke-output-guards.mjs'
import { previewWindowSurfaceReady } from './lib/native-preview-window-gates.mjs'
import { evaluateRecordingWallDuration } from './lib/recording-duration-gate.mjs'
import {
  nativeWindowsScreenCandidates,
  nativeWindowsScreenRecordingActive
} from './lib/windows-native-screen-gates.mjs'
import {
  analyzeStartupResolution,
  writeStartupReports
} from './lib/startup-resolution-analyzer.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-recording-native-preview-${Date.now()}`)
)
const packagedSpawnSpec = performanceAppSpawnSpec()
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'videorc-native-preview-smoke-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath =
  process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? resolveExistingSiblingFfprobe(ffmpegPath) ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const launchAttempts = Number(process.env.VIDEORC_NATIVE_PREVIEW_LAUNCH_ATTEMPTS ?? 2)
const recordingMs = Number(process.env.VIDEORC_NATIVE_PREVIEW_RECORDING_MS ?? 15000)
const warmupMs = Number(process.env.VIDEORC_NATIVE_PREVIEW_WARMUP_MS ?? 5000)
const previewMeasurementMs = Number(
  process.env.VIDEORC_NATIVE_PREVIEW_MEASUREMENT_MS ??
    Math.max(3000, Math.min(6000, recordingMs - 1500))
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
const maxPreviewCompositorFrameLag = Number(
  process.env.VIDEORC_NATIVE_PREVIEW_MAX_COMPOSITOR_FRAME_LAG ?? 2
)
const layoutStressUpdates = Number(process.env.VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES ?? 0)
const layoutStressIntervalMs = Number(
  process.env.VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_INTERVAL_MS ?? 750
)
const includeHiddenPreviewScenario = process.env.VIDEORC_NATIVE_PREVIEW_INCLUDE_HIDDEN === '1'
const sourceCompleteScene = process.env.VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE === '1'
const bridgeVideoToolboxProbe = process.env.VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE === '1'
const bridgeVideoOutput =
  process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT ?? 'videotoolbox-h264-mpegts'
const reportOnly = process.env.VIDEORC_NATIVE_PREVIEW_REPORT_ONLY === '1'
const expectNativeMetalPreview =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ||
  (process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW !== '0' && process.platform === 'darwin')
const expectedSurfaceTransport = expectNativeMetalPreview
  ? 'native-surface'
  : 'electron-proof-surface'
const expectedSurfaceBacking = expectNativeMetalPreview
  ? 'cametal-layer'
  : 'electron-browser-window'
const exerciseProofFramePolling = process.env.VIDEORC_NATIVE_PREVIEW_EXERCISE_PROOF_POLLING === '1'
const usePackagedWindowsScreen =
  Boolean(packagedSpawnSpec) && process.platform === 'win32' && exerciseProofFramePolling
const recordingProofPollingIntervalMs = 125
const recordingProofPollingMaxWidth = 960
const previewLatencyBudgets = resolveNativePreviewLatencyBudgets({
  configuredP95Ms: maxPreviewInputToPresentLatencyP95Ms,
  configuredP99Ms: maxPreviewInputToPresentLatencyP99Ms,
  sourceCompleteScene,
  expectNativeMetalPreview,
  exerciseProofFramePolling,
  proofPollingIntervalMs: usePackagedWindowsScreen
    ? recordingProofPollingIntervalMs
    : undefined
})

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
let packagedWindowsScreen = null
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
  assertSmokeCommandConnection(smoke)
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
      throw new Error(
        health?.ffmpeg?.message ?? 'FFmpeg is unavailable for native-preview recording smoke.'
      )
    }
    await assertFfprobeAvailable()
    console.log(`Native-preview recording smoke using FFmpeg: ${ffmpegPath}`)
    console.log(`Native-preview recording smoke using FFprobe: ${ffprobePath}`)
    console.log(
      `Native-preview recording smoke source scene: ${sourceCompleteScene ? 'source-complete synthetic overlay' : 'default missing-camera fallback repro'}`
    )
    console.log(
      `Native-preview recording smoke bridge VT probe: ${bridgeVideoToolboxProbe ? 'enabled' : 'disabled'}; report-only gates: ${reportOnly ? 'enabled' : 'disabled'}`
    )
    console.log(`Native-preview recording smoke bridge video output: ${bridgeVideoOutput}`)

    if (usePackagedWindowsScreen) {
      packagedWindowsScreen = await startPackagedWindowsScreenPreview(ws)
      console.log(
        `Native-preview recording smoke selected real Windows source ${packagedWindowsScreen.id}.`
      )
    }

    await smokeCommand(smoke, 'open-tab', {
      tab: 'studio',
      waitFor: '[data-videorc-preview-card]'
    })
    if (usePackagedWindowsScreen) {
      await applyPackagedWindowsScreenLayout(ws)
    }
    const bootstrap = await smokeCommand(smoke, 'inspect-native-preview-bootstrap')
    assertNativeBootstrap(bootstrap)
    await smokeCommand(smoke, 'preview-window-open')
    await waitForPreviewWindowSurface(smoke)
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
    if (packagedWindowsScreen) {
      try {
        await request(ws, timeoutMs, 'preview.screen.stop')
      } catch {
        // App teardown is authoritative if the source already stopped.
      }
      packagedWindowsScreen = null
    }
    ws.close()
  }
}

async function startPackagedWindowsScreenPreview(ws) {
  const devices = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const candidates = nativeWindowsScreenCandidates(devices?.devices ?? [])
  const failures = []
  const scenario = visibleScenarios[0]
  for (const candidate of candidates) {
    const status = await request(ws, timeoutMs, 'preview.screen.start', {
      sources: { screenId: candidate.id, testPattern: false },
      video: {
        preset: 'custom',
        width: scenario.width,
        height: scenario.height,
        fps: scenario.fps,
        bitrateKbps: scenario.bitrateKbps
      },
      protectedOverlayWindowIds: [],
      ffmpegPath
    })
    if (status?.state === 'live') {
      return candidate
    }
    failures.push(`${candidate.id}: ${status?.state} ${status?.message ?? ''}`)
    await request(ws, timeoutMs, 'preview.screen.stop')
  }
  throw new Error(
    `No real Windows screen source could feed packaged preview polling: ${failures.join('; ') || 'no candidates'}`
  )
}

async function applyPackagedWindowsScreenLayout(ws) {
  const scenario = visibleScenarios[0]
  const params = sessionParams(scenario)
  const intentId = Date.now()
  const status = await request(ws, timeoutMs, 'scene.layout.apply_preview', {
    intentId,
    sources: params.sources,
    layout: params.layout,
    video: params.output.video,
    background: null,
    protectedOverlayWindowIds: []
  })
  if (
    status?.intentId !== intentId ||
    status?.compositorStatus?.sceneLayout?.layoutPreset !== 'screen-only'
  ) {
    throw new Error(
      `Packaged Windows preview did not commit ScreenOnly layout intent ${intentId}: ${JSON.stringify(status)}`
    )
  }
}

async function runNativePreviewRecordingScenario(
  ws,
  smoke,
  samples,
  previewSurfaceSamples,
  scenario,
  previousSurface
) {
  samples.length = 0
  previewSurfaceSamples.length = 0
  const expectsPreview = scenario.previewVisible !== false
  const scenarioStartedAt = Date.now()
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    await sessionParamsForStart(smoke, scenario)
  )
  if (started.state !== 'recording') {
    throw new Error(
      `[${scenario.label}] Expected recording state after start, got ${started.state}.`
    )
  }
  const recordingStartedAt = Date.now()
  let measurement = null
  let measurementFailure = null
  let surfaceDuring = null
  let scenarioFailure = null
  try {
    if (packagedSpawnSpec) {
      await waitForPackagedActiveSceneDiagnostics(ws, packagedWindowsScreen?.id)
    } else {
      const activeSceneRevision = Date.now()
      const compositorStatus = await smokeCommand(smoke, 'backend-debug-rpc', {
        method: 'compositor.scene.update',
        params: compositorSceneUpdateParams(activeSceneRevision, 0.58),
        timeoutMs
      })
      if (compositorStatus.sceneRevision !== activeSceneRevision) {
        throw new Error(
          `[${scenario.label}] Compositor scene update returned revision ${compositorStatus.sceneRevision}, expected ${activeSceneRevision}.`
        )
      }
      await waitForActiveSceneDiagnostics(ws, activeSceneRevision, 'record')
    }
    await assertSameRunningSession(ws, started.sessionId)
    if (expectsPreview && expectNativeMetalPreview) {
      const pumpReconnect = await smokeCommand(smoke, 'exercise-main-present-pump-reconnect')
      assertMainPumpReconnectDuringRecording(scenario, pumpReconnect)
    }

    const measurementResultPromise = (expectsPreview
      ? smokeCommand(smoke, 'measure-native-preview-surface', {
          durationMs: previewMeasurementMs,
          warmupMs
        })
      : Promise.resolve(null)
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )
    const stressResultPromise = stressLayoutDuringRecording(
      ws,
      smoke,
      started.sessionId,
      layoutStressUpdates
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    )
    await sleep(recordingMs)
    const [measurementResult, stressResult] = await Promise.all([
      measurementResultPromise,
      stressResultPromise
    ])
    if (!stressResult.ok) {
      throw stressResult.error
    }
    if (measurementResult.ok) {
      measurement = measurementResult.value
    } else {
      measurementFailure = `Native preview measurement command failed: ${errorMessage(measurementResult.error)}`
    }
    if (expectsPreview && !measurementFailure) {
      console.log(
        `[${scenario.label}] Native preview steady measurement: ${JSON.stringify(measurement)}`
      )
      try {
        assertNativeMeasurement(scenario, measurement)
      } catch (error) {
        measurementFailure = errorMessage(error)
      }
    }

    surfaceDuring = expectsPreview
      ? await waitForNativeSurface(ws, previousSurface.framesRendered)
      : await waitForHiddenNativeSurface(ws)
  } catch (error) {
    scenarioFailure = error
  }

  const stopRequestedAt = Date.now()
  const expectedDurationMs = stopRequestedAt - recordingStartedAt
  let stopped
  try {
    stopped = await request(ws, timeoutMs, 'session.stop')
  } catch (stopError) {
    if (scenarioFailure) {
      throw new AggregateError(
        [scenarioFailure, stopError],
        `[${scenario.label}] Recording scenario failed and could not be stopped cleanly.`
      )
    }
    throw stopError
  }
  if (scenarioFailure) {
    throw scenarioFailure
  }
  if (!surfaceDuring) {
    throw new Error(`[${scenario.label}] Preview surface evidence was unavailable after recording.`)
  }
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(
      `[${scenario.label}] Recording output was not created: ${outputPath ?? 'missing path'}`
    )
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
      intendedFps: scenario.fps,
      gates: { requireMotion: !usePackagedWindowsScreen }
    }),
    analyzeRecording(outputPath, {
      ffmpegPath,
      ffprobePath,
      intendedFps: scenario.fps,
      expectAudio: !usePackagedWindowsScreen,
      gates: { requireMotion: !usePackagedWindowsScreen }
    })
  ])
  const [startupReportPaths, recordingReportPaths] = await Promise.all([
    writeStartupReports(startupReport, { ffmpegPath }),
    Promise.resolve(writeReports(recordingReport))
  ])
  const measurementStartedAtMs = Number.isFinite(measurement?.measurementStartedAtMs)
    ? measurement.measurementStartedAtMs
    : null
  const stats = summarizeNativePreviewRecordingDiagnostics(samples, {
    targetFps: scenario.fps,
    startedAt: measurementStartedAtMs ?? scenarioStartedAt,
    stopRequestedAt,
    warmupMs: measurementStartedAtMs === null ? warmupMs : 0,
    expectedSurfaceTransport,
    expectedSurfaceBacking,
    previewSurfaceSamples
  })
  const bridgeSummary = formatBridgeCopySummary(stats)
  assertAnalyzerReportHealthy(scenario, 'startup', startupReport, {
    diagnosticsSummary: bridgeSummary,
    reportPath: startupReportPaths.mdPath
  })
  assertAnalyzerReportHealthy(scenario, 'final-file', recordingReport, {
    diagnosticsSummary: bridgeSummary,
    reportPath: recordingReportPaths.mdPath
  })
  assertRecordingDurationHealthy(scenario, recordingReport, expectedDurationMs)
  if (measurementFailure) {
    failOrWarn(
      `[${scenario.label}] ${measurementFailure} Measurement: ${JSON.stringify(measurement)}. Diagnostics: ${bridgeSummary}`
    )
  }

  assertStatsHealthy(
    scenario,
    stats,
    { startupReport, recordingReport },
    { previewExpected: expectsPreview }
  )
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

  const skew = usePackagedWindowsScreen ? null : await audioVideoSkewMs(outputPath)
  if (skew != null && skew > maxSkewMs) {
    failOrWarn(
      `[${scenario.label}] Audio/video duration skew ${skew.toFixed(1)}ms exceeded ${maxSkewMs}ms.`
    )
  }
  const measuredCompositorLag =
    measurement?.compositorFrameLag ?? stats.maxPreviewCompositorFrameLag
  const previewSummary = expectsPreview
    ? `preview ${format(measurement.measuredFps)}fps, p95 ${format(measurement.intervalP95Ms)}ms, diagnostic present ${format(stats.minPreviewPresentFps)}fps, source-to-present p95 ${format(stats.maxPreviewInputToPresentLatencyP95Ms)}ms/p99 ${format(stats.maxPreviewInputToPresentLatencyP99Ms)}ms, compositor lag ${format(measuredCompositorLag)} frame(s)`
    : `preview hidden, live preview samples ${stats.nativePreviewSamples}`
  const handoffSummary = expectsPreview
    ? `, handoff p95 renderer poll ${format(stats.maxNativePreviewRendererPollIntervalP95Ms)}ms / present RTT ${format(stats.maxNativePreviewRendererPresentRoundTripP95Ms)}ms / main queue ${format(stats.maxNativePreviewMainQueueWaitP95Ms)}ms / main present ${format(stats.maxNativePreviewMainPresentP95Ms)}ms / helper ${format(stats.maxNativePreviewHelperRoundTripP95Ms)}ms`
    : ''

  console.log(
    `Native-preview recording [${scenario.label}] OK: ${outputPath} (${size} bytes), ${previewSummary}${handoffSummary}, startup repeat ${format(startupReport.metrics.maxRepeatedFrameRun, 0)}, final repeat ${format(recordingReport.metrics.maxRepeatedFrameRun, 0)}, ${bridgeSummary}, A/V skew ${skew == null ? 'not expected' : `${skew.toFixed(1)}ms`}, layout stress ${layoutStressUpdates} update(s), maintenance samples ${stats.maintenanceSamples}, duplicate samples ${stats.duplicateCaptureSamples}, max RSS ${formatBytes(stats.maxBackendRssBytes)}, max FFmpeg procs ${stats.maxActiveFfmpegProcesses}, max FFprobe procs ${stats.maxActiveFfprobeProcesses}, startup report ${startupReportPaths.mdPath}, quality report ${recordingReportPaths.mdPath}`
  )
  return surfaceDuring
}

function assertMainPumpReconnectDuringRecording(scenario, result) {
  if (
    result.watchdogDetected !== true ||
    result.fallback?.observed !== true ||
    (result.fallback?.frameDelta ?? 0) < 10 ||
    result.reconnected !== true ||
    (result.finalFrameDelta ?? 0) <= result.fallback.frameDelta
  ) {
    throw new Error(
      `[${scenario.label}] Native preview pump handoff failed during recording: ${JSON.stringify(result)}`
    )
  }
  console.log(
    `[${scenario.label}] Native preview pump handoff advanced ${result.fallback.frameDelta} renderer-fallback frames and reconnected main at +${result.finalFrameDelta} frames.`
  )
}

async function showNativePreviewSurface(ws, smoke, samples) {
  await smokeCommand(smoke, 'resume-native-preview-surface')
  await smokeCommand(smoke, 'open-tab', {
    tab: 'studio',
    waitFor: '[data-videorc-preview-card]'
  })
  await smokeCommand(smoke, 'preview-window-open')
  await waitForPreviewWindowSurface(smoke)
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
    throw new Error(
      `Scene update restarted or stopped recording: expected ${sessionId}/recording, got ${status.sessionId}/${status.state}.`
    )
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

async function waitForPackagedActiveSceneDiagnostics(ws, screenId) {
  const deadline = Date.now() + timeoutMs
  let lastEvidence = null
  while (Date.now() < deadline) {
    const [diagnostics, compositor, recording] = await Promise.all([
      request(ws, timeoutMs, 'diagnostics.stats'),
      request(ws, timeoutMs, 'compositor.status'),
      request(ws, timeoutMs, 'recording.status')
    ])
    lastEvidence = { diagnostics, compositor, recording }
    if (
      (!screenId && diagnostics.activeOutputMode === 'record') ||
      (screenId && nativeWindowsScreenRecordingActive(lastEvidence, screenId))
    ) {
      return diagnostics
    }
    await sleep(150)
  }
  throw new Error(
    `Packaged recording diagnostics did not report the active scene/source authority. Last evidence: ${JSON.stringify(lastEvidence)}`
  )
}

async function stressLayoutDuringRecording(ws, smoke, sessionId, count) {
  for (let index = 0; index < count; index += 1) {
    await sleep(layoutStressIntervalMs)
    const revision = Date.now() + index
    const cameraX = index % 2 === 0 ? 0.18 : 0.62
    const compositorStatus = await smokeCommand(smoke, 'backend-debug-rpc', {
      method: 'compositor.scene.update',
      params: compositorSceneUpdateParams(revision, cameraX),
      timeoutMs
    })
    if (compositorStatus.sceneRevision !== revision) {
      throw new Error(
        `Layout stress update ${index + 1}/${count} returned revision ${compositorStatus.sceneRevision}, expected ${revision}.`
      )
    }
    await assertSameRunningSession(ws, sessionId)
    await waitForActiveSceneDiagnostics(ws, revision, 'record')
  }
}

async function sessionParamsForStart(smoke, scenario) {
  if (packagedSpawnSpec) {
    return sessionParams(scenario)
  }
  const selection = await smokeCommand(smoke, 'authorize-smoke-resource', {
    kind: 'output-directory',
    path: outputDirectory
  })
  if (typeof selection?.capabilityId !== 'string') {
    throw new Error('Smoke output-directory authorization returned no capability.')
  }
  return sessionParams(scenario, selection.capabilityId)
}

function sessionParams(scenario, outputDirectoryCapability) {
  return {
    sources: packagedWindowsScreen
      ? { screenId: packagedWindowsScreen.id, testPattern: false }
      : { testPattern: true },
    layout: {
      layoutPreset: packagedWindowsScreen ? 'screen-only' : 'screen-camera',
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
      microphoneMuted: usePackagedWindowsScreen,
      microphoneSyncOffsetMs: 0
    }
  }
}

function compositorSceneUpdateParams(revision, cameraX) {
  const baseTransform = fullFrameTransform()
  const overlayTransform = {
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
      x: overlayTransform.x,
      y: overlayTransform.y,
      width: overlayTransform.width,
      height: overlayTransform.height
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
  const overlaySource = sourceCompleteScene
    ? {
        id: 'source:test-pattern-overlay',
        name: 'Test pattern overlay',
        kind: 'test-pattern',
        transform: overlayTransform,
        defaultTransform: overlayTransform,
        visible: true,
        locked: false
      }
    : {
        id: 'source:camera',
        name: 'Camera',
        kind: 'camera',
        transform: overlayTransform,
        defaultTransform: overlayTransform,
        visible: true,
        locked: false
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
        overlaySource
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

async function waitForNativeSurface(ws, previousFrames = 0) {
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
  throw new Error(
    `Native preview surface did not become live. Last status: ${JSON.stringify(lastStatus)}`
  )
}

async function waitForPreviewWindowSurface(smoke) {
  const deadline = Date.now() + timeoutMs
  let lastEvidence = null
  while (Date.now() < deadline) {
    const [windowState, surfaceStatus] = await Promise.all([
      smokeCommand(smoke, 'preview-window-state'),
      smokeCommand(smoke, 'native-preview-surface-status')
    ])
    lastEvidence = { windowState, surfaceStatus }
    if (
      previewWindowSurfaceReady(lastEvidence, {
        expectedTransport: expectedSurfaceTransport,
        expectedBacking: expectedSurfaceBacking,
        expectNativeMetalPreview
      })
    ) {
      return lastEvidence
    }
    await sleep(150)
  }
  throw new Error(
    `Preview window surface did not open as ${expectedSurfaceTransport}/${expectedSurfaceBacking}. Last evidence: ${JSON.stringify(lastEvidence)}`
  )
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
  throw new Error(
    `Native preview surface did not stay hidden. Last status: ${JSON.stringify(lastStatus)}`
  )
}

function assertHiddenNativeSurfaceStatus(scenario, status) {
  if (
    status.state === 'live' ||
    status.transport !== 'unavailable' ||
    status.backing !== 'none' ||
    (status.framesRendered ?? 0) !== 0
  ) {
    throw new Error(
      `[${scenario.label}] Expected hidden native preview surface, got ${JSON.stringify(status)}.`
    )
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
  failOrWarn(
    `Passive diagnostics did not report ${expectedSurfaceTransport}/${expectedSurfaceBacking} preview before recording. Last diagnostics: ${JSON.stringify(lastDiagnostics)}`
  )
  return lastDiagnostics
}

function assertNativeBootstrap(result, options = {}) {
  if (!result.hasStage || !result.hasSurface) {
    throw new Error(`Preview stage did not render: ${JSON.stringify(result)}`)
  }
  if (
    !result.hasVideorcBridge ||
    !result.hasCreateNativePreviewSurface ||
    !result.hasUpdateNativePreviewSurfaceBounds
  ) {
    throw new Error(`Native preview bridge is incomplete: ${JSON.stringify(result)}`)
  }
  if (options.requireNativePreview) {
    if (!result.previewWindowOpen || !result.previewWindowVisible) {
      throw new Error(
        `Detached preview window did not stay open and visible: ${JSON.stringify(result)}`
      )
    }
    if (
      result.surfaceTransport !== expectedSurfaceTransport ||
      result.surfaceBacking !== expectedSurfaceBacking
    ) {
      throw new Error(
        `Preview stage reported ${result.surfaceTransport}/${result.surfaceBacking}, expected ${expectedSurfaceTransport}/${expectedSurfaceBacking}: ${JSON.stringify(result)}`
      )
    }
    if ((result.previewImageCount ?? 0) !== 0 || result.hasJpegPollingPreviewImage) {
      throw new Error(
        `Native preview rendered a JPEG/MJPEG fallback image: ${JSON.stringify(result)}`
      )
    }
  }
}

function assertNativeMeasurement(scenario, measurement) {
  const minMeasurementFps = nativeMeasurementMinFps(scenario)
  const maxMeasurementIntervalP95Ms = nativeMeasurementMaxIntervalP95Ms()
  const maxInputToPresentP95Ms = previewInputToPresentP95BudgetMs()
  const maxInputToPresentP99Ms = previewInputToPresentP99BudgetMs()
  const requireAnimationCadence = expectNativeMetalPreview || !exerciseProofFramePolling

  if (requireAnimationCadence && (measurement.measuredFps ?? 0) < minMeasurementFps) {
    throw new Error(
      `Native preview measured ${format(measurement.measuredFps)}fps, below ${format(minMeasurementFps)}.`
    )
  }
  if (
    requireAnimationCadence &&
    (measurement.intervalP95Ms ?? Number.POSITIVE_INFINITY) > maxMeasurementIntervalP95Ms
  ) {
    throw new Error(
      `Native preview p95 interval ${format(measurement.intervalP95Ms)}ms exceeded ${format(maxMeasurementIntervalP95Ms)}ms.`
    )
  }
  if (
    measurement.inputToPresentLatencyP95Ms != null &&
    measurement.inputToPresentLatencyP95Ms > maxInputToPresentP95Ms
  ) {
    throw new Error(
      `Native preview source-to-present p95 ${format(measurement.inputToPresentLatencyP95Ms)}ms exceeded ${format(maxInputToPresentP95Ms)}ms.`
    )
  }
  if (
    measurement.inputToPresentLatencyP99Ms != null &&
    measurement.inputToPresentLatencyP99Ms > maxInputToPresentP99Ms
  ) {
    throw new Error(
      `Native preview source-to-present p99 ${format(measurement.inputToPresentLatencyP99Ms)}ms exceeded ${format(maxInputToPresentP99Ms)}ms.`
    )
  }
  if (
    measurement.compositorFrameLag != null &&
    measurement.compositorFrameLag > maxPreviewCompositorFrameLag
  ) {
    throw new Error(
      `Native preview compositor lag ${format(measurement.compositorFrameLag)} frame(s) exceeded ${format(maxPreviewCompositorFrameLag)}.`
    )
  }
  if ((measurement.blankFrames ?? 0) > 0) {
    throw new Error(`Native preview reported ${measurement.blankFrames} blank frame(s).`)
  }
  if (!expectNativeMetalPreview && exerciseProofFramePolling) {
    const minimumSourceFrameDelta = minimumProofSourceFrameDelta({
      measurementMs: previewMeasurementMs,
      pollingIntervalMs: recordingProofPollingIntervalMs
    })
    if ((measurement.sourceFrameDelta ?? 0) < minimumSourceFrameDelta) {
      throw new Error(
        `Windows proof preview source frames advanced ${measurement.sourceFrameDelta ?? 0} time(s) during recording, below ${minimumSourceFrameDelta}.`
      )
    }
    if (
      measurement.framePollingIntervalMs !== recordingProofPollingIntervalMs ||
      measurement.framePollingMaxWidth !== recordingProofPollingMaxWidth
    ) {
      throw new Error(
        `Windows recording preview did not apply the contained ${recordingProofPollingIntervalMs}ms/${recordingProofPollingMaxWidth}px polling profile: ${JSON.stringify({ intervalMs: measurement.framePollingIntervalMs, maxWidth: measurement.framePollingMaxWidth })}`
      )
    }
    if (
      (measurement.freshSourceLayerCount ?? 0) <= 0 ||
      (measurement.sourceFrameAgeMs ?? Number.POSITIVE_INFINITY) > 1500
    ) {
      throw new Error(
        `Windows proof preview source liveness failed during recording: ${JSON.stringify({ freshLayers: measurement.freshSourceLayerCount, sourceFrameAgeMs: measurement.sourceFrameAgeMs })}`
      )
    }
  }
}

function nativeMeasurementMinFps(scenario) {
  return sourceCompleteScene ? scenario.fps * 0.9 : minPreviewFps
}

function nativeMeasurementMaxIntervalP95Ms() {
  return sourceCompleteScene ? Math.max(maxPreviewIntervalP95Ms, 120) : maxPreviewIntervalP95Ms
}

function previewInputToPresentP95BudgetMs() {
  return previewLatencyBudgets.p95Ms
}

function previewInputToPresentP99BudgetMs() {
  return previewLatencyBudgets.p99Ms
}

function formatBridgeCopySummary(stats) {
  const fallbackSummary =
    stats.maxCompositorCpuFallbackFrames > 0
      ? `${stats.maxCompositorCpuFallbackFrames}${stats.lastCompositorFallbackReason ? ` (${stats.lastCompositorFallbackReason})` : ''}`
      : '0'
  return `Metal targets ${stats.maxEncoderBridgeMetalTargetFrames}, Metal handles ${stats.maxEncoderBridgeMetalTargetHandleFrames}, raw copied ${stats.maxEncoderBridgeRawVideoCopiedFrames}, Metal copied ${stats.maxEncoderBridgeMetalTargetCopiedFrames}, zero-copy ${stats.maxEncoderBridgeZeroCopyFrames}, VT output ${stats.maxEncoderBridgeVideoToolboxOutputFrames} (${stats.maxEncoderBridgeVideoToolboxOutputBytes} bytes, ${stats.maxEncoderBridgeVideoToolboxOutputEncodeMs}ms max encode), VT probe ${stats.maxEncoderBridgeVideoToolboxProbeFrames} (${stats.maxEncoderBridgeVideoToolboxProbeBytes} bytes, ${stats.maxEncoderBridgeVideoToolboxProbeErrors} errors), bridge repeats ${stats.maxEncoderBridgeRepeatedFrames} across ${stats.maxEncoderBridgeRepeatedFrameBursts} burst(s), max bridge run ${stats.maxEncoderBridgeMaxRepeatedFrameRun}, source age max/p95 ${format(stats.maxEncoderBridgeSourceAgeMs)}/${format(stats.maxEncoderBridgeSourceAgeP95Ms)}ms, repeat age max/p95 ${format(stats.maxEncoderBridgeRepeatedFrameAgeMaxMs)}/${format(stats.maxEncoderBridgeRepeatedFrameAgeP95Ms)}ms, bridge wait p95 ${format(stats.maxEncoderBridgeCompositorWaitP95Ms)}ms, VT submit p95 ${format(stats.maxEncoderBridgeVideoToolboxSubmitP95Ms)}ms, FIFO write/enqueue p95 ${format(stats.maxEncoderBridgeVideoToolboxFifoWriteP95Ms)}/${format(stats.maxEncoderBridgeVideoToolboxFifoEnqueueP95Ms)}ms, FIFO enqueue max ${format(stats.maxEncoderBridgeVideoToolboxFifoEnqueueMaxMs)}ms, writer total p95 ${format(stats.maxEncoderBridgeWriterLoopP95Ms)}ms, writer sleep/active p95 ${format(stats.maxEncoderBridgeWriterSleepP95Ms)}/${format(stats.maxEncoderBridgeWriterActiveP95Ms)}ms, deadline lag p95/max ${format(stats.maxEncoderBridgeDeadlineLagP95Ms)}/${format(stats.maxEncoderBridgeDeadlineLagMaxMs)}ms (${stats.maxEncoderBridgeLateDeadlineTicks} late tick(s)), CPU fallback frames ${fallbackSummary}, min speed ${format(stats.minSpeed)}x, min FPS ${format(stats.minFps)}`
}

function assertAnalyzerReportHealthy(scenario, name, report, context = {}) {
  if (report.verdict.pass) {
    return
  }
  const failures = report.verdict.failures?.length
    ? report.verdict.failures.join('; ')
    : 'unknown failure'
  const diagnostics = context.diagnosticsSummary
    ? `; diagnostics: ${context.diagnosticsSummary}`
    : ''
  const reportPath = context.reportPath ? `; report ${context.reportPath}` : ''
  failOrWarn(`[${scenario.label}] ${name} analyzer failed: ${failures}${diagnostics}${reportPath}`)
}

function assertRecordingDurationHealthy(scenario, report, expectedDurationMs) {
  const expectedSeconds = expectedDurationMs / 1000
  const duration = report.metrics.durationSeconds
  if (!Number.isFinite(duration)) {
    throw new Error(`[${scenario.label}] Final recording duration was unavailable.`)
  }
  const wallDurationFailures = evaluateRecordingWallDuration({
    expectedDurationMs,
    actualDurationSeconds: duration
  })
  if (wallDurationFailures.length > 0) {
    throw new Error(`[${scenario.label}] ${wallDurationFailures.join('; ')}`)
  }
  const toleranceSeconds = 1.5
  if (
    duration < expectedSeconds - toleranceSeconds ||
    duration > expectedSeconds + toleranceSeconds
  ) {
    failOrWarn(
      `[${scenario.label}] Final recording duration ${duration.toFixed(2)}s was outside ${expectedSeconds.toFixed(2)}s ± ${toleranceSeconds.toFixed(2)}s.`
    )
  }
}

function assertStatsHealthy(scenario, stats, reports = {}, options = {}) {
  try {
    assertStatsHealthyStrict(scenario, stats, reports, options)
  } catch (error) {
    failOrWarn(error.message)
  }
}

function assertStatsHealthyStrict(scenario, stats, reports = {}, options = {}) {
  if (stats.minSpeed === null) {
    throw new Error(
      `[${scenario.label}] No encoder speed diagnostics were captured after ${warmupMs}ms warm-up.`
    )
  }
  if (stats.minSpeed < minSpeed) {
    const startupPassed = reports.startupReport?.verdict?.pass === true
    const recordingPassed = reports.recordingReport?.verdict?.pass === true
    if (!startupPassed || !recordingPassed) {
      throw new Error(
        `[${scenario.label}] Encoder speed ${format(stats.minSpeed)}x fell below ${minSpeed}x.`
      )
    }
    console.warn(
      `[${scenario.label}] Encoder progress speed dipped to ${format(stats.minSpeed)}x below ${minSpeed}x, but decoded startup and final-file gates passed.`
    )
  }
  if (stats.minFps === null) {
    throw new Error(
      `[${scenario.label}] No FPS diagnostics were captured after ${warmupMs}ms warm-up.`
    )
  }
  const minFps = scenario.fps * 0.9
  if (stats.minFps < minFps) {
    const startupPassed = reports.startupReport?.verdict?.pass === true
    const recordingPassed = reports.recordingReport?.verdict?.pass === true
    if (!startupPassed || !recordingPassed) {
      throw new Error(
        `[${scenario.label}] FPS ${format(stats.minFps)} fell below ${format(minFps)}.`
      )
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
  if (expectNativeMetalPreview && (stats.maxEncoderBridgeMetalTargetFrames ?? 0) <= 0) {
    throw new Error(
      `[${scenario.label}] Recording diagnostics never observed IOSurface-backed Metal target frames.`
    )
  }
  assertSourceCompleteCompositorHealthy({
    scenarioLabel: scenario.label,
    stats,
    sourceComplete: sourceCompleteScene,
    allowSyntheticSourceOnly: sourceCompleteScene,
    requiredLiveSourceKinds: []
  })
  assertEncoderBridgeVideoOutputHealthy({
    scenarioLabel: scenario.label,
    stats,
    videoOutput: bridgeVideoOutput
  })
  if (stats.micDroppedFrames > 0) {
    throw new Error(
      `[${scenario.label}] Native microphone reported ${stats.micDroppedFrames} dropped frame(s).`
    )
  }
  if (stats.maintenanceSamples > 0) {
    throw new Error(
      `[${scenario.label}] Recording overlapped ${stats.maintenanceSamples} maintenance FFmpeg sample(s).`
    )
  }
  if (stats.duplicateCaptureSamples > 0) {
    throw new Error(
      `[${scenario.label}] Recording reported ${stats.duplicateCaptureSamples} duplicate capture diagnostic sample(s).`
    )
  }
}

function failOrWarn(message) {
  if (reportOnly) {
    console.warn(`[report-only] ${message}`)
    return
  }
  throw new Error(message)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function assertVisiblePreviewStats(scenario, stats) {
  const maxInputToPresentP95Ms = previewInputToPresentP95BudgetMs()
  const maxInputToPresentP99Ms = previewInputToPresentP99BudgetMs()

  if (stats.minPreviewPresentFps === null) {
    throw new Error(
      `[${scenario.label}] No preview-present diagnostics were captured after ${warmupMs}ms warm-up.`
    )
  }
  const minPreviewPresentFps = scenario.fps * 0.9
  if (stats.minPreviewPresentFps < minPreviewPresentFps) {
    console.warn(
      `[${scenario.label}] Preview compositor-present diagnostics dipped to ${format(stats.minPreviewPresentFps)} below ${format(minPreviewPresentFps)}, but direct proof-host measurement passed.`
    )
  }
  if (
    stats.maxPreviewRenderFrameTimeP95Ms !== null &&
    stats.maxPreviewRenderFrameTimeP95Ms > maxPreviewIntervalP95Ms
  ) {
    console.warn(
      `[${scenario.label}] Preview render-interval diagnostics reached ${format(stats.maxPreviewRenderFrameTimeP95Ms)}ms above ${format(maxPreviewIntervalP95Ms)}ms, but direct proof-host interval measurement passed.`
    )
  }
  if (stats.maxPreviewInputToPresentLatencyP95Ms === null) {
    throw new Error(
      `[${scenario.label}] No preview source-to-present p95 diagnostics were captured after ${warmupMs}ms warm-up.`
    )
  }
  if (stats.maxPreviewInputToPresentLatencyP95Ms > maxInputToPresentP95Ms) {
    throw new Error(
      `[${scenario.label}] Preview source-to-present p95 ${format(stats.maxPreviewInputToPresentLatencyP95Ms)}ms exceeded ${format(maxInputToPresentP95Ms)}ms.`
    )
  }
  if (stats.maxPreviewInputToPresentLatencyP99Ms === null) {
    throw new Error(
      `[${scenario.label}] No preview source-to-present p99 diagnostics were captured after ${warmupMs}ms warm-up.`
    )
  }
  if (stats.maxPreviewInputToPresentLatencyP99Ms > maxInputToPresentP99Ms) {
    throw new Error(
      `[${scenario.label}] Preview source-to-present p99 ${format(stats.maxPreviewInputToPresentLatencyP99Ms)}ms exceeded ${format(maxInputToPresentP99Ms)}ms.`
    )
  }
  if (
    stats.maxPreviewCompositorFrameLag !== null &&
    stats.maxPreviewCompositorFrameLag > maxPreviewCompositorFrameLag
  ) {
    throw new Error(
      `[${scenario.label}] Preview compositor lag ${format(stats.maxPreviewCompositorFrameLag)} frame(s) exceeded ${format(maxPreviewCompositorFrameLag)}.`
    )
  }
}

function assertHiddenPreviewStats(scenario, stats) {
  if (stats.nativePreviewSamples > 0) {
    throw new Error(
      `[${scenario.label}] Hidden-preview recording still reported ${stats.nativePreviewSamples} live preview sample(s).`
    )
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
    throw new Error(
      `FFprobe is required for A/V skew checks. Set VIDEORC_SMOKE_FFPROBE_PATH. ${error.message}`
    )
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
      if (!isRetryableSmokeCommandError(error)) {
        throw error
      }
      await sleep(150)
    }
  }
  throw lastError ?? new Error(`${command} smoke command timed out.`)
}

function isRetryableSmokeCommandError(error) {
  const message = String(error?.message ?? error)
  return (
    message.includes('Main window is not ready') ||
    message.includes('Timed out waiting for [data-videorc-preview-card]') ||
    message.includes('Timed out waiting for active tab') ||
    message.includes('Could not find tab ')
  )
}

async function sendSmokeCommand(smoke, command, params = {}) {
  const controller = new AbortController()
  const commandTimeoutMs = smokeCommandTimeoutMs(params)
  const timer = setTimeout(() => controller.abort(), commandTimeoutMs)
  let response
  try {
    response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${smoke.capability}`
      },
      body: JSON.stringify({ command, params }),
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${command} smoke command timed out after ${commandTimeoutMs}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error(`${command} smoke command returned non-JSON response: ${error.message}`)
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `${command} smoke command failed.`)
  }
  return payload.result
}

function smokeCommandTimeoutMs(params = {}) {
  const durationMs = Number(params.durationMs ?? 0)
  return Math.min(timeoutMs, Math.max(15_000, durationMs + 5_000))
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
    const packagedSmokeCapability = packagedSpawnSpec ? randomBytes(32).toString('base64url') : null
    const spawnCommand = packagedSpawnSpec?.command ?? 'pnpm'
    const spawnArgs = packagedSpawnSpec?.args ?? ['dev']

    appProcess = spawn(spawnCommand, spawnArgs, {
      cwd: packagedSpawnSpec?.cwd ?? repoRoot,
      // Windows loses the pnpm child's marker pipes when launched as a detached
      // process group. A packaged executable also launches directly without a
      // shell, avoiding a redundant debug Rust build in the Windows installer
      // job. stopProcess uses taskkill there, so detachment is only needed for
      // Unix process-group cleanup.
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32' && !packagedSpawnSpec,
      env: smokeAppEnv({
        VIDEORC_USER_DATA_DIR: userDataDir,
        VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
        VIDEORC_SMOKE_STATE_DIR: outputDirectory,
        VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        ...(usePackagedWindowsScreen ? { VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW: '1' } : {}),
        ...(packagedSmokeCapability
          ? {
              VIDEORC_PACKAGED_SMOKE_TEST: '1',
              VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability
            }
          : {}),
        ...(exerciseProofFramePolling && !packagedSpawnSpec
          ? { VIDEORC_SMOKE_PREVIEW_FRAME_POLLING: '1' }
          : exerciseProofFramePolling
            ? {}
            : { VIDEORC_SMOKE_PREVIEW_MOTION: '1' }),
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const maybeResolve = () => {
      if (connections.backend && connections.smoke) {
        clearTimeout(timer)
        resolveConnections(connections)
      }
    }
    const handleOutput = (text) =>
      handleAppOutput(text, connections, maybeResolve, packagedSmokeCapability)

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
        new Error(
          `Native-preview recording app exited before smoke completed: code=${code} signal=${signal}`
        )
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

function handleAppOutput(text, connections, maybeResolve, packagedSmokeCapability = null) {
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
      if (packagedSmokeCapability) {
        connections.smoke.capability = packagedSmokeCapability
      }
      maybeResolve()
    }
  }
}

async function stopApp() {
  if (!appProcess?.pid || appProcess.killed) {
    stopping = false
    return
  }
  stopping = true
  await stopProcess(appProcess)
  appProcess = null
  stopping = false
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
