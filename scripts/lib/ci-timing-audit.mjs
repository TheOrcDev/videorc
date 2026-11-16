// Plan 242 S0: split every CI job into waiting, setup and running time.
// Pure helpers; scripts/ci-timing-audit.mjs fetches the runs and prints.

// Steps that prepare a runner rather than check the code: the job's own
// start/finish, checkout, toolchains, caches and dependency installs.
const SETUP_STEP_RE =
  /^(Set up job|Complete job|Post |Check out|Checkout|Set up |Cache |Install dependencies|Install (PipeWire|Linux|cargo-audit|Rust advisory auditor)|Run (actions|dtolnay|Swatinem|pnpm\/action-setup|taiki-e|msys2)\/|Prepare all required actions|Fetch and verify pinned|CI-only fast backend build profile|Download |Upload )/

export function isSetupStep(name) {
  return SETUP_STEP_RE.test(String(name ?? ''))
}

function seconds(from, to) {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return (end - start) / 1000
}

/** Nearest-rank percentile of a numeric list; null for an empty list. */
export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/**
 * Buckets one job. Waiting is queue time (created → started), setup is the
 * setup steps, running is the rest of the job's own time. Skipped and
 * cancelled jobs return null: they say nothing about how long a check takes.
 */
export function bucketJob(job) {
  if (!job || job.status !== 'completed') return null
  if (job.conclusion !== 'success' && job.conclusion !== 'failure') return null
  const total = seconds(job.started_at, job.completed_at)
  if (total === null) return null
  const waiting = seconds(job.created_at, job.started_at) ?? 0
  let setup = 0
  for (const step of job.steps ?? []) {
    if (!isSetupStep(step.name)) continue
    setup += seconds(step.started_at, step.completed_at) ?? 0
  }
  setup = Math.min(setup, total)
  return {
    name: job.name,
    os: runnerOs(job),
    waiting,
    setup,
    running: total - setup,
    total,
    conclusion: job.conclusion
  }
}

export function runnerOs(job) {
  const labels = (job.labels ?? []).join(' ').toLowerCase()
  if (labels.includes('windows')) return 'windows'
  if (labels.includes('macos')) return 'macos'
  return 'linux'
}

/** Groups bucketed jobs by "workflow / job name" and reports p50/p95 per bucket. */
export function summarizeJobs(entries) {
  const groups = new Map()
  for (const { workflow, bucket } of entries) {
    if (!bucket) continue
    // The OS is part of the key: a skip twin shares its gate's name but runs
    // on Linux in seconds, and must not dilute the real gate's numbers.
    const key = `${workflow} / ${bucket.name} [${bucket.os}]`
    if (!groups.has(key)) groups.set(key, { key, os: bucket.os, rows: [] })
    groups.get(key).rows.push(bucket)
  }
  return [...groups.values()]
    .map(({ key, os, rows }) => {
      const pick = (field) => rows.map((row) => row[field])
      const stats = {}
      for (const field of ['waiting', 'setup', 'running', 'total']) {
        stats[field] = { p50: percentile(pick(field), 50), p95: percentile(pick(field), 95) }
      }
      return { key, os, count: rows.length, ...stats }
    })
    .sort((a, b) => (b.total.p50 ?? 0) - (a.total.p50 ?? 0))
}

/**
 * Wall time of one workflow run as a person sees it: from the start of the
 * run's latest attempt to the last job finishing. A re-run keeps the old
 * created_at, so created_at would count the hours between attempts. Null when
 * no job ran.
 */
export function runWallSeconds(run, jobs) {
  const finished = jobs
    .filter((job) => job.status === 'completed' && job.completed_at && job.started_at)
    .map((job) => Date.parse(job.completed_at))
  if (finished.length === 0) return null
  const start = Date.parse(run.run_started_at ?? run.created_at)
  return (Math.max(...finished) - start) / 1000
}

/** Runner minutes per OS, extrapolated from the sampled window to 30 days. */
export function monthlyMinutesByOs(buckets, windowDays) {
  const totals = { linux: 0, windows: 0, macos: 0 }
  for (const bucket of buckets) {
    if (!bucket) continue
    totals[bucket.os] += bucket.total / 60
  }
  const scale = windowDays > 0 ? 30 / windowDays : 0
  return Object.fromEntries(
    Object.entries(totals).map(([os, minutes]) => [os, Math.round(minutes * scale)])
  )
}

// Blacksmith list prices (blacksmith.sh/pricing, read 2026-11-16): the
// smallest size per OS. 3,000 free minutes a month across all of them.
export const BLACKSMITH_PRICE_PER_MINUTE = Object.freeze({
  linux: 0.004,
  windows: 0.008,
  macos: 0.08
})
export const BLACKSMITH_FREE_MINUTES = 3000

export function blacksmithMonthlyCost(minutesByOs) {
  let freeLeft = BLACKSMITH_FREE_MINUTES
  let cost = 0
  // The free minutes go to the most expensive OS first, so this is a lower
  // bound on the bill; Blacksmith's page does not say how it applies them.
  for (const os of ['macos', 'windows', 'linux']) {
    let minutes = minutesByOs[os] ?? 0
    const free = Math.min(freeLeft, minutes)
    freeLeft -= free
    minutes -= free
    cost += minutes * BLACKSMITH_PRICE_PER_MINUTE[os]
  }
  return Math.round(cost)
}
