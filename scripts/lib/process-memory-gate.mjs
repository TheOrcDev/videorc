import { summarizeNumericSeries } from './performance-contract.mjs'

const REQUIRED_TREND_ROLES = ['backend', 'electron-main', 'electron-renderer']

export function requiredProcessMemoryTrendThresholdFailures(
  thresholds,
  { roles = REQUIRED_TREND_ROLES } = {}
) {
  const failures = []
  requireTrendThreshold(failures, 'owned process RSS slope', thresholds?.maxOwnedSlopeMbPerMinute)
  requireTrendThreshold(
    failures,
    'owned process RSS second-half slope',
    thresholds?.maxOwnedSecondHalfSlopeMbPerMinute
  )
  requireTrendThreshold(
    failures,
    'owned process RSS plateau growth',
    thresholds?.maxOwnedPlateauGrowthMb
  )
  for (const role of roles) {
    requireTrendThreshold(
      failures,
      `${role} RSS slope`,
      thresholds?.maxRoleSlopeMbPerMinute?.[role]
    )
    requireTrendThreshold(
      failures,
      `${role} RSS second-half slope`,
      thresholds?.maxRoleSecondHalfSlopeMbPerMinute?.[role]
    )
    requireTrendThreshold(
      failures,
      `${role} RSS plateau growth`,
      thresholds?.maxRolePlateauGrowthMb?.[role]
    )
  }
  return failures
}

export function summarizeProcessMemory(censuses, { warmupMs = 0, tailWindowMs = 120000 } = {}) {
  const summary = {
    samples: censuses.length,
    maxTotalRssKb: 0,
    maxOwnedRssKb: 0,
    totalRss: null,
    ownedRss: null,
    roles: {}
  }

  const totalRssSamples = []
  const ownedRssSamples = []
  const roleNames = new Set()
  const prepared = []

  for (const [index, census] of censuses.entries()) {
    const ownedPids = new Set(census.aliveRecords.map((record) => record.pid))
    const roleTotals = {}
    let totalRssKb = 0
    let ownedRssKb = 0

    for (const row of census.processRows) {
      const rssKb = finiteNumber(row.rssKb)
      totalRssKb += rssKb
      if (ownedPids.has(row.pid)) {
        ownedRssKb += rssKb
      }

      const role = row.role ?? 'other'
      roleNames.add(role)
      const roleTotal = (roleTotals[role] ??= { count: 0, rssKb: 0 })
      roleTotal.count += 1
      roleTotal.rssKb += rssKb
    }

    const atMs = finiteTimestamp(census.sampledAtMs, index)
    prepared.push({ atMs, roleTotals })
    totalRssSamples.push({ atMs, value: totalRssKb })
    ownedRssSamples.push({ atMs, value: ownedRssKb })

    summary.maxTotalRssKb = Math.max(summary.maxTotalRssKb, totalRssKb)
    summary.maxOwnedRssKb = Math.max(summary.maxOwnedRssKb, ownedRssKb)
    for (const [role, total] of Object.entries(roleTotals)) {
      const entry = (summary.roles[role] ??= { maxCount: 0, maxRssKb: 0 })
      entry.maxCount = Math.max(entry.maxCount, total.count)
      entry.maxRssKb = Math.max(entry.maxRssKb, total.rssKb)
    }
  }

  summary.totalRss = summarizeNumericSeries(totalRssSamples, { warmupMs, tailWindowMs })
  summary.ownedRss = summarizeNumericSeries(ownedRssSamples, { warmupMs, tailWindowMs })
  for (const role of roleNames) {
    const entry = summary.roles[role]
    const rss = summarizeNumericSeries(
      prepared.map((sample) => ({
        atMs: sample.atMs,
        value: sample.roleTotals[role]?.rssKb ?? 0
      })),
      { warmupMs, tailWindowMs }
    )
    const count = summarizeNumericSeries(
      prepared.map((sample) => ({
        atMs: sample.atMs,
        value: sample.roleTotals[role]?.count ?? 0
      })),
      { warmupMs, tailWindowMs }
    )
    Object.assign(entry, {
      firstMedianRssKb: rss.firstMedian,
      lastMedianRssKb: rss.lastMedian,
      plateauGrowthRssKb: rss.plateauGrowth,
      slopeRssKbPerMinute: rss.slopePerMinute,
      secondHalfSlopeRssKbPerMinute: rss.secondHalfSlopePerMinute,
      rssSamples: rss.samples,
      minMeasuredCount: count.min,
      maxMeasuredCount: count.max
    })
  }

  return summary
}

export function evaluateProcessMemoryGate(summary, thresholds = {}) {
  const failures = []
  addLimitFailure(
    failures,
    'total process tree RSS',
    summary.maxTotalRssKb,
    thresholds.maxTotalRssMb
  )
  addLimitFailure(failures, 'owned process RSS', summary.maxOwnedRssKb, thresholds.maxOwnedRssMb)

  addRateFailure(
    failures,
    'total process tree RSS slope',
    summary.totalRss?.slopePerMinute,
    thresholds.maxTotalSlopeMbPerMinute
  )
  addRateFailure(
    failures,
    'owned process RSS slope',
    summary.ownedRss?.slopePerMinute,
    thresholds.maxOwnedSlopeMbPerMinute
  )
  addRateFailure(
    failures,
    'owned process RSS second-half slope',
    summary.ownedRss?.secondHalfSlopePerMinute,
    thresholds.maxOwnedSecondHalfSlopeMbPerMinute
  )
  addGrowthFailure(
    failures,
    'owned process RSS plateau growth',
    summary.ownedRss?.plateauGrowth,
    thresholds.maxOwnedPlateauGrowthMb
  )

  for (const [role, maxRssMb] of Object.entries(thresholds.maxRoleRssMb ?? {})) {
    addLimitFailure(failures, `${role} RSS`, summary.roles[role]?.maxRssKb ?? 0, maxRssMb)
  }
  for (const [role, maxCount] of Object.entries(thresholds.maxRoleCount ?? {})) {
    const actual = summary.roles[role]?.maxCount ?? 0
    if (Number.isFinite(maxCount) && actual > maxCount) {
      failures.push(`${role} process count ${actual} exceeded ${maxCount}`)
    }
  }
  for (const [role, minCount] of Object.entries(thresholds.minRoleCount ?? {})) {
    const actual = summary.roles[role]?.minMeasuredCount ?? 0
    if (Number.isFinite(minCount) && actual < minCount) {
      failures.push(`${role} minimum process count ${actual} was below ${minCount}`)
    }
  }
  for (const [role, maxSlope] of Object.entries(thresholds.maxRoleSlopeMbPerMinute ?? {})) {
    addRateFailure(
      failures,
      `${role} RSS slope`,
      summary.roles[role]?.slopeRssKbPerMinute,
      maxSlope
    )
  }
  for (const [role, maxSlope] of Object.entries(
    thresholds.maxRoleSecondHalfSlopeMbPerMinute ?? {}
  )) {
    addRateFailure(
      failures,
      `${role} RSS second-half slope`,
      summary.roles[role]?.secondHalfSlopeRssKbPerMinute,
      maxSlope
    )
  }
  for (const [role, maxGrowth] of Object.entries(thresholds.maxRolePlateauGrowthMb ?? {})) {
    addGrowthFailure(
      failures,
      `${role} RSS plateau growth`,
      summary.roles[role]?.plateauGrowthRssKb,
      maxGrowth
    )
  }

  if (Number.isFinite(thresholds.minSamples) && summary.samples < thresholds.minSamples) {
    failures.push(`memory sample count ${summary.samples} was below ${thresholds.minSamples}`)
  }
  if (
    Number.isFinite(thresholds.minDurationMs) &&
    (summary.totalRss?.durationMs ?? 0) < thresholds.minDurationMs
  ) {
    failures.push(
      `memory measurement duration ${summary.totalRss?.durationMs ?? 0}ms was below ${thresholds.minDurationMs}ms`
    )
  }

  return failures
}

export function formatProcessMemorySummary(summary) {
  const lines = [
    `samples: ${summary.samples}`,
    `max total process tree RSS: ${formatMb(summary.maxTotalRssKb)}`,
    `max owned process RSS: ${formatMb(summary.maxOwnedRssKb)}`,
    `owned RSS slope: ${formatRate(summary.ownedRss?.slopePerMinute)}; second-half ${formatRate(summary.ownedRss?.secondHalfSlopePerMinute)}; plateau growth ${formatMb(summary.ownedRss?.plateauGrowth)}`
  ]
  for (const [role, totals] of Object.entries(summary.roles).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(
      `  ${role}: max_count=${totals.maxCount} max_rss=${formatMb(totals.maxRssKb)} slope=${formatRate(totals.slopeRssKbPerMinute)} second_half=${formatRate(totals.secondHalfSlopeRssKbPerMinute)} plateau_growth=${formatMb(totals.plateauGrowthRssKb)}`
    )
  }
  return lines.join('\n')
}

function addLimitFailure(failures, label, actualKb, limitMb) {
  if (!Number.isFinite(limitMb) || limitMb <= 0) {
    return
  }
  const limitKb = limitMb * 1024
  if (actualKb > limitKb) {
    failures.push(`${label} ${formatMb(actualKb)} exceeded ${limitMb}MB`)
  }
}

function requireTrendThreshold(failures, label, value) {
  if (!Number.isFinite(value) || value < 0) {
    failures.push(`${label} threshold was missing or invalid`)
  }
}

function addRateFailure(failures, label, actualKbPerMinute, limitMbPerMinute) {
  if (!Number.isFinite(limitMbPerMinute) || !Number.isFinite(actualKbPerMinute)) {
    return
  }
  const actualMbPerMinute = actualKbPerMinute / 1024
  if (actualMbPerMinute > limitMbPerMinute) {
    failures.push(
      `${label} ${actualMbPerMinute.toFixed(2)}MB/min exceeded ${limitMbPerMinute}MB/min`
    )
  }
}

function addGrowthFailure(failures, label, actualKb, limitMb) {
  if (!Number.isFinite(limitMb) || !Number.isFinite(actualKb)) {
    return
  }
  const actualMb = actualKb / 1024
  if (actualMb > limitMb) {
    failures.push(`${label} ${actualMb.toFixed(2)}MB exceeded ${limitMb}MB`)
  }
}

function formatMb(kb) {
  if (!Number.isFinite(kb)) return 'n/a'
  return `${Math.round(kb / 1024)}MB`
}

function formatRate(kbPerMinute) {
  return Number.isFinite(kbPerMinute) ? `${(kbPerMinute / 1024).toFixed(2)}MB/min` : 'n/a'
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0
}

function finiteTimestamp(value, index) {
  return Number.isFinite(value) ? value : index * 1000
}
