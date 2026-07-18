// Native idle-pipeline performance and memory sentinel.
//
// Gate mode enforces frame progress, native CAMetalLayer authority, cadence,
// bounded status polling, configured RSS ceilings/slopes, and exact teardown.
// Report-only mode records budget misses without weakening truth checks such as
// zero frames or unexpected JPEG fallback.

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import {
  activePerformanceBudgetRequest,
  evaluateActivePerformanceBudget,
  preflightActivePerformanceBudget,
  readActivePerformanceBudget,
  selectActivePerformanceBudget
} from './lib/performance-budget.mjs'
import {
  createDetachedPreviewCalibrationEvidence,
  detachedPreviewCalibrationProvenance,
  DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
  DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE,
  DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE,
  inspectDetachedPreviewCalibrationSample
} from './lib/detached-preview-calibration.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  currentMacosCaffeinatePowerAssertionVerified,
  evaluateScenarioTruth,
  failingChecks,
  observationCheck,
  passingCheck,
  performanceMetadataWithObservedDisplayScale,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import {
  classifyProcess,
  collectProcessCensus,
  collectProcessResourceDetails,
  collectStableProcessResourceCheckpoint,
  compareProcessResourceCheckpoints,
  ownedProcessLedgerPaths,
  pruneDeadOwnedProcessRecords,
  waitForCleanProcessState,
  waitForNoLiveProcessState
} from './lib/process-census.mjs'
import { evaluateOwnedTeardown } from './lib/process-endurance.mjs'
import {
  evaluateProcessMemoryGate,
  formatProcessMemorySummary,
  summarizeProcessMemory
} from './lib/process-memory-gate.mjs'
import {
  collectPerformanceSamplesOnSchedule,
  performanceSamplingEvidenceFailures,
  performanceSamplingInvariants
} from './lib/performance-sampling-schedule.mjs'

const execFileAsync = promisify(execFile)
const mode = performanceMode()
const timeoutMs = numberFromEnv('VIDEORC_PROBE_TIMEOUT_MS', 180000)
const warmupSeconds = numberFromEnv('VIDEORC_PERF_WARMUP_SECONDS', 8)
const sampleSeconds = numberFromEnv('VIDEORC_PERF_SAMPLE_SECONDS', 30)
const sampleIntervalMs = numberFromEnv('VIDEORC_PERF_SAMPLE_INTERVAL_MS', 1000)
const requireStudioMicVisuals = process.env.VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS === '1'
const measurementMs = sampleSeconds * 1000
const samplingInvariants = performanceSamplingInvariants(measurementMs, sampleIntervalMs)
const previewMode = process.env.VIDEORC_PERF_PREVIEW_MODE ?? 'detached'
const expectedTransport = process.env.VIDEORC_PERF_EXPECT_TRANSPORT ?? 'native-surface'
const expectedBacking = process.env.VIDEORC_PERF_EXPECT_BACKING ?? 'cametal-layer'
let minPresentFps = numberFromEnv('VIDEORC_PERF_MIN_PRESENT_FPS', 30)
let maxIntervalP95Ms = numberFromEnv('VIDEORC_PERF_MAX_INTERVAL_P95_MS', 120)
let maxStatusFetchesPerSecond = numberFromEnv('VIDEORC_PERF_MAX_STATUS_FETCHES_SEC', 5)
// The compact frame-ready lane plus 4 Hz bounded diagnostics measures about
// 61-68 KiB/s unfiltered on Mac16,1, down from the 124-126 KiB/s baseline.
// Keep a binding regression ceiling without pretending the full diagnostics
// stream is a frame-ready-only socket.
let maxWireKibPerSecond = numberFromEnv('VIDEORC_PERF_MAX_WS_KIB_SEC', 80)
let maxOpenFileGrowth = numberFromEnv('VIDEORC_PERF_MAX_OPEN_FILE_GROWTH', 32)
let maxFootprintGrowthMb = optionalNumber('VIDEORC_PERF_MAX_FOOTPRINT_GROWTH_MB')
const packagedExecutable = process.env.VIDEORC_PERF_APP_EXECUTABLE
  ? resolve(process.env.VIDEORC_PERF_APP_EXECUTABLE)
  : null

if (!['detached', 'docked'].includes(previewMode)) {
  throw new Error(`VIDEORC_PERF_PREVIEW_MODE must be detached or docked, got ${previewMode}.`)
}
if (packagedExecutable && !existsSync(packagedExecutable)) {
  throw new Error(`Packaged app executable not found: ${packagedExecutable}`)
}

const invariantMemoryThresholds = {
  minSamples: samplingInvariants.minSamples,
  minDurationMs: samplingInvariants.minDurationMs,
  minRoleCount: {
    backend: 1,
    'electron-main': 1,
    'electron-renderer': 1
  },
  maxRoleCount: {
    backend: 1,
    'electron-main': 1,
    'electron-renderer': 3,
    'native-preview-helper': 1
  }
}
const thresholds = {
  ...invariantMemoryThresholds,
  maxTotalRssMb: numberFromEnv('VIDEORC_PERF_MAX_TOTAL_RSS_MB', 4096),
  maxOwnedRssMb: numberFromEnv('VIDEORC_PERF_MAX_OWNED_RSS_MB', 2048),
  maxOwnedSlopeMbPerMinute: optionalNumber('VIDEORC_PERF_MAX_OWNED_SLOPE_MB_MIN'),
  maxOwnedSecondHalfSlopeMbPerMinute: optionalNumber(
    'VIDEORC_PERF_MAX_OWNED_SECOND_HALF_SLOPE_MB_MIN'
  ),
  maxOwnedPlateauGrowthMb: optionalNumber('VIDEORC_PERF_MAX_OWNED_PLATEAU_GROWTH_MB'),
  maxRoleRssMb: {
    backend: numberFromEnv('VIDEORC_PERF_MAX_BACKEND_RSS_MB', 512),
    'electron-main': numberFromEnv('VIDEORC_PERF_MAX_MAIN_RSS_MB', 768),
    'electron-renderer': numberFromEnv('VIDEORC_PERF_MAX_RENDERER_RSS_MB', 1024),
    'electron-gpu': numberFromEnv('VIDEORC_PERF_MAX_GPU_RSS_MB', 512),
    'native-preview-helper': numberFromEnv('VIDEORC_PERF_MAX_HELPER_RSS_MB', 512)
  },
  maxRoleSlopeMbPerMinute: roleThresholds('SLOPE_MB_MIN'),
  maxRoleSecondHalfSlopeMbPerMinute: roleThresholds('SECOND_HALF_SLOPE_MB_MIN'),
  maxRolePlateauGrowthMb: roleThresholds('PLATEAU_GROWTH_MB')
}

const reportScenario = process.env.VIDEORC_PERF_SCENARIO ?? `${previewMode}-native-preview`
const reportMetadataEnvironment = {
  ...process.env,
  VIDEORC_SMOKE_PACKAGED_APP: packagedExecutable ? '1' : '0',
  VIDEORC_PERF_APP_ROLE: process.env.VIDEORC_PERF_APP_ROLE ?? `${previewMode}-native-preview`,
  VIDEORC_PERF_SOURCE_WIDTH: process.env.VIDEORC_PERF_SOURCE_WIDTH ?? '1280',
  VIDEORC_PERF_SOURCE_HEIGHT: process.env.VIDEORC_PERF_SOURCE_HEIGHT ?? '720',
  VIDEORC_PERF_SOURCE_FPS: process.env.VIDEORC_PERF_SOURCE_FPS ?? '60',
  VIDEORC_PERF_OUTPUTS_JSON:
    process.env.VIDEORC_PERF_OUTPUTS_JSON ??
    JSON.stringify([{ role: 'preview', width: 1280, height: 720, fps: 60 }])
}
const budgetRequest = activePerformanceBudgetRequest()
const reportMetadata = await collectPerformanceMetadata({
  cwd: repoRoot,
  env: reportMetadataEnvironment
})
const performanceBudgetStaticContext = {
  scenario: reportScenario,
  profileClass: reportMetadata.profileClass,
  appVersion: reportMetadata.appVersion,
  machineModel: reportMetadata.machineModel,
  hardwareClass: reportMetadata.hardwareClass,
  buildMode: reportMetadata.buildMode,
  commit: reportMetadata.commit,
  executableSha256: reportMetadata.executable?.sha256,
  packagePayloadSha256: reportMetadata.packagePayload?.sha256,
  operatingSystem: reportMetadata.operatingSystem,
  timing: reportMetadata.performanceWindow
}
const validatedActiveBudget = budgetRequest
  ? await readActivePerformanceBudget({ path: resolve(repoRoot, budgetRequest.path) })
  : null
if (validatedActiveBudget) {
  preflightActivePerformanceBudget({
    budget: validatedActiveBudget,
    profileId: budgetRequest.profileId,
    context: performanceBudgetStaticContext
  })
}

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-native-perf-'))
const appDataDir = join(stateRoot, 'app-data')
const userDataDir = join(stateRoot, 'user-data')
const ledgerPaths = ownedProcessLedgerPaths({ appDataDir, userDataDir, workspaceRoot: repoRoot })
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

let launched = null
let statusBefore = null
let statusAfter = null
let proofWindowState = null
let proofFallbackState = null
let samplingEvidence = null
let mainPumpDiagnostics = null
let memorySummary = null
let resourceCheckpoints = null
let cpuSummary = { averagePercentByRole: {}, p95PercentByRole: {} }
let pipeline = null
let compositorStatusAfter = null
let diagnosticStatusAfter = null
let wireTap = null
let measuredWireBytes = 0
let budgetFailures = []
let activeBudget = null
let activeBudgetEvaluation = null
let activeBudgetMetricFailures = []
let studioMicVisualStatus = null
let runError = null
let teardownError = null
let teardownClean = false
let teardownEvidence = null
let teardownFailures = []
let teardownRecovery = null
const detachedPreviewGeometryPhases = {}
let detachedPreviewGeometryEvidence =
  previewMode === 'detached' ? createDetachedPreviewCalibrationEvidence() : null

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    spawnSpec: packagedExecutable
      ? { command: packagedExecutable, args: [], cwd: dirname(packagedExecutable) }
      : undefined,
    env: {
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_APP_DATA_DIR: appDataDir,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(appDataDir, 'videorc.sqlite3'),
      VIDEORC_SMOKE_PACKAGED_APP: packagedExecutable ? '1' : '0'
    },
    onLine: (line) => {
      if (/error|panic|present pump/i.test(line)) console.log('APP>', line)
    }
  })

  const smoke = launched.connections['preview-motion-ready']
  console.log('isolated state:', stateRoot)
  console.log('smoke server', JSON.stringify(smoke), 'pgid', launched.process.pid)

  for (const attempt of [
    ['open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-card]' }],
    ['open-layout-tab', {}]
  ]) {
    try {
      await smokeCommandRetry(smoke, attempt[0], attempt[1])
      break
    } catch (error) {
      console.log(attempt[0], 'FAILED:', String(error?.message ?? error))
    }
  }
  if (requireStudioMicVisuals) {
    studioMicVisualStatus = await ensureStudioMicVisuals(smoke)
  }
  await smokeCommandRetry(smoke, 'preview-window-open')
  let budgetSurfaceStatus = null
  if (previewMode === 'detached') {
    const beforeWarmup = await prepareStableDetachedPreview(smoke)
    recordDetachedPreviewGeometryPhase('beforeWarmup', beforeWarmup.phase)
    assertDetachedPreviewGeometryPhase(beforeWarmup.phase)
    budgetSurfaceStatus = beforeWarmup.lastSurfaceStatus
  } else if (previewMode === 'docked') {
    await smokeCommandRetry(smoke, 'preview-window-set-mode', { mode: 'docked' })
    // A fresh profile can mount What's New after the dock epoch changes. Let
    // both the blocking overlay and the renderer's first slot report settle
    // before the performance window starts.
    await dismissBlockingLaunchDialogs(smoke)
    await waitForVisibleDockedPreview(smoke)
    budgetSurfaceStatus = await smokeCommand(smoke, 'native-preview-surface-status')
  }

  if (budgetRequest) {
    activeBudget = selectActivePerformanceBudget({
      budget: validatedActiveBudget,
      profileId: budgetRequest.profileId,
      context: {
        ...performanceBudgetStaticContext,
        displayScaleFactor:
          budgetSurfaceStatus?.bounds?.scaleFactor ?? reportMetadata.displayScaleFactor
      }
    })
    const config = activeBudget.probeConfig
    minPresentFps = config.cadence.minPresentFps
    maxIntervalP95Ms = config.cadence.maxIntervalP95Ms
    maxStatusFetchesPerSecond = config.pipeline.maxStatusFetchesPerSecond
    maxWireKibPerSecond = config.pipeline.maxWireKibPerSecond
    maxOpenFileGrowth = config.resources.maxOpenFileGrowth
    maxFootprintGrowthMb = config.resources.maxPhysicalFootprintGrowthMb
    Object.assign(thresholds, config.memory)
  }

  console.log(`warming ${warmupSeconds}s for ${previewMode} native preview...`)
  await sleep(warmupSeconds * 1000)
  if (previewMode === 'docked') {
    statusBefore = await smokeCommand(smoke, 'native-preview-surface-status')
  }

  console.log(`sampling ${sampleSeconds}s...`)
  const backend = launched.connections['backend-ready']
  const samples = []
  const cpuSamples = []
  const firstStableResourceCheckpoint = await collectStableProcessResourceCheckpoint({
    collectCensus: () =>
      collectProcessCensus({
        ledgerPaths,
        pgid: launched.process.pid
      })
  })
  resourceCheckpoints = {
    first: firstStableResourceCheckpoint.checkpoint,
    last: null,
    comparison: null
  }
  wireTap = await openBackendWireTap(backend)
  if (previewMode === 'detached') {
    const measurementStart = await captureDetachedPreviewGeometryPhase(smoke, {
      phaseName: 'measurementStart',
      requiredSamples: DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS.measurementStart,
      expectedStabilityKey: detachedPreviewGeometryReferenceKey()
    })
    recordDetachedPreviewGeometryPhase('measurementStart', measurementStart.phase)
    assertDetachedPreviewGeometryPhase(measurementStart.phase)
    statusBefore = measurementStart.firstSurfaceStatus
  }
  const scheduledSamples = await collectPerformanceSamplesOnSchedule({
    measurementMs,
    intervalMs: sampleIntervalMs,
    collectSample: async () => {
      const [census, cpu] = await Promise.all([
        collectProcessCensus({ ledgerPaths, pgid: launched.process.pid }),
        sampleProcessGroupCpu(launched.process.pid)
      ])
      return { census, cpu }
    }
  })
  for (const [index, sample] of scheduledSamples.samples.entries()) {
    const timing = scheduledSamples.sampleTimings[index]
    sample.census.sampledAtMs = timing.observedAtMs
    sample.census.scheduledAtMs = timing.scheduledAtMs
    samples.push(sample.census)
    cpuSamples.push(sample.cpu)
  }
  const measurementStartedAt = scheduledSamples.measurementStartedAtMs
  const measurementEndedAt = scheduledSamples.measurementEndedAtMs
  let detachedMeasurementWireBytes = null
  if (previewMode === 'detached') {
    detachedMeasurementWireBytes = wireTap.bytes()
    const measurementEnd = await captureDetachedPreviewGeometryPhase(smoke, {
      phaseName: 'measurementEnd',
      requiredSamples: DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS.measurementEnd,
      expectedStabilityKey: detachedPreviewGeometryReferenceKey()
    })
    recordDetachedPreviewGeometryPhase('measurementEnd', measurementEnd.phase)
    assertDetachedPreviewGeometryPhase(measurementEnd.phase)
    statusAfter = measurementEnd.firstSurfaceStatus
    if (!detachedPreviewGeometryEvidence.pass) {
      throw new Error(
        `Detached preview geometry changed across the measurement boundary: ${detachedPreviewGeometryEvidence.failures.join('; ')}`
      )
    }
  }
  samplingEvidence = {
    ...scheduledSamples.evidence,
    observations: scheduledSamples.sampleTimings,
    powerAssertion: reportMetadata.powerAssertion,
    powerAssertionVerified: await currentMacosCaffeinatePowerAssertionVerified({
      env: reportMetadataEnvironment
    })
  }
  if (previewMode === 'docked') {
    statusAfter = await smokeCommand(smoke, 'native-preview-surface-status')
  }
  mainPumpDiagnostics = await smokeCommand(smoke, 'main-present-pump-diagnostics')
  measuredWireBytes = previewMode === 'detached' ? detachedMeasurementWireBytes : wireTap.bytes()
  diagnosticStatusAfter = await wireTap.request('diagnostics.stats')
  wireTap.close()
  const lastStableResourceCheckpoint = await collectStableProcessResourceCheckpoint({
    collectCensus: () =>
      collectProcessCensus({
        ledgerPaths,
        pgid: launched.process.pid
      })
  })
  resourceCheckpoints.last = lastStableResourceCheckpoint.checkpoint
  resourceCheckpoints.comparison = compareProcessResourceCheckpoints(
    resourceCheckpoints.first,
    resourceCheckpoints.last
  )
  compositorStatusAfter = await backendJson(
    backend,
    `/compositor/status?token=${encodeURIComponent(backend.token)}`
  )
  proofWindowState = await smokeCommand(smoke, 'proof-window-state')
  proofFallbackState = await smokeCommand(smoke, 'exercise-native-preview-proof-fallback')
  memorySummary = summarizeProcessMemory(samples, {
    tailWindowMs: Math.min(120000, Math.max(sampleIntervalMs, (sampleSeconds * 1000) / 3))
  })
  cpuSummary = summarizeCpu(cpuSamples)
  budgetFailures = evaluateProcessMemoryGate(
    memorySummary,
    activeBudget ? invariantMemoryThresholds : thresholds
  )

  const framesBefore = statusBefore?.framesRendered ?? 0
  const framesAfter = statusAfter?.framesRendered ?? 0
  const frames = framesAfter - framesBefore
  const fetchesBefore = statusBefore?.nativePreviewMainStatusFetchSuccesses ?? 0
  const fetchesAfter = statusAfter?.nativePreviewMainStatusFetchSuccesses ?? 0
  const fetchDelta = fetchesAfter - fetchesBefore
  const measuredSeconds = Math.max(0.001, (measurementEndedAt - measurementStartedAt) / 1000)
  pipeline = {
    frames,
    framesPerSecond: frames / measuredSeconds,
    statusHttpFetches: fetchDelta,
    statusHttpFetchesPerSecond: fetchDelta / measuredSeconds,
    wireKibPerSecond: measuredWireBytes / measuredSeconds / 1024,
    wireEventCounts: wireTap.eventCounts(),
    presentFps: statusAfter?.presentFps,
    intervalP95Ms: statusAfter?.intervalP95Ms,
    intervalP99Ms: statusAfter?.intervalP99Ms,
    queueWaitP95Ms: statusAfter?.nativePreviewMainQueueWaitP95Ms,
    queuedBehind: statusAfter?.nativePreviewMainQueuedBehindCount,
    statusAgeP95Ms: statusAfter?.nativePreviewMainPresentedStatusAgeP95Ms,
    transport: statusAfter?.transport,
    backing: statusAfter?.backing,
    bounds: statusAfter?.bounds,
    framePipeline: compositorStatusAfter?.framePipeline ?? null,
    imageCache: compositorStatusAfter?.imageCache ?? null,
    runtimeDiagnostics: diagnosticStatusAfter,
    mainPumpDiagnostics,
    proofAnimationSuspended: proofWindowState?.animationSuspended,
    proofWindowVisible: proofWindowState?.visible,
    explicitFallback: {
      exists: proofFallbackState?.exists,
      visible: proofFallbackState?.visible,
      animationSuspended: proofFallbackState?.animationSuspended,
      bounds: proofFallbackState?.bounds,
      placement: proofFallbackState?.placement,
      transport: proofFallbackState?.status?.transport,
      backing: proofFallbackState?.status?.backing
    }
  }

  if (!activeBudget) {
    budgetFailures.push(
      ...cadenceFailures({
        presentFps: pipeline.presentFps,
        framesPerSecond: pipeline.framesPerSecond,
        intervalP95Ms: pipeline.intervalP95Ms,
        statusFetchesPerSecond: pipeline.statusHttpFetchesPerSecond
      })
    )
    if (pipeline.wireKibPerSecond > maxWireKibPerSecond) {
      budgetFailures.push(
        `unfiltered WebSocket wire rate ${pipeline.wireKibPerSecond.toFixed(2)}KiB/s exceeded ${maxWireKibPerSecond}KiB/s`
      )
    }
  }
  if (!pipeline.framePipeline) {
    budgetFailures.push('native compositor frame-pipeline diagnostics were missing')
  } else if (pipeline.framePipeline.consumer !== 'native-preview') {
    budgetFailures.push(
      `native compositor consumer was ${pipeline.framePipeline.consumer ?? 'missing'}; expected native-preview`
    )
  } else if (
    !Number.isFinite(pipeline.framePipeline.gpuReadbacks) ||
    !Number.isFinite(pipeline.framePipeline.yuvFramesConverted)
  ) {
    budgetFailures.push(
      `native compositor readback/conversion counters were incomplete: ${JSON.stringify(pipeline.framePipeline)}`
    )
  } else if (
    pipeline.framePipeline.gpuReadbacks !== 0 ||
    pipeline.framePipeline.yuvFramesConverted !== 0
  ) {
    budgetFailures.push(
      `native-only preview performed CPU publication work: ${JSON.stringify(pipeline.framePipeline)}`
    )
  }
  if (!activeBudget) {
    const openFileComparison = resourceCheckpoints?.comparison?.metrics?.openFileCount
    if (!openFileComparison?.comparable) {
      budgetFailures.push(
        `open-file checkpoint delta was not comparable: ${formatComparisonReasons(openFileComparison)}`
      )
    } else if (openFileComparison.delta > maxOpenFileGrowth) {
      budgetFailures.push(
        `open-file growth ${openFileComparison.delta} exceeded ${maxOpenFileGrowth}`
      )
    }
    const footprintComparison = resourceCheckpoints?.comparison?.metrics?.physicalFootprintBytes
    if (Number.isFinite(maxFootprintGrowthMb) && !footprintComparison?.comparable) {
      budgetFailures.push(
        `physical-footprint checkpoint delta was not comparable: ${formatComparisonReasons(footprintComparison)}`
      )
    } else if (Number.isFinite(maxFootprintGrowthMb)) {
      const growthMb = footprintComparison.delta / (1024 * 1024)
      if (growthMb > maxFootprintGrowthMb) {
        budgetFailures.push(
          `physical-footprint growth ${growthMb.toFixed(2)}MiB exceeded ${maxFootprintGrowthMb}MiB`
        )
      }
    }
  }

  console.log('\n=== process memory ===')
  console.log(formatProcessMemorySummary(memorySummary))
  console.log('\n=== average CPU by role ===')
  for (const [role, cpu] of Object.entries(cpuSummary.averagePercentByRole).sort()) {
    console.log(`${role.padEnd(24)} ${cpu.toFixed(1).padStart(6)}%`)
  }
  if (requireStudioMicVisuals) {
    studioMicVisualStatus = await ensureStudioMicVisuals(smoke, { selectDevice: false })
  }
  console.log('\n=== native pipeline ===')
  console.log(JSON.stringify(pipeline, null, 2))
} catch (error) {
  runError = error
} finally {
  wireTap?.close()
  try {
    if (launched) {
      const smoke = launched.connections['preview-motion-ready']
      let gracefulQuitError = null
      let gracefulQuitCompleted = false
      if (smoke) {
        try {
          await smokeCommand(smoke, 'app-quit')
          await waitForNoLiveProcessState({
            ledgerPaths,
            pgid: launched.process.pid,
            timeoutMs: 10000
          })
          gracefulQuitCompleted = true
        } catch (error) {
          gracefulQuitError = error?.message ?? String(error)
        }
      }
      const stopResult = gracefulQuitCompleted ? null : await launched.stop()
      const finalCensus = await waitForCleanProcessState({
        ledgerPaths,
        pgid: launched.process.pid,
        timeoutMs: 1000
      })
      teardownEvidence = {
        clean: finalCensus.records.length === 0 && finalCensus.processGroupRows.length === 0,
        gracefulQuitRequested: Boolean(smoke),
        gracefulQuitError,
        stopResult,
        finalCensus
      }
    }
    await waitForNoLiveProcessState({
      ledgerPaths,
      pgid: launched?.process?.pid,
      timeoutMs: 10000
    })
    teardownFailures = evaluateOwnedTeardown(teardownEvidence)
    teardownClean = teardownFailures.length === 0
  } catch (error) {
    teardownError = error
    try {
      teardownRecovery = await pruneDeadOwnedProcessRecords({ ledgerPaths })
    } catch (cleanupError) {
      teardownRecovery = { error: cleanupError?.message ?? String(cleanupError) }
    }
  }
}

if (activeBudget) {
  activeBudgetEvaluation = evaluateActivePerformanceBudget({
    profile: activeBudget.profile,
    metrics: {
      pipeline,
      memory: memorySummary,
      resourceCheckpoints,
      cpuAveragePercentByRole: cpuSummary.averagePercentByRole,
      cpuP95PercentByRole: cpuSummary.p95PercentByRole,
      teardownClean
    }
  })
  activeBudgetMetricFailures = activeBudgetEvaluation.metricFailures
  budgetFailures.push(...activeBudgetEvaluation.thresholdFailures)
}

if (previewMode === 'detached') {
  detachedPreviewGeometryEvidence = createDetachedPreviewCalibrationEvidence(
    detachedPreviewGeometryPhases
  )
}
const truthFailures = [
  ...(runError ? [runError.message] : []),
  ...(teardownError ? [teardownError.message] : []),
  ...teardownFailures,
  ...activeBudgetMetricFailures,
  ...(requireStudioMicVisuals && studioMicVisualStatus?.live !== true
    ? ['Studio live microphone visualizer did not remain active through measurement']
    : []),
  ...(detachedPreviewGeometryEvidence?.failures ?? []).map(
    (failure) => `detached preview geometry: ${failure}`
  ),
  ...performanceSamplingEvidenceFailures(samplingEvidence, measurementMs, sampleIntervalMs),
  ...(reportMetadata.powerAssertion && samplingEvidence?.powerAssertionVerified !== true
    ? ['macOS power assertion was declared but not verified through the measurement boundary']
    : []),
  ...evaluateScenarioTruth({
    frames: pipeline?.frames ?? 0,
    expectedTransport,
    actualTransport: pipeline?.transport,
    expectedBacking,
    actualBacking: pipeline?.backing,
    teardownClean
  }),
  ...(pipeline && pipeline.proofAnimationSuspended !== true
    ? [
        `native presentation left proof animation suspended=${String(pipeline.proofAnimationSuspended)}; expected true`
      ]
    : []),
  ...(pipeline &&
  (pipeline.explicitFallback?.exists !== true ||
    pipeline.explicitFallback?.visible !== true ||
    pipeline.explicitFallback?.animationSuspended !== false ||
    pipeline.explicitFallback?.transport !== 'electron-proof-surface' ||
    pipeline.explicitFallback?.backing !== 'electron-browser-window')
    ? [
        `explicit fallback did not resume the visible Electron proof surface: ${JSON.stringify(pipeline.explicitFallback)}`
      ]
    : [])
]
const enforcedBudgetFailures = mode === 'gate' ? budgetFailures : []
const metadataWithDisplayScale = performanceMetadataWithObservedDisplayScale(
  reportMetadata,
  pipeline?.bounds?.scaleFactor
)
const report = createPerformanceReport({
  scenario: reportScenario,
  mode,
  metadata:
    previewMode === 'detached'
      ? {
          ...metadataWithDisplayScale,
          detachedPreviewGeometry: detachedPreviewCalibrationProvenance(
            detachedPreviewGeometryEvidence
          )
        }
      : metadataWithDisplayScale,
  timing: {
    warmupMs: warmupSeconds * 1000,
    measurementMs: sampleSeconds * 1000,
    intervalMs: sampleIntervalMs
  },
  metrics: {
    teardownClean,
    teardownEvidence,
    pipeline,
    cpuAveragePercentByRole: cpuSummary.averagePercentByRole,
    cpuP95PercentByRole: cpuSummary.p95PercentByRole,
    studioMicVisualStatus,
    memory: memorySummary,
    sampling: samplingEvidence,
    resourceCheckpoints,
    teardownRecovery,
    ...(previewMode === 'detached'
      ? { detachedPreviewGeometry: detachedPreviewGeometryEvidence }
      : {}),
    activeBudget: activeBudget
      ? {
          path: activeBudget.path,
          profileId: activeBudget.profile.id,
          scope: activeBudget.profile.scope,
          evidence: activeBudget.profile.evidence
        }
      : null,
    activeBudgetEvaluation,
    thresholds
  },
  checks: [
    ...(!truthFailures.length
      ? [passingCheck('native frames, transport, backing, and teardown were truthful')]
      : []),
    ...failingChecks(truthFailures),
    ...failingChecks(enforcedBudgetFailures),
    ...(mode === 'report-only'
      ? budgetFailures.map((failure) => observationCheck(`report-only observation: ${failure}`))
      : [])
  ]
})
const reportPath = await writePerformanceReport(report)
console.log(`Native performance report: ${reportPath}`)

const failed = truthFailures.length > 0 || enforcedBudgetFailures.length > 0
if (!failed && process.env.VIDEORC_PERF_RETAIN_ARTIFACTS !== '1') {
  await rm(stateRoot, { recursive: true, force: true })
} else {
  console.log(`Native performance scratch retained: ${stateRoot}`)
}

if (failed) {
  throw new Error(
    `Native performance ${mode} failed:\n${[...truthFailures, ...enforcedBudgetFailures].join('\n')}`
  )
}
console.log(`Native performance ${mode} PASSED`)

function cadenceFailures({ presentFps, framesPerSecond, intervalP95Ms, statusFetchesPerSecond }) {
  const failures = []
  if (!Number.isFinite(presentFps) || presentFps < minPresentFps) {
    failures.push(`present FPS ${presentFps ?? 'missing'} was below ${minPresentFps}`)
  }
  if (!Number.isFinite(framesPerSecond) || framesPerSecond < minPresentFps) {
    failures.push(
      `measured frame delta rate ${framesPerSecond ?? 'missing'}fps was below ${minPresentFps}`
    )
  }
  if (!Number.isFinite(intervalP95Ms) || intervalP95Ms > maxIntervalP95Ms) {
    failures.push(
      `present interval p95 ${intervalP95Ms ?? 'missing'}ms exceeded ${maxIntervalP95Ms}ms`
    )
  }
  if (statusFetchesPerSecond > maxStatusFetchesPerSecond) {
    failures.push(
      `status fetch rate ${statusFetchesPerSecond.toFixed(2)}/s exceeded ${maxStatusFetchesPerSecond}/s`
    )
  }
  return failures
}

async function sampleProcessGroupCpu(pgid) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,pcpu=,rss=,comm=,args='])
  const roles = {}
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!match || Number(match[2]) !== pgid) continue
    const role = classifyProcess({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      rssKb: Number(match[4]),
      command: match[5],
      args: match[6] ?? ''
    })
    roles[role] = (roles[role] ?? 0) + Number(match[3])
  }
  return roles
}

function summarizeCpu(samples) {
  const roles = new Set(samples.flatMap((sample) => Object.keys(sample)))
  const summaries = [...roles].map((role) => {
    const values = samples.map((sample) => sample[role] ?? 0).sort((left, right) => left - right)
    const average = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)
    const p95 = values.length > 0 ? values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] : 0
    return [role, { average, p95 }]
  })
  return {
    averagePercentByRole: Object.fromEntries(
      summaries.map(([role, summary]) => [role, summary.average])
    ),
    p95PercentByRole: Object.fromEntries(summaries.map(([role, summary]) => [role, summary.p95]))
  }
}

async function ensureStudioMicVisuals(smoke, { selectDevice = true } = {}) {
  const response = await smokeCommandRetry(smoke, 'eval-js', {
    code: `
      await openTab('sources', '[data-videorc-mic-preview]');
      if (${selectDevice ? 'true' : 'false'}) {
        const label = Array.from(document.querySelectorAll('label')).find(
          (candidate) => candidate.textContent?.trim() === 'Microphone'
        );
        const trigger = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
        if (!trigger) throw new Error('Studio microphone picker was not found.');
        trigger.click();
        await sleep(250);
        const option = Array.from(document.querySelectorAll('[role="option"]')).find(
          (candidate) =>
            candidate.getAttribute('aria-disabled') !== 'true' &&
            !candidate.hasAttribute('data-disabled') &&
            candidate.textContent?.trim() !== 'None'
        );
        if (!option) throw new Error('No available Studio microphone could be selected.');
        option.click();
        await sleep(1000);
      }
      await openTab('studio', '[data-videorc-mic-visualizer]');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const visualizer = document.querySelector('[data-videorc-mic-visualizer]');
        const live = Array.from(document.querySelectorAll('span')).some(
          (candidate) => candidate.textContent?.trim() === 'Live'
        );
        if (visualizer && live) return { mounted: true, live: true };
        await sleep(100);
      }
      return {
        mounted: Boolean(document.querySelector('[data-videorc-mic-visualizer]')),
        live: false
      };
    `
  })
  return response?.result ?? response
}

async function openBackendWireTap(backend) {
  const socket = new WebSocket(
    `ws://${backend.host}:${backend.port}/ws?token=${encodeURIComponent(backend.token)}`
  )
  let byteCount = 0
  const counts = new Map()
  const pending = new Map()
  let requestCounter = 0
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    byteCount += Buffer.byteLength(event.data)
    try {
      const parsed = JSON.parse(event.data)
      if (parsed.id && pending.has(parsed.id)) {
        const entry = pending.get(parsed.id)
        pending.delete(parsed.id)
        clearTimeout(entry.timer)
        if (parsed.ok) entry.resolve(parsed.payload)
        else entry.reject(new Error(parsed.error?.message ?? 'wire tap request failed'))
        return
      }
      if (parsed.event) counts.set(parsed.event, (counts.get(parsed.event) ?? 0) + 1)
    } catch {
      // Command responses are not part of the event-rate summary.
    }
  })
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('wire tap WebSocket timed out')), 5000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolveOpen()
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        rejectOpen(new Error('wire tap WebSocket failed to connect'))
      },
      { once: true }
    )
  })
  return {
    bytes: () => byteCount,
    close: () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('wire tap closed'))
      }
      pending.clear()
      socket.close()
    },
    request: (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = `perf-${Date.now()}-${++requestCounter}`
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectRequest(new Error(`wire tap ${method} timed out`))
        }, 5000)
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
        socket.send(JSON.stringify({ id, method, params }))
      }),
    eventCounts: () =>
      Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
  }
}

function backendJson(backend, path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      { hostname: backend.host, port: backend.port, path, method: 'GET' },
      (response) => {
        response.setEncoding('utf8')
        let text = ''
        response.on('data', (chunk) => (text += chunk))
        response.on('end', () => {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            rejectRequest(new Error(`backend ${path} returned HTTP ${response.statusCode}`))
            return
          }
          try {
            resolveRequest(JSON.parse(text))
          } catch {
            rejectRequest(new Error(`backend ${path} returned invalid JSON`))
          }
        })
      }
    )
    request.on('error', rejectRequest)
    request.setTimeout(5000, () => request.destroy(new Error(`backend ${path} timed out`)))
    request.end()
  })
}

function smokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolveCommand, rejectCommand) => {
    const request = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${smoke.capability}`
        }
      },
      (response) => {
        response.setEncoding('utf8')
        let text = ''
        response.on('data', (chunk) => (text += chunk))
        response.on('end', () => {
          try {
            const payload = JSON.parse(text)
            if (payload.error) rejectCommand(new Error(`${command} -> ${payload.error}`))
            else resolveCommand(payload.result ?? payload)
          } catch {
            rejectCommand(new Error(`${command} -> invalid JSON: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    request.on('error', rejectCommand)
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`${command} timed out after ${timeoutMs}ms`))
    })
    request.write(body)
    request.end()
  })
}

async function smokeCommandRetry(smoke, command, params = {}) {
  const deadline = Date.now() + 30000
  let lastError
  while (Date.now() < deadline) {
    try {
      return await smokeCommand(smoke, command, params)
    } catch (error) {
      lastError = error
      const message = String(error?.message ?? error)
      if (
        !message.includes('Main window is not ready') &&
        !message.includes('Could not find tab')
      ) {
        throw error
      }
      await sleep(250)
    }
  }
  throw lastError
}

async function dismissBlockingLaunchDialogs(smoke) {
  const response = await smokeCommandRetry(smoke, 'eval-js', {
    code: `
      const scrimSelector = '[data-slot="dialog-overlay"][data-state="open"]'
      const deadline = Date.now() + 10000
      let quietSince = Date.now()
      let closed = 0
      while (Date.now() < deadline) {
        const scrims = document.querySelectorAll(scrimSelector)
        if (scrims.length > 0) {
          quietSince = Date.now()
          document.querySelectorAll('[data-slot="dialog-close"]').forEach((button) => {
            button.click()
            closed += 1
          })
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        } else if (Date.now() - quietSince >= 3000) {
          return { settled: true, closed }
        }
        await sleep(100)
      }
      return {
        settled: false,
        closed,
        openScrims: document.querySelectorAll(scrimSelector).length
      }
    `
  })
  if (response.result?.settled !== true) {
    throw new Error(`Timed out dismissing launch dialogs: ${JSON.stringify(response.result)}`)
  }
}

async function waitForVisibleDockedPreview(smoke) {
  const deadline = Date.now() + 15000
  let state = null
  while (Date.now() < deadline) {
    state = await smokeCommandRetry(smoke, 'preview-window-state')
    if (
      state.open === true &&
      state.mode === 'docked' &&
      state.visible === true &&
      state.dockHiddenReason === null
    ) {
      return state
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for visible docked preview: ${JSON.stringify(state)}`)
}

async function prepareStableDetachedPreview(smoke) {
  await smokeCommandRetry(smoke, 'preview-window-set-bounds', {
    width: DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE.width,
    height: DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE.height
  })

  return captureDetachedPreviewGeometryPhase(smoke, {
    phaseName: 'beforeWarmup',
    requiredSamples: DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS.beforeWarmup,
    allowSettle: true
  })
}

async function captureDetachedPreviewGeometryPhase(
  smoke,
  { phaseName, requiredSamples, expectedStabilityKey = null, allowSettle = false }
) {
  const deadline = Date.now() + 30000
  let attempts = 0
  let stableSamples = []
  let stableSurfaceStatuses = []
  let failure = null

  while (Date.now() < deadline) {
    const [windowState, surfaceStatus] = await Promise.all([
      smokeCommandRetry(smoke, 'preview-window-state'),
      smokeCommandRetry(smoke, 'native-preview-surface-status')
    ])
    attempts += 1
    const inspection = {
      observedAt: new Date().toISOString(),
      ...inspectDetachedPreviewCalibrationSample(windowState, surfaceStatus)
    }

    const priorKey = stableSamples.at(-1)?.stabilityKey ?? null
    const expectedKey = expectedStabilityKey ?? priorKey
    const invalid = inspection.ready !== true
    const drifted = Boolean(expectedKey && inspection.stabilityKey !== expectedKey)
    if (invalid || drifted) {
      failure = invalid
        ? inspection.failures.join('; ')
        : `geometry drifted from ${expectedKey} to ${inspection.stabilityKey}`
      if (!allowSettle) {
        stableSamples.push(inspection)
        stableSurfaceStatuses.push(surfaceStatus)
        break
      }
      stableSamples = invalid ? [] : [inspection]
      stableSurfaceStatuses = invalid ? [] : [surfaceStatus]
      await sleep(250)
      continue
    }

    failure = null
    stableSamples.push(inspection)
    stableSurfaceStatuses.push(surfaceStatus)
    if (stableSamples.length >= requiredSamples) {
      const target = DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE
      console.log(
        `detached preview ${phaseName} stable at ${target.width}x${target.height} for ${requiredSamples} consecutive sample(s)`
      )
      break
    }
    await sleep(250)
  }

  const pass = stableSamples.length >= requiredSamples && failure === null
  const phaseFailure = pass
    ? null
    : (failure ??
      `timed out with ${stableSamples.length}/${requiredSamples} stable geometry samples`)
  return {
    phase: {
      phase: phaseName,
      requiredSamples,
      attempts,
      pass,
      failure: phaseFailure,
      samples: stableSamples.slice(-requiredSamples)
    },
    firstSurfaceStatus: stableSurfaceStatuses.at(-stableSamples.length) ?? null,
    lastSurfaceStatus: stableSurfaceStatuses.at(-1) ?? null
  }
}

function recordDetachedPreviewGeometryPhase(phaseName, phase) {
  detachedPreviewGeometryPhases[phaseName] = phase
  detachedPreviewGeometryEvidence = createDetachedPreviewCalibrationEvidence(
    detachedPreviewGeometryPhases
  )
}

function assertDetachedPreviewGeometryPhase(phase) {
  if (phase?.pass === true) return
  throw new Error(
    `Detached preview geometry ${phase?.phase ?? 'unknown'} failed: ${phase?.failure ?? 'evidence missing'}`
  )
}

function detachedPreviewGeometryReferenceKey() {
  return detachedPreviewGeometryPhases.beforeWarmup?.samples?.[0]?.stabilityKey ?? null
}

function roleThresholds(suffix) {
  const mapping = {
    backend: 'BACKEND',
    'electron-main': 'MAIN',
    'electron-renderer': 'RENDERER',
    'electron-gpu': 'GPU',
    'native-preview-helper': 'HELPER'
  }
  return Object.fromEntries(
    Object.entries(mapping)
      .map(([role, envRole]) => [role, optionalNumber(`VIDEORC_PERF_MAX_${envRole}_${suffix}`)])
      .filter(([, value]) => Number.isFinite(value))
  )
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function optionalNumber(name) {
  if (!(name in process.env)) return undefined
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function formatComparisonReasons(comparison) {
  return comparison?.reasons?.length ? comparison.reasons.join('; ') : 'comparison missing'
}
