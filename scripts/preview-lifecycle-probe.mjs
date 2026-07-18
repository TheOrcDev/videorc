#!/usr/bin/env node
// Preview lifecycle probe: repeated command-level open/close/toggle coverage.
//
// This complements preview-window-probe.mjs. The window probe proves placement;
// this probe proves the lifecycle does not get stuck after repeated close/reopen
// cycles and that close fully suppresses detached-preview presentation work.

import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  launchDevApp,
  performanceAppSpawnSpec,
  repoRoot,
  stopProcess
} from './lib/app-launcher.mjs'
import {
  activePerformanceBudgetRequest,
  evaluateActivePerformanceBudget,
  preflightActivePerformanceBudget,
  readActivePerformanceBudget,
  selectActivePerformanceBudget
} from './lib/performance-budget.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  observationCheck,
  passingCheck,
  performanceMetadataWithObservedDisplayScale,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import {
  collectProcessCensus,
  ownedProcessLedgerPaths,
  pruneDeadOwnedProcessRecords,
  waitForCleanProcessState,
  waitForNoLiveProcessState
} from './lib/process-census.mjs'
import { collectProcessEndurance, evaluateOwnedTeardown } from './lib/process-endurance.mjs'
import {
  evaluateProcessMemoryGate,
  formatProcessMemorySummary,
  requiredProcessMemoryTrendThresholdFailures,
  summarizeProcessMemory
} from './lib/process-memory-gate.mjs'
import { requestSmokeCommandWithRetry } from './lib/smoke-command-client.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const mode = performanceMode()
const reportScenario = process.env.VIDEORC_PERF_SCENARIO ?? 'preview-lifecycle'
const requiresReviewedTrendThresholds = mode === 'gate' && reportScenario === 'lifecycle-churn'
const calibrationMode = process.env.VIDEORC_PERF_CALIBRATION === '1'
const fullLifecycleEndurance = reportScenario === 'lifecycle-churn'
const cycles = positiveInteger(process.env.VIDEORC_PREVIEW_LIFECYCLE_CYCLES, 100)
const outputDirectory =
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
  join(tmpdir(), `videorc-preview-lifecycle-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })
const ledgerPaths = ownedProcessLedgerPaths({
  appDataDir: join(outputDirectory, 'app-data'),
  userDataDir: join(outputDirectory, 'user-data'),
  workspaceRoot: repoRoot
})
const memoryThresholds = {
  minSamples: expectedMemoryCheckpointCount(cycles),
  maxTotalRssMb: Number(process.env.VIDEORC_LIFECYCLE_MAX_TOTAL_RSS_MB ?? 4096),
  maxOwnedRssMb: Number(process.env.VIDEORC_LIFECYCLE_MAX_OWNED_RSS_MB ?? 2048),
  maxOwnedSlopeMbPerMinute: optionalNumber('VIDEORC_LIFECYCLE_MAX_OWNED_SLOPE_MB_MIN'),
  maxOwnedSecondHalfSlopeMbPerMinute: optionalNumber(
    'VIDEORC_LIFECYCLE_MAX_OWNED_SECOND_HALF_SLOPE_MB_MIN'
  ),
  maxOwnedPlateauGrowthMb: optionalNumber('VIDEORC_LIFECYCLE_MAX_OWNED_PLATEAU_GROWTH_MB'),
  minRoleCount: { backend: 1, 'electron-main': 1, 'electron-renderer': 1 },
  maxRoleCount: {
    backend: 1,
    'electron-main': 1,
    'electron-renderer': 3,
    'native-preview-helper': 1
  },
  maxRoleSlopeMbPerMinute: lifecycleRoleThresholds('SLOPE_MB_MIN'),
  maxRoleSecondHalfSlopeMbPerMinute: lifecycleRoleThresholds('SECOND_HALF_SLOPE_MB_MIN'),
  maxRolePlateauGrowthMb: lifecycleRoleThresholds('PLATEAU_GROWTH_MB')
}
const reportMetadata = await collectPerformanceMetadata({ cwd: repoRoot })
let reportMetadataWithDisplayScale = reportMetadata
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

let launched
let smoke
let budgetRequest = null
let validatedActiveBudget = null
let activeBudget = null
let thresholdConfigurationFailures = []
let lastState = null
let lastSupervisorGeneration = 0
let exitCode = 0
let failureMessage = null
let teardownClean = false
let teardownEvidence = null
let teardownRecovery = null
let processEndurance = null
let activeBudgetEvaluation = null
const memoryCheckpoints = []

try {
  exitCode = await main()
} catch (error) {
  console.error(`preview lifecycle probe failed: ${error?.message ?? error}`)
  if (lastState) {
    console.error(`last preview state: ${JSON.stringify(lastState)}`)
  }
  failureMessage = error?.message ?? String(error)
  exitCode = 2
} finally {
  if (launched) {
    let gracefulQuitCompleted = false
    let gracefulQuitError = null
    if (smoke) {
      try {
        await requestSmokeCommandWithRetry(
          smoke,
          'preview-lifecycle-allow-app-quit',
          {},
          { timeoutMs: 500 }
        )
        await requestSmokeCommandWithRetry(smoke, 'app-quit', {}, { timeoutMs: 1000 })
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
    try {
      let stopResult = null
      if (!gracefulQuitCompleted) {
        stopResult = await stopProcess(launched.process)
      }
      await waitForNoLiveProcessState({
        ledgerPaths,
        pgid: launched.process.pid,
        timeoutMs: 10000
      })
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
      const teardownFailures = evaluateOwnedTeardown(teardownEvidence)
      teardownClean = teardownFailures.length === 0
      if (teardownFailures.length > 0) {
        failureMessage = `Lifecycle teardown failed:\n${teardownFailures.join('\n')}`
        exitCode = 2
      }
    } catch (error) {
      failureMessage = `Lifecycle teardown failed: ${error?.message ?? error}`
      exitCode = 2
      try {
        teardownRecovery = await pruneDeadOwnedProcessRecords({ ledgerPaths })
      } catch (cleanupError) {
        teardownRecovery = { error: cleanupError?.message ?? String(cleanupError) }
      }
    }
  }
}

const memorySummary =
  processEndurance?.memory?.summary ??
  summarizeProcessMemory(memoryCheckpoints, {
    tailWindowMs: Number(process.env.VIDEORC_LIFECYCLE_MEMORY_TAIL_WINDOW_MS ?? 120000)
  })
const memoryFailures = evaluateProcessMemoryGate(memorySummary, memoryThresholds)
const cpuAveragePercentByRole = Object.fromEntries(
  Object.entries(processEndurance?.cpu?.summary?.byRole ?? {}).map(([role, summary]) => [
    role,
    summary.averagePercent
  ])
)
const cpuP95PercentByRole = Object.fromEntries(
  Object.entries(processEndurance?.cpu?.summary?.byRole ?? {}).map(([role, summary]) => [
    role,
    summary.p95Percent
  ])
)
if (activeBudget) {
  activeBudgetEvaluation = evaluateActivePerformanceBudget({
    profile: activeBudget.profile,
    metricContract: 'lifecycle',
    metrics: {
      memory: memorySummary,
      cpuAveragePercentByRole,
      cpuP95PercentByRole,
      resourceCheckpoints: processEndurance?.resourceCheckpoints,
      teardownClean
    }
  })
}
const activeBudgetFailures = [
  ...(activeBudgetEvaluation?.metricFailures ?? []),
  ...(activeBudgetEvaluation?.thresholdFailures ?? [])
]
if (memoryCheckpoints.length > 0) {
  console.log('\n=== Preview lifecycle memory/process checkpoints ===')
  console.log(formatProcessMemorySummary(memorySummary))
}
if (mode === 'gate' && (memoryFailures.length > 0 || activeBudgetFailures.length > 0)) {
  const memoryFailureMessage = `Lifecycle performance gate failed:\n${[
    ...memoryFailures,
    ...activeBudgetFailures
  ].join('\n')}`
  failureMessage = failureMessage
    ? `${failureMessage}\n${memoryFailureMessage}`
    : memoryFailureMessage
  exitCode = 2
}
if (!teardownClean) {
  failureMessage ??= 'Lifecycle app-owned process teardown was not clean.'
  exitCode = 2
}

const report = createPerformanceReport({
  scenario: reportScenario,
  mode,
  metadata: reportMetadataWithDisplayScale,
  timing: fullLifecycleEndurance ? { ...reportMetadata.performanceWindow, cycles } : { cycles },
  metrics: {
    memory: memorySummary,
    sampling: processEndurance?.sampling ?? null,
    cpuAveragePercentByRole,
    cpuP95PercentByRole,
    resourceCheckpoints: processEndurance?.resourceCheckpoints ?? null,
    thresholds: activeBudget?.profile?.thresholds ?? memoryThresholds,
    thresholdConfigurationFailures,
    activeBudget: activeBudget
      ? {
          path: activeBudget.path,
          profileId: activeBudget.profile.id,
          scope: activeBudget.profile.scope,
          evidence: activeBudget.profile.evidence
        }
      : null,
    activeBudgetEvaluation,
    budgetFailures: [...memoryFailures, ...activeBudgetFailures],
    teardownClean,
    teardownEvidence,
    teardownRecovery,
    scratchDirectory: outputDirectory
  },
  checks: [
    ...(exitCode === 0
      ? [passingCheck(`${cycles} lifecycle cycles and exact teardown completed`)]
      : failingChecks([failureMessage ?? 'preview lifecycle probe failed'])),
    ...(mode === 'report-only'
      ? [...memoryFailures, ...activeBudgetFailures].map((failure) =>
          observationCheck(`report-only observation: ${failure}`)
        )
      : [])
  ]
})
const reportPath = await writePerformanceReport(report)
console.log(`Preview lifecycle performance report: ${reportPath}`)
if (exitCode === 0 && process.env.VIDEORC_PERF_RETAIN_ARTIFACTS !== '1') {
  await rm(outputDirectory, { recursive: true, force: true })
} else {
  console.log(`Preview lifecycle scratch retained: ${outputDirectory}`)
}

process.exit(exitCode)

async function main() {
  budgetRequest = activePerformanceBudgetRequest()
  if (requiresReviewedTrendThresholds && !calibrationMode && !budgetRequest) {
    throw new Error(
      'Lifecycle-churn gate requires a reviewed active performance budget; set VIDEORC_PERF_ACTIVE_BUDGET_PATH.'
    )
  }
  if (budgetRequest) {
    validatedActiveBudget = await readActivePerformanceBudget({
      path: resolve(repoRoot, budgetRequest.path)
    })
    preflightActivePerformanceBudget({
      budget: validatedActiveBudget,
      profileId: budgetRequest.profileId,
      context: performanceBudgetStaticContext
    })
  }

  console.log(`Launching dev app for preview lifecycle probe (${cycles} cycles)...`)
  launched = await launchDevApp({
    spawnSpec: performanceAppSpawnSpec(),
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_PREVIEW_LIFECYCLE_PROBE: '1',
      VIDEORC_GLASS_WALLPAPER: '0'
    },
    onLine: (line) => console.log(line)
  })
  smoke = launched.connections['preview-motion-ready']

  const initialState = await ensureClosed('initial close')
  reportMetadataWithDisplayScale = performanceMetadataWithObservedDisplayScale(
    reportMetadata,
    initialState?.scaleFactor
  )
  if (validatedActiveBudget) {
    activeBudget = selectActivePerformanceBudget({
      budget: validatedActiveBudget,
      profileId: budgetRequest.profileId,
      context: {
        ...performanceBudgetStaticContext,
        displayScaleFactor: reportMetadataWithDisplayScale.displayScaleFactor
      }
    })
    Object.assign(memoryThresholds, activeBudget.probeConfig.memory)
  }
  if (requiresReviewedTrendThresholds) {
    if (!calibrationMode) {
      thresholdConfigurationFailures = requiredProcessMemoryTrendThresholdFailures(memoryThresholds)
      assertProbe(
        thresholdConfigurationFailures.length === 0,
        'lifecycle-churn gate has reviewed owned and per-role trend thresholds',
        thresholdConfigurationFailures
      )
    }
  }
  const enduranceStartedAtMs = Date.now()
  const endurancePromise = fullLifecycleEndurance
    ? collectProcessEndurance({
        ledgerPaths,
        pgid: launched.process.pid,
        warmupMs: reportMetadata.performanceWindow.warmupMs,
        measurementMs: reportMetadata.performanceWindow.measurementMs,
        intervalMs: reportMetadata.performanceWindow.intervalMs
      })
    : null
  await captureMemoryCheckpoint('initial')
  lastSupervisorGeneration = supervisorGeneration(initialState)
  const quitAttempt = await smokeCommand('preview-lifecycle-attempt-app-quit')
  assertProbe(
    quitAttempt?.prevented === true,
    'probe ownership: unrelated app quit was prevented',
    quitAttempt
  )
  const afterQuitAttempt = await smokeCommand('preview-window-state')
  assertProbe(
    afterQuitAttempt.open === false && afterQuitAttempt.supervisor?.lifecycleState === 'closed',
    'probe ownership: app and command server remained live after the quit attempt',
    afterQuitAttempt
  )

  if (fullLifecycleEndurance) {
    const warmupRemainingMs =
      reportMetadata.performanceWindow.warmupMs - (Date.now() - enduranceStartedAtMs)
    if (warmupRemainingMs > 0) await sleep(warmupRemainingMs)
  }
  const lifecycleMeasurementStartedAtMs = Date.now()

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    await toggleOpen(`cycle ${cycle}: toggle open`)
    await setPreviewMode('docked', `cycle ${cycle}: dock`)
    await setPreviewMode('floating', `cycle ${cycle}: undock`)
    if (cycle === 1) {
      await assertStaleDestroyIgnored('cycle 1: stale destroy is ignored')
      await assertPermissionRequiredStopsSurface('cycle 1: permission-required stops presentation')
    }
    await toggleClosed(`cycle ${cycle}: toggle close`)
    if (cycle === 1 || cycle === cycles || cycle % 10 === 0) {
      await captureMemoryCheckpoint(`cycle-${cycle}`)
      console.log(`OK   completed ${cycle}/${cycles} preview lifecycle cycles`)
    }
    if (fullLifecycleEndurance) {
      const targetElapsedMs = (reportMetadata.performanceWindow.measurementMs * cycle) / cycles
      const remainingMs = targetElapsedMs - (Date.now() - lifecycleMeasurementStartedAtMs)
      if (remainingMs > 0) await sleep(remainingMs)
    }
  }

  await toggleOpen('os close path: toggle open')
  await closeWithOsFrame('os close path: window frame close')
  await shortcutOpen('shortcut path: Cmd+P after OS close')
  await toggleClosed('shortcut path: cleanup close')

  await toggleOpen('final reopen')
  await toggleClosed('final close')
  await captureMemoryCheckpoint('final')
  if (endurancePromise) processEndurance = await endurancePromise

  console.log('\n=== Preview lifecycle probe summary ===')
  console.log(
    `PASS - ${cycles} repeated preview toggle cycles opened, closed, tore down surfaces, and suppressed frame polling.`
  )
  return 0
}

async function setPreviewMode(mode, label) {
  const state = await smokeCommand('preview-window-set-mode', { mode })
  assertProbe(state?.mode === mode, `${label}: preview reports ${mode} mode`, state)
}

async function toggleOpen(label) {
  const toggled = await smokeCommand('preview-window-toggle', { expectedOpen: true })
  assertProbe(
    toggled.supervisor?.windowOpen === true || toggled.supervisor?.lifecycleState === 'opening',
    `${label}: supervisor reports window opening`,
    toggled
  )
  const generation = supervisorGeneration(toggled)
  assertProbe(generation > lastSupervisorGeneration, `${label}: supervisor generation advanced`, {
    previous: lastSupervisorGeneration,
    current: generation,
    state: toggled
  })
  lastSupervisorGeneration = generation
  const state = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.visible === true &&
      supervisorGeneration(candidate) === generation &&
      candidate.supervisor?.windowOpen === true &&
      candidate.supervisor?.lifecycleState !== 'closed' &&
      candidate.supervisor?.lifecycleState !== 'closing' &&
      candidate.framePollingSuppressedFlag === false,
    8000
  )
  assertProbe(state.ok, `${label}: preview became visible and polling resumed`, state.last)
}

async function toggleClosed(label) {
  const toggled = await smokeCommand('preview-window-toggle', { expectedOpen: false })
  assertProbe(toggled.open === false, `${label}: command reports closed`, toggled)
  assertProbe(
    supervisorGeneration(toggled) === lastSupervisorGeneration,
    `${label}: supervisor generation is stable while closing`,
    { expected: lastSupervisorGeneration, state: toggled }
  )
  await waitUntilClosed(`${label}: preview fully closed`)
}

async function closeWithOsFrame(label) {
  const closed = await smokeCommand('preview-window-os-close')
  assertProbe(closed.open === false, `${label}: command reports closed`, closed)
  assertProbe(
    supervisorGeneration(closed) === lastSupervisorGeneration,
    `${label}: supervisor generation is stable while closing`,
    { expected: lastSupervisorGeneration, state: closed }
  )
  await waitUntilClosed(`${label}: preview fully closed`)
}

async function shortcutOpen(label) {
  const opened = await smokeCommand('dispatch-preview-shortcut', { expectedOpen: true })
  assertProbe(
    opened.supervisor?.windowOpen === true || opened.supervisor?.lifecycleState === 'opening',
    `${label}: supervisor reports window opening`,
    opened
  )
  const generation = supervisorGeneration(opened)
  assertProbe(generation > lastSupervisorGeneration, `${label}: supervisor generation advanced`, {
    previous: lastSupervisorGeneration,
    current: generation,
    state: opened
  })
  lastSupervisorGeneration = generation
  const state = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.visible === true &&
      supervisorGeneration(candidate) === generation &&
      candidate.supervisor?.windowOpen === true &&
      candidate.supervisor?.lifecycleState !== 'closed' &&
      candidate.supervisor?.lifecycleState !== 'closing' &&
      candidate.framePollingSuppressedFlag === false,
    8000
  )
  assertProbe(state.ok, `${label}: preview became visible and polling resumed`, state.last)
}

async function assertStaleDestroyIgnored(label) {
  const currentGeneration = lastSupervisorGeneration
  if (currentGeneration <= 0) {
    return
  }
  const before = await waitForState(
    (candidate) => candidate.open === true && candidate.surface.exists === true,
    8000
  )
  assertProbe(before.ok, `${label}: preview surface exists before stale destroy`, before.last)
  await smokeCommand('apply-native-preview-host-commands', {
    commands: [{ kind: 'destroy' }],
    generation: currentGeneration - 1
  })
  const after = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.surface.exists === true &&
      supervisorGeneration(candidate) === currentGeneration,
    2000
  )
  assertProbe(after.ok, `${label}: current surface survived old generation destroy`, after.last)
}

async function assertPermissionRequiredStopsSurface(label) {
  const currentGeneration = lastSupervisorGeneration
  const before = await smokeCommand('preview-window-state')
  assertProbe(
    before.open === true && before.contentBounds,
    `${label}: preview is open before permission report`,
    before
  )
  const permission = await smokeCommand('preview-window-report-permission-required', {
    permissionStatus: 'screen-recording-required',
    message: 'Screen Recording permission is required for this source.',
    generation: currentGeneration
  })
  assertProbe(
    permission.supervisor?.lifecycleState === 'permission-required',
    `${label}: supervisor reports permission-required`,
    permission
  )
  assertProbe(
    permission.supervisor?.permissionStatus === 'screen-recording-required',
    `${label}: supervisor reports the screen-recording permission target`,
    permission
  )

  const blocked = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.supervisor?.lifecycleState === 'permission-required' &&
      candidate.supervisor?.surfaceRequested === false &&
      candidate.supervisor?.surfaceActive === false &&
      candidate.supervisor?.permissionStatus === 'screen-recording-required' &&
      candidate.surface.exists === false &&
      candidate.framePollingSuppressedFlag === true,
    8000
  )
  assertProbe(
    blocked.ok,
    `${label}: surface is torn down and frame polling is suppressed`,
    blocked.last
  )

  await smokeCommand('apply-native-preview-host-commands', {
    commands: [{ kind: 'create', bounds: previewSurfaceBoundsFromState(blocked.last) }],
    generation: currentGeneration
  })
  const afterReviveAttempt = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.supervisor?.lifecycleState === 'permission-required' &&
      candidate.surface.exists === false &&
      candidate.framePollingSuppressedFlag === true,
    2000
  )
  assertProbe(
    afterReviveAttempt.ok,
    `${label}: same-generation create is ignored while permission is required`,
    afterReviveAttempt.last
  )
}

async function ensureClosed(label) {
  const state = await smokeCommand('preview-window-state')
  lastSupervisorGeneration = supervisorGeneration(state)
  if (!state.open) {
    return waitUntilClosed(label)
  }
  await smokeCommand('preview-window-close')
  return waitUntilClosed(label)
}

async function waitUntilClosed(label) {
  const state = await waitForState(
    (candidate) =>
      candidate.open === false &&
      candidate.surface.exists === false &&
      candidate.supervisor?.lifecycleState === 'closed' &&
      candidate.supervisor?.windowOpen === false &&
      candidate.supervisor?.surfaceRequested === false &&
      candidate.supervisor?.surfaceActive === false &&
      candidate.framePollingSuppressedFlag === true,
    8000
  )
  assertProbe(state.ok, label, state.last)
  assertProbe(
    supervisorGeneration(state.last) === lastSupervisorGeneration,
    `${label}: supervisor generation stayed on the closed lifecycle`,
    { expected: lastSupervisorGeneration, state: state.last }
  )
  return state.last
}

async function waitForState(predicate, timeoutMsLocal) {
  const deadline = Date.now() + timeoutMsLocal
  do {
    lastState = await smokeCommand('preview-window-state')
    if (predicate(lastState)) {
      return { ok: true, last: lastState }
    }
    await sleep(150)
  } while (Date.now() < deadline)
  return { ok: false, last: lastState }
}

async function smokeCommand(command, params = {}) {
  return requestSmokeCommandWithRetry(smoke, command, params)
}

function assertProbe(condition, label, detail) {
  if (!condition) {
    throw new Error(`${label}: ${JSON.stringify(detail)}`)
  }
}

function supervisorGeneration(state) {
  const generation = state?.supervisor?.generation
  assertProbe(Number.isInteger(generation), 'preview state includes a supervisor generation', state)
  return generation
}

function previewSurfaceBoundsFromState(state) {
  const contentBounds = state?.contentBounds
  assertProbe(contentBounds, 'preview state includes content bounds', state)
  return {
    screenX: contentBounds.x,
    screenY: contentBounds.y,
    width: contentBounds.width,
    height: contentBounds.height,
    scaleFactor: state.scaleFactor,
    screenHeight: state.screenHeight,
    visible: true
  }
}

function positiveInteger(raw, fallback) {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function expectedMemoryCheckpointCount(cycleCount) {
  const checkpointCycles = new Set([1, cycleCount])
  for (let cycle = 10; cycle <= cycleCount; cycle += 10) {
    checkpointCycles.add(cycle)
  }
  // One checkpoint before the cycle loop, one after it, and the selected cycle
  // checkpoints mirrored by main().
  return checkpointCycles.size + 2
}

async function captureMemoryCheckpoint(label) {
  const census = await collectProcessCensus({
    ledgerPaths,
    pgid: launched?.process?.pid
  })
  census.sampledAtMs = Date.now()
  census.checkpoint = label
  memoryCheckpoints.push(census)
}

function lifecycleRoleThresholds(suffix) {
  const mapping = {
    backend: 'BACKEND',
    'electron-main': 'MAIN',
    'electron-renderer': 'RENDERER',
    'electron-gpu': 'GPU',
    'native-preview-helper': 'HELPER'
  }
  return Object.fromEntries(
    Object.entries(mapping)
      .map(([role, envRole]) => [
        role,
        optionalNumber(`VIDEORC_LIFECYCLE_MAX_${envRole}_${suffix}`)
      ])
      .filter(([, value]) => Number.isFinite(value))
  )
}

function optionalNumber(name) {
  if (!(name in process.env)) return undefined
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
