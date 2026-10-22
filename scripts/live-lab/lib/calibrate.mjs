// Plan 178 U15 step 1 (plan 166 S10): propose gate thresholds from report-only
// runs.
//
// Reads every run folder's verdict.json, keeps the runs that finished without
// a failure (outcome pass or warn) while thresholds were report-only, and per
// calibrated signal takes the p95 (p5 for a lower bound) of the values those
// runs measured, plus a margin. The result is thresholds v1 with the proposed
// numbers, `version: 2` and `mode: "gate"`. The owner reviews it in one PR.
//
// Never gates early: with fewer than MIN_DAYS distinct days of usable runs
// nothing is proposed (plan 178 STOP condition). A signal with fewer than
// MIN_SAMPLES values keeps its v1 number and is listed as insufficient.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MIN_DAYS = 14
export const MIN_SAMPLES = 10

// Each rule maps a verdict signal (by id or id prefix) to the threshold path
// it calibrates. `bound: 'upper'` limits from above (p95 + margin); `lower`
// limits from below (p5 - margin). `floor` is the smallest absolute margin, so
// a perfectly flat signal does not get a limit equal to its own value.
export const CALIBRATION_RULES = Object.freeze([
  {
    match: (id) => id.startsWith('leak:'),
    path: (id) => ['leak', 'mbPerHourByRole', id.slice('leak:'.length)],
    bound: 'upper',
    ratio: 1.5,
    floor: 5
  },
  {
    match: (id) => id === 'memory:owned-rss',
    path: () => ['memory', 'maxOwnedRssGb'],
    bound: 'upper',
    ratio: 1.25,
    floor: 0.25
  },
  {
    match: (id) => id === 'stream:dropped-frames',
    path: () => ['droppedFrames', 'maxPercent'],
    bound: 'upper',
    ratio: 1.5,
    floor: 0.1
  },
  {
    match: (id) => id === 'stream:encoder-speed',
    path: () => ['encoderSpeed', 'min'],
    bound: 'lower',
    ratio: 0.98,
    floor: 0.01,
    max: 1
  },
  {
    match: (id) => id === 'stream:start-latency',
    path: () => ['startLatency', 'maxMs'],
    bound: 'upper',
    ratio: 1.25,
    floor: 1000
  },
  {
    match: (id) => id === 'chat:latency',
    path: () => ['chat', 'maxArrivalMs'],
    bound: 'upper',
    ratio: 1.25,
    floor: 1000
  }
])

/** Pure: the q-quantile (0..1) of numbers, nearest-rank. */
export function quantile(values, q) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[rank]
}

function roundTo(value, step) {
  const digits = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)))
  return Number(value.toFixed(digits))
}

/** Pure: the proposed limit for one rule from its samples. */
export function proposeLimit(rule, samples) {
  if (rule.bound === 'upper') {
    const p95 = quantile(samples, 0.95)
    if (p95 === null) return null
    const limit = Math.max(p95 * rule.ratio, p95 + rule.floor)
    return { stat: 'p95', statValue: p95, limit: roundTo(limit, rule.floor) }
  }
  const p5 = quantile(samples, 0.05)
  if (p5 === null) return null
  let limit = Math.min(p5 * rule.ratio, p5 - rule.floor)
  if (Number.isFinite(rule.max)) limit = Math.min(limit, rule.max)
  return { stat: 'p5', statValue: p5, limit: roundTo(limit, rule.floor) }
}

function getPath(object, path) {
  return path.reduce((node, key) => (node == null ? undefined : node[key]), object)
}

function setPath(object, path, value) {
  let node = object
  for (const key of path.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {}
    node = node[key]
  }
  node[path.at(-1)] = value
}

/** Pure: whether a verdict counts as calibration data. */
export function usableVerdict(verdict) {
  return (
    verdict?.schema === 1 &&
    (verdict.thresholdsMode ?? 'report') === 'report' &&
    (verdict.outcome === 'pass' || verdict.outcome === 'warn') &&
    Array.isArray(verdict.signals)
  )
}

function verdictDay(verdict) {
  const at = Date.parse(verdict.endedAt ?? verdict.startedAt ?? '')
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null
}

/**
 * Pure: thresholds v2 proposed from verdicts. Returns { ok, reason?, days,
 * runs, thresholds?, changes[] }. `ok: false` means nothing may be written.
 */
export function calibrate(verdicts, thresholdsV1, { now = new Date() } = {}) {
  const usable = verdicts.filter(usableVerdict)
  const days = new Set(usable.map(verdictDay).filter(Boolean))
  const base = { days: days.size, runs: usable.length, changes: [] }
  if (days.size < MIN_DAYS) {
    return {
      ...base,
      ok: false,
      reason: `${days.size} day(s) of usable report-only runs, need ${MIN_DAYS}`
    }
  }
  const samples = new Map()
  for (const verdict of usable) {
    for (const signal of verdict.signals) {
      if (signal?.status === 'skipped' || !Number.isFinite(signal?.value)) continue
      const rule = CALIBRATION_RULES.find((entry) => entry.match(String(signal.id)))
      if (!rule) continue
      const path = rule.path(String(signal.id))
      const key = path.join('.')
      if (!samples.has(key)) samples.set(key, { rule, path, values: [] })
      samples.get(key).values.push(signal.value)
    }
  }
  const thresholds = structuredClone(thresholdsV1)
  const changes = []
  for (const [key, { rule, path, values }] of [...samples].sort(([a], [b]) => a.localeCompare(b))) {
    const previous = getPath(thresholdsV1, path)
    if (values.length < MIN_SAMPLES) {
      changes.push({
        key,
        previous,
        proposed: previous,
        samples: values.length,
        insufficient: true
      })
      continue
    }
    const proposal = proposeLimit(rule, values)
    setPath(thresholds, path, proposal.limit)
    const looser =
      Number.isFinite(previous) &&
      (rule.bound === 'upper' ? proposal.limit > previous : proposal.limit < previous)
    changes.push({
      key,
      previous,
      proposed: proposal.limit,
      samples: values.length,
      stat: proposal.stat,
      statValue: proposal.statValue,
      looser
    })
  }
  thresholds.version = 2
  thresholds.mode = 'gate'
  thresholds.about =
    'Plan 178 U15: proposed by scripts/live-lab/calibrate.mjs from report-only runs. Gate mode: a breach fails the run. Reviewed by the owner in one PR.'
  thresholds.calibration = {
    calibratedAt: now.toISOString(),
    days: days.size,
    runs: usable.length,
    rule: 'upper bounds p95 x ratio (min p95 + floor); lower bounds p5 x ratio (max p5 - floor)'
  }
  return { ...base, ok: true, thresholds, changes }
}

/** Pure: a markdown table of the proposal, for the owner's review PR. */
export function formatCalibration(result) {
  const lines = [`Calibration from ${result.runs} run(s) over ${result.days} day(s).`, '']
  if (!result.ok) {
    lines.push(`Nothing proposed: ${result.reason}.`)
    return lines.join('\n')
  }
  lines.push('| Threshold | v1 | Proposed | Samples | Basis |', '| --- | --- | --- | --- | --- |')
  for (const change of result.changes) {
    const basis = change.insufficient
      ? `kept: under ${MIN_SAMPLES} samples`
      : `${change.stat} ${change.statValue}${change.looser ? ' (looser than v1)' : ''}`
    lines.push(
      `| \`${change.key}\` | ${change.previous ?? '-'} | ${change.proposed ?? '-'} | ${change.samples} | ${basis} |`
    )
  }
  return lines.join('\n')
}

/** Reads verdict.json from every folder under `runsDir`; unreadable ones are skipped. */
export async function readVerdicts(runsDir) {
  let names
  try {
    names = await readdir(runsDir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const verdicts = []
  for (const name of names.sort()) {
    try {
      verdicts.push(JSON.parse(await readFile(join(runsDir, name, 'verdict.json'), 'utf8')))
    } catch {
      // No verdict yet, or not a run folder.
    }
  }
  return verdicts
}
