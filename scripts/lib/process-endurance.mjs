import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  classifyProcess,
  collectProcessCensus,
  collectProcessResourceDetails,
  collectStableProcessResourceCheckpoint,
  compareProcessResourceCheckpoints,
  processTreeRows,
  readSystemProcessTable
} from './process-census.mjs'
import { summarizeProcessMemory } from './process-memory-gate.mjs'
import {
  collectPerformanceSamplesOnSchedule,
  monotonicNowMs,
  performanceSamplingEvidenceFailures
} from './performance-sampling-schedule.mjs'

const execFileAsync = promisify(execFile)
const REQUIRED_RESOURCE_METRICS = ['physicalFootprintBytes', 'openFileCount']

export async function collectProcessEndurance({
  ledgerPaths,
  pgid,
  warmupMs,
  measurementMs,
  intervalMs,
  tailWindowMs = Math.min(120_000, Math.max(intervalMs, measurementMs / 3)),
  collectCensus = collectProcessCensus,
  collectResources = collectProcessResourceDetails,
  collectCpu = sampleProcessGroupCpu,
  resourceCheckpointAttempts = 8,
  resourceCheckpointSettleMs = 50,
  now = monotonicNowMs,
  sleep = sleepMs
}) {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(`Process endurance requires a valid app process group, got ${pgid}.`)
  }
  if (!Array.isArray(ledgerPaths) || ledgerPaths.length === 0) {
    throw new Error('Process endurance requires the app-owned process ledger paths.')
  }
  if (!Number.isFinite(measurementMs) || measurementMs <= 0) {
    throw new Error(`Process endurance measurement must be positive, got ${measurementMs}.`)
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Process endurance interval must be positive, got ${intervalMs}.`)
  }

  const effectiveWarmupMs = Math.max(0, Number(warmupMs) || 0)
  if (effectiveWarmupMs > 0) await sleep(effectiveWarmupMs)

  const firstStableResourceCheckpoint = await collectStableProcessResourceCheckpoint({
    collectCensus: () => collectCensus({ ledgerPaths, pgid }),
    collectResources,
    maxAttempts: resourceCheckpointAttempts,
    settleMs: resourceCheckpointSettleMs,
    sleepFn: sleep
  })
  const firstResourceCheckpoint = firstStableResourceCheckpoint.checkpoint
  const censuses = []
  const memorySamples = []
  const cpuSamples = []

  const scheduledSamples = await collectPerformanceSamplesOnSchedule({
    measurementMs,
    intervalMs,
    nowMs: now,
    sleep,
    collectSample: async () => {
      const [censusObservation, cpuByRole] = await Promise.all([
        collectCensus({ ledgerPaths, pgid }).then((census) => ({
          census,
          observedAtMs: now()
        })),
        collectCpu(pgid)
      ])
      return { censusObservation, cpuByRole }
    }
  })
  for (const [index, sample] of scheduledSamples.samples.entries()) {
    const timing = scheduledSamples.sampleTimings[index]
    const census = sample.censusObservation.census
    census.sampledAtMs = sample.censusObservation.observedAtMs
    census.scheduledAtMs = timing.scheduledAtMs
    censuses.push(census)
    memorySamples.push(compactProcessMemorySample(census))
    cpuSamples.push({
      sampledAtMs: timing.observedAtMs,
      scheduledAtMs: timing.scheduledAtMs,
      byRole: sample.cpuByRole
    })
  }
  const sampling = {
    ...scheduledSamples.evidence,
    observations: scheduledSamples.sampleTimings
  }
  const measurementStartedAtMs = scheduledSamples.measurementStartedAtMs
  const measurementEndedAtMs = scheduledSamples.measurementEndedAtMs
  const lastStableResourceCheckpoint = await collectStableProcessResourceCheckpoint({
    collectCensus: () => collectCensus({ ledgerPaths, pgid }),
    collectResources,
    maxAttempts: resourceCheckpointAttempts,
    settleMs: resourceCheckpointSettleMs,
    sleepFn: sleep
  })
  const lastResourceCheckpoint = lastStableResourceCheckpoint.checkpoint
  const resourceCheckpoints = {
    first: firstResourceCheckpoint,
    last: lastResourceCheckpoint,
    comparison: compareProcessResourceCheckpoints(firstResourceCheckpoint, lastResourceCheckpoint)
  }

  return {
    timing: {
      warmupMs: effectiveWarmupMs,
      requestedMeasurementMs: measurementMs,
      measuredDurationMs: Math.max(0, measurementEndedAtMs - measurementStartedAtMs),
      intervalMs,
      tailWindowMs,
      measurementStartedAtMs,
      measurementEndedAtMs
    },
    sampling,
    memory: {
      samples: memorySamples,
      summary: summarizeProcessMemory(censuses, { tailWindowMs })
    },
    cpu: {
      samples: cpuSamples,
      summary: summarizeProcessCpu(cpuSamples)
    },
    resourceCheckpoints
  }
}

export function compactProcessMemorySample(census) {
  const ownedPids = new Set((census?.aliveRecords ?? []).map((record) => record.pid))
  let totalRssKb = 0
  let ownedRssKb = 0
  for (const row of census?.processRows ?? []) {
    totalRssKb += finiteNumber(row.rssKb)
    if (ownedPids.has(row.pid)) ownedRssKb += finiteNumber(row.rssKb)
  }
  return {
    sampledAtMs: finiteNumberOrNull(census?.sampledAtMs),
    scheduledAtMs: finiteNumberOrNull(census?.scheduledAtMs),
    totalRssKb,
    ownedRssKb,
    aliveOwnedProcessCount: census?.aliveRecords?.length ?? 0,
    deadOwnedProcessCount: census?.deadRecords?.length ?? 0,
    processGroupCount: census?.processGroupRows?.length ?? 0,
    byRole: census?.summary ?? {}
  }
}

export async function sampleProcessGroupCpu(
  pgid,
  { exec = execFileAsync, platform = process.platform } = {}
) {
  if (platform !== 'darwin') return {}
  const { stdout } = await exec('ps', ['-axo', 'pid=,pgid=,pcpu=,rss=,comm=,args='])
  return parseProcessGroupCpu(stdout, pgid)
}

/**
 * Windows has no app-scoped equivalent to a POSIX process group.  Sample the
 * packaged Electron launcher and every live descendant, then calculate CPU
 * from the cumulative kernel/user times returned by Win32_Process.  Keeping
 * the previous sample in this closure makes the first call a baseline rather
 * than a misleading zero-percent observation.
 */
export function createProcessTreeCpuSampler({
  rootPid,
  platform = process.platform,
  readProcessTable = ({ platform: requestedPlatform } = {}) =>
    readSystemProcessTable({ platform: requestedPlatform }),
  now = monotonicNowMs
} = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    throw new Error(`Process-tree CPU sampling requires a valid root PID, got ${rootPid}.`)
  }

  let previous = null
  return async (sampleRows) => {
    if (platform !== 'win32') return {}

    const observedAtMs = now()
    const rows = Array.isArray(sampleRows)
      ? sampleRows
      : processTreeRows(await readProcessTable({ platform }), rootPid)
    const current = new Map(
      rows
        .filter((row) => Number.isFinite(row.cpuTimeMs))
        .map((row) => [
          row.pid,
          {
            cpuTimeMs: row.cpuTimeMs,
            creationDate: row.creationDate,
            role: classifyProcess(row)
          }
        ])
    )
    const elapsedMs = previous ? observedAtMs - previous.observedAtMs : 0
    const byRole = {}
    if (previous && elapsedMs > 0) {
      for (const [pid, row] of current) {
        const prior = previous.rows.get(pid)
        if (
          !prior ||
          !row.creationDate ||
          row.creationDate !== prior.creationDate ||
          row.cpuTimeMs < prior.cpuTimeMs
        )
          continue
        const percent = ((row.cpuTimeMs - prior.cpuTimeMs) / elapsedMs) * 100
        if (!Number.isFinite(percent)) continue
        byRole[row.role] = (byRole[row.role] ?? 0) + percent
      }
    }
    previous = { observedAtMs, rows: current }
    return byRole
  }
}

/**
 * Lightweight Windows process-tree evidence for performance scenarios.  RSS
 * is sampled from the same tree as CPU.  macOS-only footprint/file-descriptor
 * checkpoints intentionally remain in collectProcessEndurance rather than
 * being represented as bogus Windows values.
 */
export async function collectWindowsProcessTreeTelemetry({
  ledgerPaths = [],
  rootPid,
  warmupMs = 0,
  measurementMs,
  intervalMs,
  tailWindowMs = Math.min(120_000, Math.max(intervalMs, measurementMs / 3)),
  collectCensus = collectProcessCensus,
  collectCpu,
  now = monotonicNowMs,
  sleep = sleepMs
} = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    throw new Error(`Windows process telemetry requires a valid root PID, got ${rootPid}.`)
  }
  if (!Number.isFinite(measurementMs) || measurementMs <= 0) {
    throw new Error(`Windows process telemetry measurement must be positive, got ${measurementMs}.`)
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Windows process telemetry interval must be positive, got ${intervalMs}.`)
  }

  const effectiveWarmupMs = Math.max(0, Number(warmupMs) || 0)
  const cpuSampler = collectCpu ?? createProcessTreeCpuSampler({ rootPid, now })
  if (effectiveWarmupMs > 0) await sleep(effectiveWarmupMs)

  // Establish the CPU-time baseline before the scheduled measurement window.
  const baselineCensus = await collectCensus({ ledgerPaths, rootPid })
  await cpuSampler(baselineCensus.processGroupRows)
  const censuses = []
  const memorySamples = []
  const cpuSamples = []
  const scheduledSamples = await collectPerformanceSamplesOnSchedule({
    measurementMs,
    intervalMs,
    nowMs: now,
    sleep,
    collectSample: async () => {
      const census = await collectCensus({ ledgerPaths, rootPid })
      const cpuByRole = await cpuSampler(census.processGroupRows)
      return { census, cpuByRole, observedAtMs: now() }
    }
  })
  for (const [index, sample] of scheduledSamples.samples.entries()) {
    const timing = scheduledSamples.sampleTimings[index]
    const census = sample.census
    census.sampledAtMs = sample.observedAtMs
    census.scheduledAtMs = timing.scheduledAtMs
    censuses.push(census)
    memorySamples.push(compactProcessMemorySample(census))
    cpuSamples.push({
      sampledAtMs: timing.observedAtMs,
      scheduledAtMs: timing.scheduledAtMs,
      byRole: sample.cpuByRole
    })
  }

  return {
    timing: {
      warmupMs: effectiveWarmupMs,
      requestedMeasurementMs: measurementMs,
      measuredDurationMs: Math.max(
        0,
        scheduledSamples.measurementEndedAtMs - scheduledSamples.measurementStartedAtMs
      ),
      intervalMs,
      tailWindowMs,
      measurementStartedAtMs: scheduledSamples.measurementStartedAtMs,
      measurementEndedAtMs: scheduledSamples.measurementEndedAtMs
    },
    sampling: {
      ...scheduledSamples.evidence,
      observations: scheduledSamples.sampleTimings
    },
    memory: {
      samples: memorySamples,
      summary: summarizeProcessMemory(censuses, { tailWindowMs })
    },
    cpu: {
      samples: cpuSamples,
      summary: summarizeProcessCpu(cpuSamples)
    }
  }
}

export function parseProcessGroupCpu(stdout, pgid) {
  const byRole = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!match || Number(match[2]) !== pgid) continue
    const role = classifyProcess({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      rssKb: Number(match[4]),
      command: match[5],
      args: match[6] ?? ''
    })
    byRole[role] = (byRole[role] ?? 0) + Number(match[3])
  }
  return byRole
}

export function summarizeProcessCpu(samples) {
  const roles = new Set((samples ?? []).flatMap((sample) => Object.keys(sample?.byRole ?? {})))
  const byRole = Object.fromEntries(
    [...roles].sort().map((role) => {
      const values = samples
        .map((sample) => sample?.byRole?.[role])
        .filter((value) => Number.isFinite(value))
      return [
        role,
        {
          samples: values.length,
          averagePercent:
            values.length > 0
              ? values.reduce((total, value) => total + value, 0) / values.length
              : 0,
          p95Percent: percentileNearestRank(values, 0.95),
          maxPercent: values.length > 0 ? Math.max(...values) : 0
        }
      ]
    })
  )
  return { samples: samples?.length ?? 0, byRole }
}

export function evaluateProcessEnduranceEvidence(
  evidence,
  {
    requiredRoles = ['backend', 'electron-main', 'electron-renderer'],
    minimumSamples = 2,
    minimumDurationMs = 0
  } = {}
) {
  const failures = []
  if (!evidence || typeof evidence !== 'object') {
    return ['process endurance evidence was missing']
  }

  const requestedMeasurementMs = evidence.timing?.requestedMeasurementMs
  const intervalMs = evidence.timing?.intervalMs
  if (
    !Number.isFinite(requestedMeasurementMs) ||
    requestedMeasurementMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    failures.push('process endurance sampling timing was missing or invalid')
  } else {
    failures.push(
      ...performanceSamplingEvidenceFailures(evidence.sampling, requestedMeasurementMs, intervalMs)
    )
  }

  const memorySummary = evidence.memory?.summary
  const memorySamples = evidence.memory?.samples
  if (!memorySummary || !Array.isArray(memorySamples)) {
    failures.push('process-memory summary or time series was missing')
  } else {
    if ((memorySummary.samples ?? 0) < minimumSamples || memorySamples.length < minimumSamples) {
      failures.push(
        `process-memory samples were incomplete (${memorySummary.samples ?? 0} summarized, ${memorySamples.length} raw; expected at least ${minimumSamples})`
      )
    }
    if ((memorySummary.totalRss?.durationMs ?? 0) < minimumDurationMs) {
      failures.push(
        `process-memory duration ${memorySummary.totalRss?.durationMs ?? 0}ms was below ${minimumDurationMs}ms`
      )
    }
    if ((memorySummary.totalRss?.samples ?? 0) < minimumSamples) {
      failures.push('total process-tree RSS series was missing or incomplete')
    }
    if ((memorySummary.ownedRss?.samples ?? 0) < minimumSamples) {
      failures.push('app-owned RSS series was missing or incomplete')
    }
    for (const role of requiredRoles) {
      if ((memorySummary.roles?.[role]?.minMeasuredCount ?? 0) < 1) {
        failures.push(`process-memory series did not continuously cover required role ${role}`)
      }
    }
  }

  const cpuSummary = evidence.cpu?.summary
  const cpuSamples = evidence.cpu?.samples
  if (!cpuSummary || !Array.isArray(cpuSamples) || cpuSamples.length < minimumSamples) {
    failures.push('per-role CPU time series was missing or incomplete')
  } else {
    for (const role of requiredRoles) {
      const roleCpu = cpuSummary.byRole?.[role]
      if (
        !roleCpu ||
        roleCpu.samples < minimumSamples ||
        !Number.isFinite(roleCpu.averagePercent) ||
        !Number.isFinite(roleCpu.p95Percent) ||
        !Number.isFinite(roleCpu.maxPercent)
      ) {
        failures.push(`per-role CPU series did not continuously cover required role ${role}`)
      }
    }
  }

  const comparison = evidence.resourceCheckpoints?.comparison
  if (!comparison?.processContinuity?.comparable) {
    failures.push('resource checkpoints did not preserve exact process/role continuity')
  }
  for (const metric of REQUIRED_RESOURCE_METRICS) {
    const metricComparison = comparison?.metrics?.[metric]
    if (!metricComparison?.comparable) {
      const reasons = metricComparison?.reasons?.join('; ') || 'missing comparison'
      failures.push(`${metric} checkpoints were not comparable: ${reasons}`)
    }
  }

  return failures
}

export function evaluateOwnedTeardown(teardown) {
  const failures = []
  if (!teardown || typeof teardown !== 'object') return ['app-owned teardown evidence was missing']
  if (teardown.clean !== true) failures.push('app-owned process teardown was not clean')
  if (teardown.gracefulQuitError) {
    failures.push(`app-owned graceful quit failed: ${teardown.gracefulQuitError}`)
  }
  if (teardown.stopResult && teardown.stopResult.state !== 'skipped') {
    failures.push('app-owned teardown required forced process termination')
  }
  if ((teardown.finalCensus?.records?.length ?? 0) !== 0) {
    failures.push('app-owned process ledger was not empty after teardown')
  }
  if ((teardown.finalCensus?.processGroupRows?.length ?? 0) !== 0) {
    failures.push('app process group was not empty after teardown')
  }
  if (teardown.error) failures.push(`app-owned teardown failed: ${teardown.error}`)
  return failures
}

export function performanceEnduranceMetrics({ evidence, teardown, pipeline, thresholds = {} }) {
  return {
    teardownClean: evaluateOwnedTeardown(teardown).length === 0,
    pipeline: pipeline ?? null,
    memory: evidence?.memory?.summary ?? null,
    memorySamples: evidence?.memory?.samples ?? null,
    sampling: evidence?.sampling ?? null,
    cpuAveragePercentByRole: Object.fromEntries(
      Object.entries(evidence?.cpu?.summary?.byRole ?? {}).map(([role, summary]) => [
        role,
        summary.averagePercent
      ])
    ),
    cpuP95PercentByRole: Object.fromEntries(
      Object.entries(evidence?.cpu?.summary?.byRole ?? {}).map(([role, summary]) => [
        role,
        summary.p95Percent
      ])
    ),
    cpu: evidence?.cpu ?? null,
    resourceCheckpoints: evidence?.resourceCheckpoints ?? null,
    thresholds,
    processEndurance: evidence ?? null,
    teardown: teardown ?? null
  }
}

function sleepMs(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function percentileNearestRank(values, percentile) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return sorted[index]
}
