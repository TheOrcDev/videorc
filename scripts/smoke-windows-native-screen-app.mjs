import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { performanceAppSpawnSpec, launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { evaluateRecordingWallDuration } from './lib/recording-duration-gate.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  passingCheck,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import { collectWindowsProcessTreeTelemetry } from './lib/process-endurance.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  evaluateWindowsPerformanceBudget,
  loadWindowsPerformanceBudget
} from './lib/windows-performance-budget.mjs'
import {
  assertBmpHeaders,
  assertNonblankBmp,
  assertWindowsGraphicsCaptureTexture,
  evaluateWindowsNativeScreenD3d11Diagnostics,
  nativeWindowsCompositorUsesScreen,
  nativeWindowsD3d11MediaEncodingActive,
  nativeWindowsScreenCandidates,
  nativeWindowsScreenRecordingActive,
  parseWindowsNativeScreenArgs,
  requiredBmpPreviewAdvances,
  windowsNativeScreenPerformanceBudgetContext,
  SCENE_EDIT_SCREEN_TRANSFORM,
  sceneEditFrameRegions,
  windowsNativeScreenRecordingArtifactGates,
  windowsNativeScreenRequiresFinalDiagnostics
} from './lib/windows-native-screen-gates.mjs'
import {
  assertBundledBackgroundFrame,
  connectBackend,
  extractRgbFrame,
  meanRgbDifference,
  request,
  rgbRange,
  sampleGrid
} from './smoke-recording-session.mjs'

const options = parseWindowsNativeScreenArgs(process.argv.slice(2))

if (process.platform !== 'win32') {
  throw new Error('The native Windows screen smoke must run on Windows.')
}

const performanceModeValue = performanceMode()

const repoRoot = resolve(import.meta.dirname, '..')
const spawnSpec = performanceAppSpawnSpec()
if (!spawnSpec) {
  throw new Error('Set VIDEORC_PERF_APP_EXECUTABLE to the packaged Videorc.exe.')
}

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-windows-native-screen-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000)
const recordingMs = Number(process.env.VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS ?? 6_000)
const performanceWarmupMs = Number(process.env.VIDEORC_PERF_WARMUP_MS ?? 0)
const performanceMeasurementMs = Number(
  process.env.VIDEORC_PERF_MEASUREMENT_MS ?? Math.max(1, recordingMs - performanceWarmupMs)
)
const performanceIntervalMs = Number(process.env.VIDEORC_PERF_SAMPLE_INTERVAL_MS ?? 1_000)
const performanceReportRequested = Boolean(process.env.VIDEORC_PERF_REPORT_PATH)
const measureOccludedAuxWindows = process.env.VIDEORC_PERF_OCCLUDED_AUX_WINDOWS === '1'
const requireEncodedBridge =
  process.env.VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE === '1' || options.requireD3d11
const requireFinalDiagnostics = windowsNativeScreenRequiresFinalDiagnostics({
  requireEncodedBridge,
  d3d11: options.d3d11,
  expectFallback: options.expectFallback
})
const requireGraphicsCapture = process.env.VIDEORC_WINDOWS_REQUIRE_GRAPHICS_CAPTURE === '1'
const requireDirectD3D11Recording =
  process.env.VIDEORC_WINDOWS_REQUIRE_DIRECT_D3D11_RECORDING === '1'
const includeCamera = process.env.VIDEORC_WINDOWS_INCLUDE_CAMERA === '1'
const printAppOutput = process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1'
const performanceEvaluationRequested = performanceReportRequested || performanceModeValue === 'gate'
const video = {
  preset: 'custom',
  width: Number(process.env.VIDEORC_SMOKE_VIDEO_WIDTH ?? 1280),
  height: Number(process.env.VIDEORC_SMOKE_VIDEO_HEIGHT ?? 720),
  fps: Number(process.env.VIDEORC_SMOKE_VIDEO_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_SMOKE_VIDEO_BITRATE_KBPS ?? 4_000)
}

if ((options.background || options.sceneEdit) && includeCamera) {
  throw new Error(
    '--background and --scene-edit record a screen-only scene; unset VIDEORC_WINDOWS_INCLUDE_CAMERA.'
  )
}

mkdirSync(outputDirectory, { recursive: true })

// The bundled background is read through the packaged smoke command server.
const smokeCommandsRequested = measureOccludedAuxWindows || options.background
const packagedSmokeCommandCapability = smokeCommandsRequested
  ? randomBytes(32).toString('base64url')
  : undefined
const launched = await launchDevApp({
  spawnSpec,
  timeoutMs,
  ...(printAppOutput ? { onLine: (line) => console.log(`[app] ${line}`) } : {}),
  requiredMarkers: smokeCommandsRequested
    ? ['backend-ready', 'preview-motion-ready']
    : ['backend-ready'],
  packagedSmokeCommandCapability,
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    ...(requireGraphicsCapture ? { VIDEORC_WINDOWS_GRAPHICS_CAPTURE: '1' } : {}),
    ...(options.d3d11
      ? {
          VIDEORC_WINDOWS_D3D11_MEDIA: '1',
          VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts'
        }
      : {}),
    ...(options.requireD3d11
      ? {
          VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA: '1',
          VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE: '1'
        }
      : {}),
    ...(options.expectFallback === 'natural'
      ? { VIDEORC_WINDOWS_EXPECT_D3D11_FALLBACK: 'natural' }
      : {}),
    ...(smokeCommandsRequested
      ? {
          VIDEORC_SMOKE_COMMAND_SERVER: '1',
          VIDEORC_PACKAGED_SMOKE_TEST: '1',
          VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCommandCapability
        }
      : {})
  }
})

let ws
let performanceTelemetry = null
let bmpEvidence = null
let recordingEvidence = null
let selectedScreen = null
let selectedCamera = null
let bundledBackground = null
let backgroundEvidence = null
let sceneEditEvidence = null
let cameraEvidence = null
let cameraFramesAtRecordingStart = null
let teardownEvidence = null
let occludedAuxWindowsEvidence = null
let collectorFailure = null
let collectorFailed = false
const collectorHardFailures = []
try {
  const connection = launched.connections['backend-ready']
  ws = await connectBackend(connection, timeoutMs)
  const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'Bundled FFmpeg is unavailable.')
  }

  const deviceList = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const candidates = nativeWindowsScreenCandidates(deviceList?.devices ?? [])
  if (candidates.length === 0) {
    throw new Error(
      `No available Windows DXGI/gdigrab screen source. Devices: ${JSON.stringify(deviceList?.devices ?? [])}`
    )
  }
  const screen = await startAvailableWindowsScreenPreview(ws, candidates)
  selectedScreen = screen
  const minimumBmpPreviewAdvances = requiredBmpPreviewAdvances(screen)
  const camera = includeCamera
    ? (deviceList?.devices ?? []).find(
        (device) => device.kind === 'camera' && device.status === 'available'
      )
    : null
  if (includeCamera && !camera) {
    throw new Error(
      `Screen+camera smoke requested but no available camera was found: ${JSON.stringify(deviceList?.devices ?? [])}`
    )
  }
  selectedCamera = camera
  const sources = {
    screenId: screen.id,
    windowId: null,
    cameraId: camera?.id ?? null,
    microphoneId: null,
    testPattern: false
  }
  console.log(`Windows native screen smoke selected ${screen.id}: ${screen.detail ?? screen.name}`)
  let previewStatus = await waitForNativeScreenFrame(ws, screen.id)
  if (requireGraphicsCapture) {
    assertWindowsGraphicsCaptureTexture(previewStatus)
  }
  if (camera) {
    await request(ws, timeoutMs, 'preview.camera.start', {
      sources,
      layout: sessionLayout(),
      video,
      ffmpegPath
    })
    cameraEvidence = await waitForNativeCameraFrame(ws, camera.id)
    cameraFramesAtRecordingStart = cameraEvidence.framesCaptured ?? 0
    console.log(
      `Windows screen+camera smoke selected ${camera.id}: ${camera.name}; ` +
        `sourceFps=${cameraEvidence.sourceFps ?? 'pending'}`
    )
  }

  const firstBmp = options.d3d11 ? null : await waitForNonblankBmpFrame(connection)

  if (options.background) {
    bundledBackground = await requestSmokeCommand(
      launched.connections['preview-motion-ready'],
      'inspect-packaged-bundled-background',
      {},
      { timeoutMs }
    )
    if (
      typeof bundledBackground?.id !== 'string' ||
      typeof bundledBackground?.fileName !== 'string' ||
      typeof bundledBackground?.managedAssetPath !== 'string'
    ) {
      throw new Error('Packaged app did not expose a registered bundled background asset.')
    }
    console.log(
      `Windows native screen smoke records over bundled background ${bundledBackground.id}`
    )
  }

  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams(sources, bundledBackground)
  )
  if (started?.state !== 'recording') {
    throw new Error(
      `Expected ${includeCamera ? 'ScreenCamera' : 'ScreenOnly'} recording, got ${started?.state ?? 'no state'}.`
    )
  }
  const recordingStartedAt = Date.now()
  const activeRecording = await waitForActiveNativeScreenRecording(ws, screen.id)
  if (requireEncodedBridge) {
    assertEncodedBridgeDiagnostics(activeRecording.diagnostics, {
      requireOutput: false,
      requireDirectD3D11Recording,
      requireNoCpuCompositor: includeCamera
    })
  }
  if (options.d3d11 || options.expectFallback) {
    assertD3d11Diagnostics(activeRecording.diagnostics, { requireOutput: false })
  }
  if (
    !requireDirectD3D11Recording &&
    !options.d3d11 &&
    !nativeWindowsCompositorUsesScreen(activeRecording.compositor, screen.id)
  ) {
    throw new Error(
      `Recording compositor did not retain selected native screen ${screen.id}: ${JSON.stringify(activeRecording)}`
    )
  }
  if (measureOccludedAuxWindows) {
    occludedAuxWindowsEvidence = await prepareOccludedAuxWindows(
      launched.connections['preview-motion-ready']
    )
  }

  const telemetryPromise = performanceEvaluationRequested
    ? collectWindowsProcessTreeTelemetry({
        rootPid: launched.process.pid,
        warmupMs: performanceWarmupMs,
        measurementMs: performanceMeasurementMs,
        intervalMs: performanceIntervalMs
      })
    : Promise.resolve(null)
  const [telemetryResult, bmpResult] = await Promise.allSettled([
    telemetryPromise,
    options.d3d11
      ? monitorD3d11DuringRecording(ws, recordingMs)
      : pollBmpDuringRecording(connection, firstBmp.cursor, recordingMs, minimumBmpPreviewAdvances)
  ])
  if (telemetryResult.status === 'fulfilled') {
    performanceTelemetry = telemetryResult.value
  } else {
    if (!collectorFailed) collectorFailure = telemetryResult.reason
    collectorFailed = true
    collectorHardFailures.push(
      `Windows process telemetry collection failed: ${failureMessage(telemetryResult.reason)}`
    )
  }
  if (bmpResult.status === 'fulfilled') {
    bmpEvidence = bmpResult.value
  } else {
    if (!collectorFailed) collectorFailure = bmpResult.reason
    collectorFailed = true
    collectorHardFailures.push(
      `${options.d3d11 ? 'D3D11 diagnostics monitoring' : 'BMP proof polling'} failed: ${failureMessage(bmpResult.reason)}`
    )
  }
  if (collectorFailed && !performanceEvaluationRequested) throw collectorFailure
  let finalDiagnostics = null
  if (requireFinalDiagnostics) {
    finalDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    if (requireEncodedBridge) {
      assertEncodedBridgeDiagnostics(finalDiagnostics, {
        requireOutput: true,
        requireDirectD3D11Recording,
        requireNoCpuCompositor: includeCamera
      })
    }
  }
  if (camera) {
    cameraEvidence = await waitForNativeCameraFrame(ws, camera.id)
    const cameraFramesDuringRecording =
      (cameraEvidence?.framesCaptured ?? 0) - (cameraFramesAtRecordingStart ?? 0)
    const minimumCameraFrames = Math.max(1, Math.floor((recordingMs / 1000) * 5))
    if (
      cameraFramesDuringRecording < minimumCameraFrames ||
      !(cameraEvidence?.sourceFps > 0) ||
      !(cameraEvidence?.frameAgeMs < 1_000)
    ) {
      throw new Error(
        `Windows camera stopped advancing during recording: frames=${cameraFramesDuringRecording}, minimum=${minimumCameraFrames}, sourceFps=${cameraEvidence?.sourceFps ?? 'missing'}, frameAgeMs=${cameraEvidence?.frameAgeMs ?? 'missing'}, status=${JSON.stringify(cameraEvidence)}`
      )
    }
  }
  if (requireGraphicsCapture) {
    previewStatus = await request(ws, timeoutMs, 'preview.screen.status')
    assertWindowsGraphicsCaptureTexture(previewStatus)
  }
  if (options.d3d11 || options.expectFallback) {
    assertD3d11Diagnostics(finalDiagnostics, { requireOutput: options.d3d11 })
  }
  const stopRequestedAt = Date.now()
  const stopped = await request(ws, timeoutMs, 'session.stop')
  // Analyze the published MP4, never the MKV Stop returns: the backend
  // quarantines that MKV once the export lands, and an ffprobe holding it on
  // Windows fails the rename with os error 32 (#1081).
  const outputPath = await resolveFinalRecordingPath({
    started,
    stopped,
    stopRequestedAt,
    timeoutMs
  })
  if (!outputPath || !existsSync(outputPath) || statSync(outputPath).size <= 0) {
    throw new Error(
      `Native ScreenOnly recording MP4 is missing or empty: ${outputPath ?? stopped?.outputPath ?? started?.outputPath ?? 'none'}`
    )
  }

  const report = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    expectAudio: false,
    gates: windowsNativeScreenRecordingArtifactGates(screen)
  })
  if (options.sceneEdit) {
    // #1175: the moved screen is where the scene put it from the first frame,
    // and the half it left shows the canvas fill (the background, or black).
    const backgroundSourcePath = bundledBackground
      ? join(
          repoRoot,
          'apps/desktop/src/renderer/src/assets/backgrounds',
          bundledBackground.fileName
        )
      : null
    sceneEditEvidence = [0, Math.max(0.5, recordingMs / 2000)].map((seekSeconds) =>
      assertSceneEditPlacementFrame({ outputPath, backgroundSourcePath, seekSeconds })
    )
    console.log(
      `Windows native screen scene-edit PASS: the screen stays in its moved box over ${bundledBackground ? bundledBackground.id : 'black'} at ${sceneEditEvidence
        .map(
          ({ seekSeconds, uncoveredScore, coveredScore }) =>
            `${seekSeconds}s (outside ${uncoveredScore.toFixed(1)}, inside ${coveredScore.toFixed(1)})`
        )
        .join(', ')}`
    )
  } else if (bundledBackground) {
    // The first frame is the startup case (#1067): the session draws its own
    // committed scene before its sources are confirmed, never the bare
    // full-canvas screen.
    const sourcePath = join(
      repoRoot,
      'apps/desktop/src/renderer/src/assets/backgrounds',
      bundledBackground.fileName
    )
    backgroundEvidence = [0, Math.max(0.5, recordingMs / 2000)].map((seekSeconds) =>
      assertBundledBackgroundFrame({
        outputPath,
        outputDirectory,
        ffmpegPath,
        sourcePath,
        seekSeconds
      })
    )
    console.log(
      `Windows native screen background PASS: border matches ${bundledBackground.id} at ${backgroundEvidence
        .map(({ seekSeconds, meanDifference }) => `${seekSeconds}s (${meanDifference.toFixed(1)})`)
        .join(', ')}`
    )
  }
  recordingEvidence = {
    outputPath,
    sizeBytes: statSync(outputPath).size,
    metrics: report.metrics,
    verdict: report.verdict
  }
  const reportPaths = writeReports(report)
  if (!report.verdict.pass) {
    throw new Error(
      `Native ScreenOnly recording quality failed: ${report.verdict.failures.join('; ')} (report: ${reportPaths.mdPath})`
    )
  }
  const durationFailures = evaluateRecordingWallDuration({
    expectedDurationMs: stopRequestedAt - recordingStartedAt,
    actualDurationSeconds: report.metrics.durationSeconds
  })
  if (durationFailures.length > 0) {
    throw new Error(`Native ScreenOnly duration failed: ${durationFailures.join('; ')}`)
  }
  assertNonblankRecordingFrame(outputPath)

  if (!collectorFailed) {
    console.log(
      `Windows native screen ${options.d3d11 ? 'D3D11' : 'BMP'} PASS: ${screen.id}, ${bmpEvidence.advancedFrames} ${options.d3d11 ? 'GPU sample' : 'BMP frame'} advances, ` +
        `${report.metrics.observedFrames ?? 'n/a'} recorded frames, ${report.metrics.durationSeconds.toFixed(2)}s, ` +
        `${camera ? `camera source ${cameraEvidence?.sourceFps?.toFixed?.(2) ?? 'n/a'} fps, ` : ''}` +
        `${previewStatus?.d3d11TextureAvailable === true ? 'retained D3D11 texture, ' : ''}` +
        `${outputPath} (report: ${reportPaths.mdPath})`
    )
  }
} finally {
  let evidenceDiagnostics = null
  try {
    if (ws) {
      evidenceDiagnostics = await request(ws, 10_000, 'diagnostics.stats')
    }
  } catch {
    // Best effort only; the original failure must keep propagating.
  }
  try {
    writeFileSync(
      join(outputDirectory, 'native-screen-diagnostics-evidence.json'),
      JSON.stringify(
        {
          includeCamera,
          video,
          requireDirectD3D11Recording,
          d3d11Monitor: bmpEvidence,
          finalDiagnostics: evidenceDiagnostics,
          cameraEvidence,
          recordingEvidence,
          collectorHardFailures
        },
        null,
        2
      )
    )
  } catch (error) {
    console.log(`Windows native screen smoke could not retain diagnostics evidence: ${error}`)
  }
  if (ws) {
    if (includeCamera) {
      try {
        await request(ws, 10_000, 'preview.camera.stop')
      } catch {
        // Process teardown below is authoritative.
      }
    }
    try {
      await request(ws, 10_000, 'preview.screen.stop')
    } catch {
      // Process teardown below is authoritative.
    }
    ws.close()
  }
  teardownEvidence = await launched.stop()
}

if (performanceEvaluationRequested) {
  const requiredRoles = [
    'backend',
    'electron-main',
    'electron-renderer',
    'electron-gpu',
    'ffmpeg',
    ...(measureOccludedAuxWindows
      ? ['electron-renderer-notes', 'electron-renderer-comments', 'electron-renderer-captions']
      : [])
  ]
  const telemetryFailures = requiredRoles.filter(
    (role) =>
      (performanceTelemetry?.memory?.summary?.roles?.[role]?.minMeasuredCount ?? 0) < 1 ||
      (performanceTelemetry?.cpu?.summary?.byRole?.[role]?.samples ?? 0) < 1
  )
  const hardFailures = [
    ...collectorHardFailures,
    ...(telemetryFailures.length > 0
      ? [`Windows process telemetry did not continuously identify: ${telemetryFailures.join(', ')}`]
      : []),
    ...(bmpEvidence?.advancedFrames > 0 || options.expectFallback === 'natural'
      ? []
      : [
          `${options.d3d11 ? 'D3D11 GPU diagnostics' : 'BMP proof polling'} did not observe frame progress`
        ]),
    ...(recordingEvidence?.verdict?.pass === true
      ? []
      : ['final recording media validity was missing'])
  ]
  const metadata = await collectPerformanceMetadata({ cwd: repoRoot })
  let activeBudget = null
  let budgetFailures = []
  if (performanceModeValue === 'gate') {
    try {
      activeBudget = await loadWindowsPerformanceBudget({
        path: process.env.VIDEORC_WINDOWS_PERF_BUDGET_PATH,
        profileId: process.env.VIDEORC_WINDOWS_PERF_BUDGET_PROFILE,
        context: windowsNativeScreenPerformanceBudgetContext({
          metadata,
          scenario: process.env.VIDEORC_PERF_SCENARIO ?? 'windows-proof-recording',
          timing: {
            warmupMs: performanceWarmupMs,
            measurementMs: performanceMeasurementMs,
            intervalMs: performanceIntervalMs
          }
        })
      })
      budgetFailures = evaluateWindowsPerformanceBudget(activeBudget.profile, {
        processTree: performanceTelemetry,
        bmp: bmpEvidence,
        recording: recordingEvidence,
        teardownClean: teardownEvidence?.state === 'terminated'
      })
    } catch (error) {
      budgetFailures = [error?.message ?? String(error)]
    }
  }
  const report = createPerformanceReport({
    scenario: process.env.VIDEORC_PERF_SCENARIO ?? 'windows-proof-recording',
    mode: performanceModeValue,
    metadata,
    timing: {
      warmupMs: performanceWarmupMs,
      measurementMs: performanceMeasurementMs,
      intervalMs: performanceIntervalMs
    },
    metrics: {
      screen: selectedScreen,
      camera: selectedCamera ? { ...selectedCamera, evidence: cameraEvidence } : null,
      processTree: performanceTelemetry,
      bmp: bmpEvidence,
      recording: recordingEvidence,
      occludedAuxWindows: occludedAuxWindowsEvidence,
      teardown: teardownEvidence,
      activeBudget: activeBudget
        ? { path: activeBudget.path, profileId: activeBudget.profile.id }
        : null,
      budgetFailures
    },
    checks: [
      ...(hardFailures.length === 0
        ? [
            passingCheck(
              `packaged Windows source, media, ${options.d3d11 ? 'D3D11 zero-copy' : 'BMP'}, and per-role process evidence passed`
            )
          ]
        : []),
      ...failingChecks(hardFailures),
      ...failingChecks(budgetFailures)
    ]
  })
  if (performanceReportRequested) {
    const reportPath = await writePerformanceReport(report)
    console.log(`Windows packaged performance report: ${reportPath}`)
  }
  if (collectorFailed) throw collectorFailure
  if (hardFailures.length > 0 || budgetFailures.length > 0) {
    throw new Error([...hardFailures, ...budgetFailures].join('\n'))
  }
}

async function prepareOccludedAuxWindows(smoke) {
  const placements = [
    ['notes-window-open', 'notes-window-set-bounds', { x: 140, y: 140, width: 640, height: 420 }],
    [
      'comments-window-open',
      'comments-window-set-bounds',
      { x: 180, y: 120, width: 420, height: 640 }
    ],
    [
      'captions-window-open',
      'captions-window-set-bounds',
      { x: 120, y: 360, width: 640, height: 320 }
    ]
  ]
  const windows = {}
  for (const [openCommand, boundsCommand, bounds] of placements) {
    await requestSmokeCommand(smoke, openCommand, {}, { timeoutMs })
    windows[openCommand.replace('-open', '')] = await requestSmokeCommand(
      smoke,
      boundsCommand,
      bounds,
      { timeoutMs }
    )
  }
  const main = await requestSmokeCommand(
    smoke,
    'main-window-set-bounds',
    { x: 80, y: 80, width: 1180, height: 780 },
    { timeoutMs }
  )
  const focus = await requestSmokeCommand(smoke, 'main-window-focus', {}, { timeoutMs })
  if (focus?.focused !== true) {
    throw new Error('Main window did not occlude the auxiliary performance surfaces.')
  }
  return { windows, main, mainFocused: true }
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function startAvailableWindowsScreenPreview(ws, candidates) {
  const failures = []
  for (const candidate of candidates) {
    const preview = await request(ws, timeoutMs, 'preview.screen.start', {
      sources: { screenId: candidate.id, testPattern: false },
      video,
      protectedOverlayWindowIds: [],
      ffmpegPath
    })
    if (preview?.state === 'live') {
      return candidate
    }
    failures.push(`${candidate.id}: ${preview?.state} ${preview?.message ?? ''}`)
    await request(ws, timeoutMs, 'preview.screen.stop')
  }
  throw new Error(`No Windows native screen backend could start: ${failures.join('; ')}`)
}

async function waitForNativeScreenFrame(ws, sourceId) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.screen.status')
    if (
      last?.state === 'live' &&
      last?.sourceId === sourceId &&
      ((last.framesCaptured ?? 0) > 0 || last.sequence != null)
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${sourceId} frame: ${JSON.stringify(last)}`)
}

async function waitForNativeCameraFrame(ws, cameraId) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.camera.status')
    if (
      last?.state === 'live' &&
      last?.cameraId === cameraId &&
      ((last.framesCaptured ?? 0) > 0 || last.sequence != null)
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${cameraId} frame: ${JSON.stringify(last)}`)
}

async function waitForNonblankBmpFrame(connection) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const frame = await fetchBmpFrame(connection, null)
      if (frame.status === 200) {
        assertNonblankBmp(frame.bytes, frame.headers)
        return frame
      }
    } catch (error) {
      lastError = error
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for the first nonblank native BMP preview frame.', {
    cause: lastError
  })
}

async function waitForActiveNativeScreenRecording(ws, sourceId) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const [diagnostics, compositor, recording] = await Promise.all([
      request(ws, timeoutMs, 'diagnostics.stats'),
      request(ws, timeoutMs, 'compositor.status'),
      request(ws, timeoutMs, 'recording.status')
    ])
    last = { diagnostics, compositor, recording }
    if (nativeWindowsScreenRecordingActive(last, sourceId)) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for ScreenOnly recording/source authority for ${sourceId}: ${JSON.stringify(last)}`
  )
}

async function pollBmpDuringRecording(connection, initialCursor, durationMs, minimumAdvances) {
  const deadline = Date.now() + durationMs
  let cursor = initialCursor
  let advancedFrames = 0
  let nonblankFrames = 0
  const observations = []
  while (Date.now() < deadline) {
    const frame = await fetchBmpFrame(connection, cursor)
    if (frame.status === 200) {
      assertNonblankBmp(frame.bytes, frame.headers)
      cursor = frame.cursor
      advancedFrames += 1
      nonblankFrames += 1
      observations.push({
        atMs: Date.now(),
        bytes: frame.bytes.length,
        sequence: frame.cursor.sequence
      })
    }
    await sleep(100)
  }
  if (advancedFrames < minimumAdvances || nonblankFrames !== advancedFrames) {
    throw new Error(
      `Native BMP preview did not stay live during recording: advanced=${advancedFrames}, ` +
        `required=${minimumAdvances}, nonblank=${nonblankFrames}.`
    )
  }
  const intervalsMs = observations
    .slice(1)
    .map((sample, index) => sample.atMs - observations[index].atMs)
    .filter((intervalMs) => Number.isFinite(intervalMs) && intervalMs >= 0)
  const bytes = observations.map((sample) => sample.bytes)
  return {
    advancedFrames,
    cursor,
    observations,
    totalBytes: bytes.reduce((total, value) => total + value, 0),
    maxBytes: bytes.length > 0 ? Math.max(...bytes) : 0,
    intervalP95Ms: percentileNearestRank(intervalsMs, 0.95)
  }
}

async function fetchBmpFrame(connection, cursor) {
  const url = new URL(`http://${connection.host}:${connection.port}/preview/screen/latest.bmp`)
  url.searchParams.set('token', connection.token)
  url.searchParams.set('maxWidth', '640')
  if (cursor) {
    url.searchParams.set('afterGeneration', cursor.generation)
    url.searchParams.set('afterSequence', String(cursor.sequence))
  }
  const response = await fetch(url, { cache: 'no-store' })
  if (![200, 204].includes(response.status)) {
    throw new Error(`BMP preview request failed with HTTP ${response.status}.`)
  }
  const headers = Object.fromEntries(response.headers.entries())
  assertBmpHeaders(headers, response.status)
  const generation = headers['x-videorc-frame-generation']
  const sequence = Number(headers['x-videorc-frame-sequence'])
  const nextCursor = { generation, sequence }
  if (response.status === 204) {
    return { status: 204, bytes: Buffer.alloc(0), headers, cursor: nextCursor }
  }
  return {
    status: 200,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers,
    cursor: nextCursor
  }
}

function sessionLayout() {
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
  if (includeCamera) layout.layoutPreset = 'screen-camera'
  return layout
}

function sessionParams(sources, background = null) {
  return {
    sources,
    layout: sessionLayout(),
    ...(background || options.sceneEdit
      ? { scene: explicitScene(sources.screenId, background, options.sceneEdit) }
      : {}),
    output: {
      recordEnabled: true,
      streamEnabled: false,
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: true,
      microphoneSyncOffsetMs: 0
    }
  }
}

// The scene the renderer sends for a background (#1067) or in scene edit mode
// (#1175): one screen source, moved into the right half for --scene-edit.
function explicitScene(screenId, background, sceneEdit) {
  const presetTransform = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
  return {
    id: sceneEdit ? 'scene:windows-native-screen-edit' : 'scene:windows-native-screen-background',
    name: sceneEdit
      ? 'Windows native screen moved in scene edit mode'
      : 'Windows native screen over a background',
    sources: [
      {
        id: 'source:screen',
        name: 'Screen',
        kind: 'screen',
        deviceId: screenId,
        transform: sceneEdit ? { ...SCENE_EDIT_SCREEN_TRANSFORM } : presetTransform,
        defaultTransform: presetTransform,
        visible: true,
        locked: false
      }
    ],
    outputs: [],
    ...(background
      ? {
          background: {
            assetId: background.id,
            managedAssetPath: background.managedAssetPath,
            fit: 'stretch',
            scale: 100,
            offsetX: 0,
            offsetY: 0,
            blurPx: 0,
            dimPercent: 0,
            saturationPercent: 100,
            vignettePercent: 0
          }
        }
      : {})
  }
}

// #1175: one frame of a --scene-edit recording. Outside the moved screen's box
// the frame shows the canvas fill: the decoded background, or the D3D11
// compositor's black clear. Inside it, something that is not the fill.
function assertSceneEditPlacementFrame({ outputPath, backgroundSourcePath, seekSeconds }) {
  const width = 640
  const height = 360
  const stamp = `${Date.now()}-${Math.round(seekSeconds * 1000)}`
  const recordedRawPath = join(outputDirectory, `scene-edit-recording-${stamp}.rgb`)
  extractRgbFrame({
    inputPath: outputPath,
    outputPath: recordedRawPath,
    ffmpegPath,
    width,
    height,
    seekSeconds,
    label: 'extract scene-edit recording frame'
  })
  const recorded = readFileSync(recordedRawPath)
  let reference = Buffer.alloc(width * height * 3)
  if (backgroundSourcePath) {
    const referenceRawPath = join(outputDirectory, `scene-edit-reference-${stamp}.rgb`)
    extractRgbFrame({
      inputPath: backgroundSourcePath,
      outputPath: referenceRawPath,
      ffmpegPath,
      width,
      height,
      label: 'decode scene-edit background reference asset'
    })
    reference = readFileSync(referenceRawPath)
  }
  const expectedBytes = width * height * 3
  if (recorded.length < expectedBytes || reference.length < expectedBytes) {
    throw new Error(
      `Scene-edit frame at ${seekSeconds}s is truncated: recording=${recorded.length}, reference=${reference.length}, expected=${expectedBytes}.`
    )
  }
  const regions = sceneEditFrameRegions(width, height)
  const uncoveredPoints = sampleGrid({ ...regions.uncovered, columns: 12, rows: 12 })
  const coveredPoints = sampleGrid({ ...regions.covered, columns: 8, rows: 6 })
  const fill = backgroundSourcePath ? 'the background' : 'black'
  // Outside: the fill. A background gets the border gate's tolerance (a
  // scaled, encoded image); black gets a tight one, so a dark desktop drawn
  // at its preset place still fails.
  const uncoveredLimit = backgroundSourcePath ? 48 : 16
  const uncoveredScore = meanRgbDifference(recorded, reference, width, uncoveredPoints)
  if (uncoveredScore > uncoveredLimit) {
    throw new Error(
      `Scene-edit recording at ${seekSeconds}s does not show ${fill} where the moved screen used to be: mean RGB difference ${uncoveredScore.toFixed(1)} exceeded ${uncoveredLimit}. The session drew the screen at its preset place, not where the scene moved it.`
    )
  }
  // Inside: the screen, so not the fill. Against a background only the
  // difference counts (the background has its own range); against black, a
  // dark desktop still has a range of pixel values.
  const coveredDifference = meanRgbDifference(recorded, reference, width, coveredPoints)
  const coveredScore = backgroundSourcePath
    ? coveredDifference
    : Math.max(coveredDifference, rgbRange(recorded, width, coveredPoints))
  if (coveredScore < 24) {
    throw new Error(
      `Scene-edit recording at ${seekSeconds}s shows only ${fill} inside the moved screen's box (score ${coveredScore.toFixed(1)}, need 24): the screen was not drawn where the scene put it.`
    )
  }
  return { seekSeconds, uncoveredScore, coveredScore }
}

async function monitorD3d11DuringRecording(ws, durationMs) {
  const samples = []
  const startedAt = Date.now()
  while (Date.now() - startedAt < durationMs) {
    const diagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    assertD3d11Diagnostics(diagnostics, { requireOutput: false })
    samples.push({
      elapsedMs: Date.now() - startedAt,
      media: diagnostics.windowsD3d11Media
    })
    await sleep(Math.min(250, Math.max(1, durationMs - (Date.now() - startedAt))))
  }
  const first = samples[0] ?? {}
  const last = samples.at(-1) ?? {}
  const mediaAt = (sample) => sample?.media ?? {}
  const counterDelta = (name) =>
    Math.max(0, Number(mediaAt(last)[name] ?? 0) - Number(mediaAt(first)[name] ?? 0))
  const textureAdvances = counterDelta('textureImportFrames')
  const encoderAdvances = counterDelta('encoderGpuSamples')
  return {
    mode: 'disabled-d3d11',
    requests: 0,
    bytes: 0,
    advancedFrames: Math.max(textureAdvances, encoderAdvances),
    nonblankFrames: 0,
    sampleCount: samples.length,
    textureAdvances,
    encoderAdvances,
    texturePoolPressureEvents: counterDelta('texturePoolPressureEvents'),
    previewPresents: counterDelta('previewPresents'),
    synchronizationTimeouts: counterDelta('synchronizationTimeouts'),
    samples
  }
}

function assertD3d11Diagnostics(diagnostics, { requireOutput }) {
  const failures = evaluateWindowsNativeScreenD3d11Diagnostics(diagnostics, {
    requireOutput,
    expectFallback: options.expectFallback,
    requireZeroPoolPressure: options.requireD3d11
  })
  if (failures.length > 0) {
    throw new Error(`Windows D3D11 media diagnostics failed: ${failures.join('; ')}`)
  }
}

function assertEncodedBridgeDiagnostics(
  diagnostics,
  { requireOutput, requireDirectD3D11Recording, requireNoCpuCompositor = false }
) {
  const failures = []
  if (diagnostics?.encodeBackend !== 'hardware-media-foundation') {
    failures.push(`encodeBackend=${diagnostics?.encodeBackend ?? 'missing'}`)
  }
  if (diagnostics?.encoderBridgeEncodedOutputBackend !== 'media-foundation') {
    failures.push(
      `encodedOutputBackend=${diagnostics?.encoderBridgeEncodedOutputBackend ?? 'missing'}`
    )
  }
  if (diagnostics?.encoderBridgeEffectiveVideoOutput !== 'windows-media-foundation-h264-mpegts') {
    failures.push(`effectiveOutput=${diagnostics?.encoderBridgeEffectiveVideoOutput ?? 'missing'}`)
  }
  if ((diagnostics?.encoderBridgeRawVideoCopiedFrames ?? 0) !== 0) {
    failures.push(`rawFifoCopiedFrames=${diagnostics.encoderBridgeRawVideoCopiedFrames}`)
  }
  if ((diagnostics?.encoderBridgeEncodedOutputErrors ?? 0) !== 0) {
    failures.push(`encodedOutputErrors=${diagnostics.encoderBridgeEncodedOutputErrors}`)
  }
  if (requireDirectD3D11Recording && !nativeWindowsD3d11MediaEncodingActive(diagnostics)) {
    failures.push(
      `directD3D11Media=${diagnostics?.encoderBridgeEncodedOutputInputSubtype ?? 'missing'}`
    )
  }
  if (requireOutput && !(diagnostics?.encoderBridgeEncodedOutputFrames > 0)) {
    failures.push(`encodedOutputFrames=${diagnostics?.encoderBridgeEncodedOutputFrames ?? 0}`)
  }
  if (requireOutput && !(diagnostics?.encoderBridgeEncodedOutputBytes > 0)) {
    failures.push(`encodedOutputBytes=${diagnostics?.encoderBridgeEncodedOutputBytes ?? 0}`)
  }
  // Windows counts its expected CPU compositor frames under compositorCpuFrames (not a
  // fault); the direct-D3D11 path must render NO CPU frames of either kind.
  if (requireNoCpuCompositor && (diagnostics?.compositorCpuFallbackFrames ?? 0) !== 0) {
    failures.push(`compositorCpuFallbackFrames=${diagnostics.compositorCpuFallbackFrames}`)
  }
  if (requireNoCpuCompositor && (diagnostics?.compositorCpuFrames ?? 0) !== 0) {
    failures.push(`compositorCpuFrames=${diagnostics.compositorCpuFrames}`)
  }
  if (failures.length > 0) {
    const terminalError = diagnostics?.encoderBridgeError
      ? `; encoderBridgeError=${diagnostics.encoderBridgeError}`
      : ''
    throw new Error(
      `Windows encoded bridge diagnostics failed: ${failures.join('; ')}${terminalError}`
    )
  }
}

function assertNonblankRecordingFrame(outputPath) {
  const rawPath = join(outputDirectory, `native-screen-recording-${Date.now()}.rgb`)
  const result = spawnSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-y',
      '-ss',
      '0.5',
      '-i',
      outputPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=320:180',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      rawPath
    ],
    { encoding: 'utf8', cwd: repoRoot }
  )
  if (result.status !== 0) {
    throw new Error(`Could not decode native ScreenOnly frame: ${result.stderr || result.stdout}`)
  }
  const bytes = readFileSync(rawPath)
  let minimum = 255
  let maximum = 0
  for (let offset = 0; offset < bytes.length; offset += 97) {
    minimum = Math.min(minimum, bytes[offset])
    maximum = Math.max(maximum, bytes[offset])
  }
  if (bytes.length < 320 * 180 * 3 || maximum - minimum < 8 || maximum < 16) {
    throw new Error(
      `Native ScreenOnly recording decoded as blank/constant: bytes=${bytes.length}, range=${maximum - minimum}, max=${maximum}.`
    )
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function percentileNearestRank(values, percentile) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]
}
