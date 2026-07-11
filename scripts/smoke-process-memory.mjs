import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, performanceAppSpawnSpec, repoRoot } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  observationCheck,
  passingCheck,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import {
  collectProcessCensus,
  collectProcessResourceDetails,
  formatCensus,
  ownedProcessLedgerPaths,
  pruneDeadOwnedProcessRecords,
  waitForCleanProcessState,
  waitForNoLiveProcessState
} from './lib/process-census.mjs'
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

const mode = performanceMode()
const timeoutMs = numberFromEnv('VIDEORC_SMOKE_TIMEOUT_MS', 120000)
const warmupMs = numberFromEnv('VIDEORC_PROCESS_MEMORY_WARMUP_MS', 2000)
const sampleMs = numberFromEnv('VIDEORC_PROCESS_MEMORY_SAMPLE_MS', 5000)
const intervalMs = numberFromEnv('VIDEORC_PROCESS_MEMORY_INTERVAL_MS', 1000)
const samplingInvariants = performanceSamplingInvariants(sampleMs, intervalMs)
const tailWindowMs = numberFromEnv(
  'VIDEORC_PROCESS_MEMORY_TAIL_WINDOW_MS',
  Math.min(120000, Math.max(intervalMs, sampleMs / 3))
)
const thresholds = {
  minSamples: numberFromEnv('VIDEORC_PROCESS_MEMORY_MIN_SAMPLES', samplingInvariants.minSamples),
  minDurationMs: numberFromEnv(
    'VIDEORC_PROCESS_MEMORY_MIN_DURATION_MS',
    samplingInvariants.minDurationMs
  ),
  maxTotalRssMb: numberFromEnv('VIDEORC_PROCESS_MEMORY_MAX_TOTAL_MB', 4096),
  maxOwnedRssMb: numberFromEnv('VIDEORC_PROCESS_MEMORY_MAX_OWNED_MB', 1024),
  maxTotalSlopeMbPerMinute: optionalNumber('VIDEORC_PROCESS_MEMORY_MAX_TOTAL_SLOPE_MB_MIN'),
  maxOwnedSlopeMbPerMinute: optionalNumber('VIDEORC_PROCESS_MEMORY_MAX_OWNED_SLOPE_MB_MIN'),
  maxOwnedSecondHalfSlopeMbPerMinute: optionalNumber(
    'VIDEORC_PROCESS_MEMORY_MAX_OWNED_SECOND_HALF_SLOPE_MB_MIN'
  ),
  maxOwnedPlateauGrowthMb: optionalNumber('VIDEORC_PROCESS_MEMORY_MAX_OWNED_PLATEAU_GROWTH_MB'),
  maxRoleRssMb: {
    backend: numberFromEnv('VIDEORC_PROCESS_MEMORY_MAX_BACKEND_MB', 512),
    'native-preview-helper': numberFromEnv('VIDEORC_PROCESS_MEMORY_MAX_HELPER_MB', 512)
  },
  maxRoleCount: {
    backend: numberFromEnv('VIDEORC_PROCESS_MEMORY_MAX_BACKEND_COUNT', 1),
    'native-preview-helper': numberFromEnv('VIDEORC_PROCESS_MEMORY_MAX_HELPER_COUNT', 1)
  },
  minRoleCount: {
    backend: 1,
    'electron-main': 1
  },
  maxRoleSlopeMbPerMinute: roleThresholds('SLOPE_MB_MIN'),
  maxRoleSecondHalfSlopeMbPerMinute: roleThresholds('SECOND_HALF_SLOPE_MB_MIN'),
  maxRolePlateauGrowthMb: roleThresholds('PLATEAU_GROWTH_MB')
}

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-process-memory-'))
const appDataDir = join(stateRoot, 'app-data')
const userDataDir = join(stateRoot, 'user-data')
const ledgerPaths = ownedProcessLedgerPaths({
  appDataDir,
  userDataDir,
  workspaceRoot: repoRoot
})

let launched
let summary = null
let samplingEvidence = null
let resourceCheckpoints = null
let budgetFailures = []
let runError = null
let teardownError = null
let teardownClean = false
let teardownRecovery = null

try {
  launched = await launchDevApp({
    spawnSpec: performanceAppSpawnSpec(),
    env: {
      VIDEORC_APP_DATA_DIR: appDataDir,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (/Reaping|Backend exited|Native preview host helper|error|panic/i.test(line)) {
        console.log(line)
      }
    }
  })

  if (warmupMs > 0) {
    console.log(`Process memory warm-up: ${warmupMs}ms`)
    await sleep(warmupMs)
  }
  const firstResourceCensus = await collectProcessCensus({
    ledgerPaths,
    pgid: launched.process.pid
  })
  resourceCheckpoints = {
    first: await collectProcessResourceDetails(firstResourceCensus),
    last: null
  }
  const scheduledSamples = await collectSamples()
  const samples = scheduledSamples.samples
  samplingEvidence = scheduledSamples.evidence
  const lastResourceCensus = await collectProcessCensus({
    ledgerPaths,
    pgid: launched.process.pid
  })
  resourceCheckpoints.last = await collectProcessResourceDetails(lastResourceCensus)
  summary = summarizeProcessMemory(samples, { tailWindowMs })
  budgetFailures = evaluateProcessMemoryGate(summary, thresholds)

  console.log('\n=== process memory summary ===')
  console.log(formatProcessMemorySummary(summary))
} catch (error) {
  runError = error
} finally {
  try {
    if (launched) {
      const smoke = launched.connections['preview-motion-ready']
      if (smoke) {
        await requestSmokeCommand(smoke, 'app-quit', {}, { timeoutMs: 2000 }).catch(() => undefined)
        // Let Electron's before-quit path stop the backend and clear both
        // ledgers before the launcher sends a process-group fallback signal.
        await waitForNoLiveProcessState({
          ledgerPaths,
          pgid: launched.process.pid,
          timeoutMs: 10000
        }).catch(() => undefined)
      }
      await launched.stop()
    }

    const stopped = await waitForNoLiveProcessState({
      ledgerPaths,
      pgid: launched?.process?.pid,
      timeoutMs: 10000
    })
    const clean = await waitForCleanProcessState({
      ledgerPaths,
      pgid: launched?.process?.pid,
      timeoutMs: 1000
    })
    teardownClean = clean.records.length === 0 && clean.processGroupRows.length === 0
    if (process.env.VIDEORC_PROCESS_MEMORY_PRINT_TEARDOWN === '1') {
      console.log('\n=== teardown process census ===')
      console.log(formatCensus(stopped))
      console.log('\n=== clean process census ===')
      console.log(formatCensus(clean))
    }
  } catch (error) {
    teardownError = error
    try {
      teardownRecovery = await pruneDeadOwnedProcessRecords({ ledgerPaths })
    } catch (cleanupError) {
      teardownRecovery = { error: cleanupError?.message ?? String(cleanupError) }
    }
  }
}

const hardFailures = [
  ...(runError ? [runError.message] : []),
  ...(teardownError ? [teardownError.message] : []),
  ...performanceSamplingEvidenceFailures(samplingEvidence, sampleMs, intervalMs),
  ...(!teardownClean ? ['app-owned process teardown was not clean'] : [])
]
const enforcedBudgetFailures = mode === 'gate' ? budgetFailures : []
const checks = [
  ...(summary ? [passingCheck(`${summary.samples} process-memory samples collected`)] : []),
  ...(teardownClean ? [passingCheck('app-owned process teardown was clean')] : []),
  ...failingChecks(hardFailures),
  ...failingChecks(enforcedBudgetFailures),
  ...(mode === 'report-only'
    ? budgetFailures.map((failure) => observationCheck(`report-only observation: ${failure}`))
    : [])
]
const report = createPerformanceReport({
  scenario: process.env.VIDEORC_PERF_SCENARIO ?? 'ui-idle-process-memory',
  mode,
  metadata: await collectPerformanceMetadata({
    cwd: repoRoot,
    env: { ...process.env, VIDEORC_PERF_APP_ROLE: process.env.VIDEORC_PERF_APP_ROLE ?? 'ui-idle' }
  }),
  timing: { warmupMs, measurementMs: sampleMs, intervalMs, tailWindowMs },
  metrics: {
    memory: summary,
    sampling: samplingEvidence,
    resourceCheckpoints,
    thresholds,
    budgetFailures,
    teardownRecovery,
    stateRoot
  },
  checks
})
const reportPath = await writePerformanceReport(report)
console.log(`Process memory report: ${reportPath}`)

const failed = hardFailures.length > 0 || enforcedBudgetFailures.length > 0
if (!failed && process.env.VIDEORC_PERF_RETAIN_ARTIFACTS !== '1') {
  await rm(stateRoot, { recursive: true, force: true })
} else {
  console.log(`Process memory scratch retained: ${stateRoot}`)
}

if (failed) {
  throw new Error(
    `Process memory gate failed:\n${[...hardFailures, ...enforcedBudgetFailures].join('\n')}`
  )
}

console.log(
  `Process memory smoke OK (${mode}) - process tree RSS stayed inside the enforced contract.`
)

async function collectSamples() {
  const scheduledSamples = await collectPerformanceSamplesOnSchedule({
    measurementMs: sampleMs,
    intervalMs,
    collectSample: async () =>
      collectProcessCensus({
        ledgerPaths,
        pgid: launched.process.pid
      })
  })
  for (const [index, census] of scheduledSamples.samples.entries()) {
    const timing = scheduledSamples.sampleTimings[index]
    census.sampledAtMs = timing.observedAtMs
    census.scheduledAtMs = timing.scheduledAtMs
  }
  return {
    samples: scheduledSamples.samples,
    evidence: {
      ...scheduledSamples.evidence,
      observations: scheduledSamples.sampleTimings
    }
  }
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
      .map(([role, envRole]) => [
        role,
        optionalNumber(`VIDEORC_PROCESS_MEMORY_MAX_${envRole}_${suffix}`)
      ])
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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
