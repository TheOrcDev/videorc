// Pure helpers for the record start/stop latency smoke
// (scripts/smoke-record-latency-app.mjs). Kept free of I/O so `pnpm test:scripts`
// covers the arithmetic and the budget evaluation.

/**
 * Proposed OBS-parity budgets (milliseconds). They stay REPORT-ONLY until a
 * calibration document exists: `calibratedFrom` must name a reviewed
 * docs/acceptance note built from three fresh-process runs on the finished
 * build, with explicit headroom over the observed p95 (never copied maxima).
 * Local investigation may override any value with VIDEORC_RECORD_LATENCY_*.
 */
export const RECORD_LATENCY_BUDGETS = Object.freeze({
  // Click → `recording` on a warm Studio (cycle 2+ in one process).
  warmStartClickToRecordingP95Ms: 350,
  // First start after launch pays one-off costs (chunk loads, device probes).
  coldStartClickToRecordingMs: 1200,
  // Stop click → terminal `idle` (Record enabled again).
  stopClickToIdleP95Ms: 300,
  // Background finalization (MP4 export) for a ~4 s clip.
  finalizationIdleToFinalizedP95Ms: 5000,
  calibratedFrom: null
})

// Same-kind remote intents are debounced per family (remote_control.rs); start
// and stop share the `record` family.
export const REMOTE_RECORD_INTENT_DEBOUNCE_MS = 150

export const RECORD_LATENCY_METRICS = Object.freeze([
  'clickToStartingMs',
  'clickToRecordingMs',
  'clickToAckMs',
  'stopClickToStoppingMs',
  'stopClickToIdleMs',
  'stopClickToAckMs',
  'idleToFinalizedMs'
])

export function percentileNearestRank(values, percentile) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return null
  const sorted = [...finite].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return sorted[Math.min(index, sorted.length - 1)]
}

export function summarizeMetric(values) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return { n: 0, p50: null, p95: null, max: null, min: null }
  return {
    n: finite.length,
    min: Math.min(...finite),
    p50: percentileNearestRank(finite, 0.5),
    p95: percentileNearestRank(finite, 0.95),
    max: Math.max(...finite)
  }
}

/**
 * cycles: [{ cold: boolean, clickToRecordingMs, ... }]
 * Returns { cold: { metric: summary }, warm: { metric: summary } }.
 */
export function summarizeRecordCycles(cycles, metrics = RECORD_LATENCY_METRICS) {
  const buckets = { cold: [], warm: [] }
  for (const cycle of cycles) {
    buckets[cycle.cold ? 'cold' : 'warm'].push(cycle)
  }
  const summarize = (bucket) =>
    Object.fromEntries(
      metrics.map((metric) => [metric, summarizeMetric(bucket.map((cycle) => cycle[metric]))])
    )
  return { cold: summarize(buckets.cold), warm: summarize(buckets.warm) }
}

export function readBudgetOverrides(env = process.env, budgets = RECORD_LATENCY_BUDGETS) {
  const overrides = {}
  const map = {
    warmStartClickToRecordingP95Ms: 'VIDEORC_RECORD_LATENCY_WARM_START_P95_MS',
    coldStartClickToRecordingMs: 'VIDEORC_RECORD_LATENCY_COLD_START_MS',
    stopClickToIdleP95Ms: 'VIDEORC_RECORD_LATENCY_STOP_P95_MS',
    finalizationIdleToFinalizedP95Ms: 'VIDEORC_RECORD_LATENCY_FINALIZATION_P95_MS'
  }
  for (const [key, envName] of Object.entries(map)) {
    const raw = env[envName]
    if (raw === undefined || raw === '') continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${envName} must be a positive number of milliseconds (got ${raw}).`)
    }
    overrides[key] = value
  }
  return { ...budgets, ...overrides }
}

/**
 * Evaluates a cycle summary against the budgets. Missing evidence fails closed
 * only for metrics the smoke is expected to measure on every run.
 */
export function evaluateRecordLatencyBudget(summary, budgets = RECORD_LATENCY_BUDGETS) {
  const failures = []
  const warmStart = summary.warm?.clickToRecordingMs
  if (!warmStart || warmStart.n === 0) {
    failures.push('no warm start samples were measured')
  } else if (warmStart.p95 > budgets.warmStartClickToRecordingP95Ms) {
    failures.push(
      `warm start click→recording p95 ${warmStart.p95}ms exceeds ${budgets.warmStartClickToRecordingP95Ms}ms`
    )
  }
  const coldStart = summary.cold?.clickToRecordingMs
  if (coldStart && coldStart.n > 0 && coldStart.max > budgets.coldStartClickToRecordingMs) {
    failures.push(
      `cold start click→recording ${coldStart.max}ms exceeds ${budgets.coldStartClickToRecordingMs}ms`
    )
  }
  const stopValues = [summary.cold?.stopClickToIdleMs, summary.warm?.stopClickToIdleMs]
    .filter((item) => item && item.n > 0)
    .flatMap((item) => (Number.isFinite(item.p95) ? [item.p95] : []))
  if (stopValues.length === 0) {
    failures.push('no stop samples were measured')
  } else {
    const stopP95 = Math.max(...stopValues)
    if (stopP95 > budgets.stopClickToIdleP95Ms) {
      failures.push(`stop click→idle p95 ${stopP95}ms exceeds ${budgets.stopClickToIdleP95Ms}ms`)
    }
  }
  const finalization = [summary.cold?.idleToFinalizedMs, summary.warm?.idleToFinalizedMs].filter(
    (item) => item && item.n > 0
  )
  for (const item of finalization) {
    if (item.p95 > budgets.finalizationIdleToFinalizedP95Ms) {
      failures.push(
        `finalization idle→finalized p95 ${item.p95}ms exceeds ${budgets.finalizationIdleToFinalizedP95Ms}ms`
      )
      break
    }
  }
  return { pass: failures.length === 0, failures }
}

/**
 * Gap the smoke must leave between two record-family intents so the backend
 * debounce never rejects our own click.
 */
export function nextCycleDelayMs({
  debounceMs = REMOTE_RECORD_INTENT_DEBOUNCE_MS,
  idleGapMs = 1500
} = {}) {
  return Math.max(debounceMs + 50, idleGapMs)
}

/**
 * Parses a `key=value key=value` timeline line (backend
 * `recording-start-timeline` / `recording-stop-timeline` health events) into
 * numbers where the value is `<n>ms` or `+<n>` and strings otherwise.
 */
export function parseTimelineMessage(message) {
  const result = {}
  if (typeof message !== 'string') return result
  for (const token of message.trim().split(/\s+/)) {
    const separator = token.indexOf('=')
    if (separator <= 0) continue
    const key = token.slice(0, separator)
    const raw = token.slice(separator + 1)
    const numeric = raw.match(/^\+?(-?\d+(?:\.\d+)?)(?:ms)?$/)
    if (numeric) {
      result[key] = Number(numeric[1])
    } else if (raw === 'true' || raw === 'false') {
      result[key] = raw === 'true'
    } else {
      result[key] = raw
    }
  }
  return result
}

/**
 * Consecutive deltas between ordered timeline marks: [{phase, atMs}] →
 * [{phase, deltaMs}] where deltaMs is the time spent reaching that mark.
 */
export function timelinePhaseDeltas(marks) {
  if (!Array.isArray(marks)) return []
  const deltas = []
  let previous = 0
  for (const mark of marks) {
    if (!mark || !Number.isFinite(mark.atMs)) continue
    deltas.push({ phase: String(mark.phase), deltaMs: Math.max(0, mark.atMs - previous) })
    previous = mark.atMs
  }
  return deltas
}

export function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : '—'
}

export function formatSummaryTable(summary) {
  const rows = [
    ['metric', 'cold n', 'cold p50', 'cold max', 'warm n', 'warm p50', 'warm p95', 'warm max']
  ]
  for (const metric of RECORD_LATENCY_METRICS) {
    const cold = summary.cold[metric] ?? summarizeMetric([])
    const warm = summary.warm[metric] ?? summarizeMetric([])
    rows.push([
      metric,
      String(cold.n),
      formatMs(cold.p50),
      formatMs(cold.max),
      String(warm.n),
      formatMs(warm.p50),
      formatMs(warm.p95),
      formatMs(warm.max)
    ])
  }
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column]).length))
  )
  return rows
    .map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  '))
    .join('\n')
}
