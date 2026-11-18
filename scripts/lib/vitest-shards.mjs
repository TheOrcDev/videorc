// Plan 242 S7: split the desktop vitest suite into shards that take about the
// same time, from recorded per-file times. Pure helpers shared by the
// sequencer (apps/desktop/vitest/timing-sequencer.ts), the reporter, and
// scripts/vitest-shard-report.mjs. Vitest's own --shard splits by a hash of
// the path into equal file counts, so one slow file can make one shard slow.

/** The desktop suite's test files, relative to apps/desktop. vitest.config.ts uses this. */
export const DESKTOP_VITEST_INCLUDE = Object.freeze([
  'src/main/**/*.test.ts',
  'src/preload/**/*.test.ts',
  'src/renderer/src/**/*.test.ts',
  'src/shared/**/*.test.ts'
])

/** The committed recorded times, relative to apps/desktop. */
export const DESKTOP_VITEST_TIMINGS_FILE = 'vitest-timings.json'

const DEFAULT_WEIGHT_MS = 1000

export function toPosixPath(value) {
  return String(value).replaceAll('\\', '/')
}

/** Recorded times as a plain { path: ms } map; anything malformed reads as empty. */
export function readTimings(json) {
  const files = json && typeof json === 'object' ? json.files : null
  if (!files || typeof files !== 'object') return {}
  const out = {}
  for (const [path, ms] of Object.entries(files)) {
    if (Number.isFinite(ms) && ms >= 0) out[toPosixPath(path)] = ms
  }
  return out
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Each path's weight: its recorded time, or the median recorded time when unknown. */
export function weightsFor(paths, timings) {
  const known = paths.map((path) => timings[path]).filter((ms) => Number.isFinite(ms))
  const fallback = median(known) ?? DEFAULT_WEIGHT_MS
  return paths.map((path) => (Number.isFinite(timings[path]) ? timings[path] : fallback))
}

/**
 * Longest-first greedy: heaviest file first (path breaks ties), each into the
 * lightest bin (lowest index breaks ties). Deterministic, so every shard
 * computes the same split from the same file list and times.
 */
export function partitionByWeight(paths, weights, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid shard count: ${count}`)
  if (paths.length !== weights.length) throw new Error('paths and weights differ in length')
  const order = paths
    .map((path, index) => ({ path, weight: weights[index] }))
    .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const bins = Array.from({ length: count }, () => ({ total: 0, paths: [] }))
  for (const { path, weight } of order) {
    let lightest = 0
    for (let index = 1; index < bins.length; index++) {
      if (bins[index].total < bins[lightest].total) lightest = index
    }
    bins[lightest].total += weight
    bins[lightest].paths.push(path)
  }
  return bins
}

/** The paths for shard `index` (1-based) of `count`. */
export function shardPaths(paths, timings, index, count) {
  if (!Number.isInteger(index) || index < 1 || index > count) {
    throw new Error(`Invalid shard index: ${index}/${count}`)
  }
  const unique = [...new Set(paths.map(toPosixPath))]
  return partitionByWeight(unique, weightsFor(unique, timings), count)[index - 1].paths
}

/** Every expected file ran in exactly one shard. */
export function checkShardCoverage(expected, shardFileLists) {
  const seen = new Map()
  for (const files of shardFileLists) {
    for (const file of files) seen.set(toPosixPath(file), (seen.get(toPosixPath(file)) ?? 0) + 1)
  }
  const expectedSet = new Set(expected.map(toPosixPath))
  return {
    missing: [...expectedSet].filter((file) => !seen.has(file)).sort(),
    duplicated: [...seen]
      .filter(([, n]) => n > 1)
      .map(([file]) => file)
      .sort(),
    unexpected: [...seen.keys()].filter((file) => !expectedSet.has(file)).sort()
  }
}

/** Slowest shard over the mean; 1 means perfectly even. */
export function shardBalance(shardTotals) {
  const totals = shardTotals.filter((value) => Number.isFinite(value))
  if (totals.length === 0) return null
  const mean = totals.reduce((sum, value) => sum + value, 0) / totals.length
  return mean > 0 ? Math.max(...totals) / mean : 1
}

/** Merges shard reports ({ files: { path: ms } }) into one timings document. */
export function mergeTimings(reports) {
  const files = {}
  for (const report of reports) Object.assign(files, readTimings(report))
  const sorted = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((path) => [path, Math.round(files[path] / 10) * 10])
  )
  return { version: 1, files: sorted }
}
