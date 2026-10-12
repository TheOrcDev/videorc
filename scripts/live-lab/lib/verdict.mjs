import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { summarizeNumericSeries } from '../../lib/performance-contract.mjs'
import { DEFAULT_FRAME_OPTIONS, runFrameChecks } from './frame-checks.mjs'
import { parseJournalLine, flattenHealthEvents } from './app-observer.mjs'
import { redactValue } from './redact.mjs'

// Plan 178 U9 step 4 (plan 166 S8 steps 1-2). The verdict engine: every
// signal of plan 166's "Incident signals and first thresholds" computed from
// the run folder alone (manifest, steps, journal, health, census, observer
// snapshots, feature records, clip analyses, crash evidence), judged against
// config/live-lab/thresholds.v1.json. Output is verdict.json (schema 1, the
// contract pinned by the orchestrator: U10 publishes it, U12 triages it).
//
// Report mode: a threshold breach is `warn`. P0 incidents (app says live,
// YouTube has no data; the stream ended from Studio), crashes and failed
// steps are `fail` in any mode. needs-eyes items never block a run.

export const VERDICT_SCHEMA = 1
export const DEFAULT_THRESHOLDS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'config',
  'live-lab',
  'thresholds.v1.json'
)

const ROLE_MAP = [
  [/^backend$/, 'backend'],
  [/^electron-main$/, 'electron-main'],
  [/^electron-renderer/, 'electron-renderer'],
  [/^electron-gpu$/, 'electron-gpu'],
  [/^ffmpeg/, 'ffmpeg'],
  [/preview/i, 'preview-helper']
]

export function normalizeRole(role) {
  for (const [pattern, name] of ROLE_MAP) if (pattern.test(String(role ?? ''))) return name
  return null
}

// ---------------------------------------------------------------------------
// Run folder readers (every file optional except manifest.json)
// ---------------------------------------------------------------------------

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readJson(path) {
  const text = await readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function readNdjson(path) {
  const text = await readText(path)
  if (text === null) return []
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn last line is not evidence.
    }
  }
  return out
}

/** Pure: census.csv text to [{ atMs, roles: { role: rssKb }, totalKb }]. */
export function parseCensusCsv(text) {
  const samples = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const [ts, _pid, _ppid, role, rss] = line.split(',')
    if (!ts || ts === 'ts') continue
    const atMs = Date.parse(ts)
    const rssKb = Number(rss)
    if (!Number.isFinite(atMs) || !Number.isFinite(rssKb)) continue
    const sample = samples.get(ts) ?? { atMs, roles: {}, totalKb: 0 }
    const name = normalizeRole(role)
    if (name) sample.roles[name] = (sample.roles[name] ?? 0) + rssKb
    sample.totalKb += rssKb
    samples.set(ts, sample)
  }
  return [...samples.values()].sort((a, b) => a.atMs - b.atMs)
}

export async function readRunFolder(runDir) {
  const manifest = await readJson(join(runDir, 'manifest.json'))
  if (!manifest) throw new Error(`${runDir} has no readable manifest.json`)
  const journal = (await readNdjson(join(runDir, 'journal.ndjson')))
    .map((line) => parseJournalLine(line))
    .filter(Boolean)
  const health = await readNdjson(join(runDir, 'health.ndjson'))
  const census = parseCensusCsv(await readText(join(runDir, 'census.csv')))
  const observer = await readNdjson(join(runDir, 'observer.ndjson'))
  const features = await readNdjson(join(runDir, 'features.ndjson'))
  const pulls = await readNdjson(join(runDir, 'clips', 'pulls.ndjson'))
  const steps = manifest.steps?.length
    ? manifest.steps
    : await readNdjson(join(runDir, 'steps.ndjson'))
  const quota = await readJson(join(runDir, 'quota.json'))
  const clips = []
  let clipNames = []
  try {
    clipNames = (await readdir(join(runDir, 'clips'))).filter((name) =>
      name.endsWith('.analysis.json')
    )
  } catch {
    clipNames = []
  }
  for (const name of clipNames.sort()) {
    const record = await readJson(join(runDir, 'clips', name))
    if (record) clips.push({ ...record, file: `clips/${name}` })
  }
  let crashFiles = []
  try {
    crashFiles = (await readdir(join(runDir, 'crash'))).sort()
  } catch {
    crashFiles = []
  }
  const backendCrashes = crashFiles.includes('backend-crashes.json')
    ? await readJson(join(runDir, 'crash', 'backend-crashes.json'))
    : null
  return {
    runDir,
    manifest,
    steps,
    journal,
    health,
    census,
    observer,
    features,
    pulls,
    clips,
    quota,
    crashFiles,
    backendCrashes
  }
}

// ---------------------------------------------------------------------------
// Signal helpers (pure)
// ---------------------------------------------------------------------------

function mbPerHour(kbPerMinute) {
  return Number.isFinite(kbPerMinute) ? (kbPerMinute / 1024) * 60 : null
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Pure: longest run (ms) of consecutive samples where `bad(sample)` holds. */
export function longestBadRunMs(samples, bad) {
  let longest = 0
  let runStart = null
  let last = null
  for (const sample of samples) {
    if (bad(sample)) {
      if (runStart === null) runStart = sample.atMs
      last = sample.atMs
      longest = Math.max(longest, last - runStart)
    } else {
      runStart = null
    }
  }
  return longest
}

/** Pure: per-leg dropped-frame percent over sliding windows of `windowMs`. */
export function droppedFrameWindows(journal, windowMs) {
  const legs = new Map()
  for (const line of journal) {
    if (line.kind !== 'sample') continue
    for (const leg of line.legs ?? []) {
      if (!leg.targetId || !Number.isFinite(leg.droppedFrames)) continue
      const list = legs.get(leg.targetId) ?? []
      list.push({ atMs: line.tsMs, dropped: leg.droppedFrames, fps: leg.fps })
      legs.set(leg.targetId, list)
    }
  }
  const windows = []
  for (const [targetId, list] of legs) {
    for (let i = 0; i < list.length; i += 1) {
      const start = list[i]
      let j = i
      while (j < list.length && list[j].atMs - start.atMs < windowMs) j += 1
      if (j >= list.length) break
      const end = list[j]
      const seconds = (end.atMs - start.atMs) / 1000
      const fps = Number.isFinite(end.fps) && end.fps > 0 ? end.fps : 30
      const expected = fps * seconds
      const dropped = Math.max(0, end.dropped - start.dropped)
      if (expected <= 0) continue
      windows.push({
        targetId,
        atMs: end.atMs,
        percent: (dropped / (expected + dropped)) * 100,
        dropped
      })
    }
  }
  return windows
}

/** Pure: least-squares slope of `values` against their index. */
export function slopePerIndex(values) {
  const n = values.length
  if (n < 2) return 0
  const meanX = (n - 1) / 2
  const meanY = values.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  values.forEach((y, x) => {
    num += (x - meanX) * (y - meanY)
    den += (x - meanX) ** 2
  })
  return den === 0 ? 0 : num / den
}

function statusFor(breached, { mode, severity = 'P1' }) {
  if (!breached) return { status: 'pass', severity: null }
  if (severity === 'P0') return { status: 'fail', severity }
  return { status: mode === 'gate' ? 'fail' : 'warn', severity }
}

function signal(id, fields) {
  return {
    id,
    status: 'pass',
    severity: null,
    signature: null,
    summary: '',
    value: null,
    threshold: null,
    unit: null,
    evidence: [],
    ...fields
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Computes the verdict for an already-read run folder. Pure apart from the
 * frame checks (`frameChecks` injectable; `runFrames: false` skips them).
 * Returns { verdict, series } where series feeds the report's charts.
 */
export async function computeVerdict(
  run,
  thresholds,
  { frameChecks = runFrameChecks, runFrames = true, now = () => new Date() } = {}
) {
  const mode = thresholds.mode === 'gate' ? 'gate' : 'report'
  const { manifest, steps, journal, health, census, observer, features, pulls, clips } = run
  const signals = []
  const series = {}
  const startedAtMs = Date.parse(manifest.startedAt ?? '') || 0
  const judge = (breached, severity) => statusFor(breached, { mode, severity })

  // --- steps -----------------------------------------------------------------
  const failedSteps = steps.filter((step) => ['fail', 'timeout'].includes(step.status))
  const stepCounts = {
    total: steps.length,
    passed: steps.filter((step) => step.status === 'pass').length,
    failed: failedSteps.length,
    skipped: steps.filter((step) => step.status === 'skipped').length,
    stopped: steps.filter((step) => step.status === 'stopped').length
  }
  for (const step of failedSteps) {
    signals.push(
      signal(`step:${step.id}`, {
        status: 'fail',
        severity: 'P1',
        signature: `step:${step.id}`,
        summary: `Step ${step.id} ${step.status}: ${step.reason ?? 'no reason'}`,
        evidence: ['steps.ndjson', 'run.log']
      })
    )
  }
  if (failedSteps.length === 0) {
    signals.push(
      signal('steps', {
        summary: `${stepCounts.passed} of ${stepCounts.total} steps passed, ${stepCounts.skipped} skipped`,
        value: stepCounts.passed,
        evidence: ['steps.ndjson']
      })
    )
  }

  // --- leaks (census) ----------------------------------------------------------
  const leak = thresholds.leak ?? {}
  const roles = new Set()
  for (const sample of census) for (const role of Object.keys(sample.roles)) roles.add(role)
  series.rssByRole = {}
  const durationMin = census.length > 1 ? (census.at(-1).atMs - census[0].atMs) / 60000 : 0
  for (const role of [...roles].sort()) {
    const points = census.map((sample) => ({ atMs: sample.atMs, value: sample.roles[role] ?? 0 }))
    series.rssByRole[role] = points.map((p) => ({ atMs: p.atMs, value: p.value / 1024 }))
    const limit = leak.mbPerHourByRole?.[role] ?? null
    if (durationMin < (leak.minDurationMinutes ?? 40) || limit === null) {
      signals.push(
        signal(`leak:${role}`, {
          status: 'skipped',
          summary:
            limit === null
              ? `no leak threshold for ${role}`
              : `run too short to judge leaks (${Math.round(durationMin)} min, needs ${leak.minDurationMinutes ?? 40})`,
          threshold: limit,
          unit: 'MB/h',
          evidence: ['census.csv']
        })
      )
      continue
    }
    const warmupMs = (leak.warmupMinutes ?? 30) * 60000
    const whole = summarizeNumericSeries(points, { warmupMs })
    const windowStart = census.at(-1).atMs - (leak.windowMinutes ?? 120) * 60000
    const windowPoints = points.filter(
      (p) => p.atMs >= Math.max(windowStart, points[0].atMs + warmupMs)
    )
    const window = summarizeNumericSeries(windowPoints.length > 2 ? windowPoints : points, {
      warmupMs: 0
    })
    const windowSlope = mbPerHour(window.slopePerMinute)
    const secondHalf = mbPerHour(whole.secondHalfSlopePerMinute)
    const breached = windowSlope > limit && secondHalf > limit
    const { status, severity } = judge(breached, 'P1')
    signals.push(
      signal(`leak:${role}`, {
        status,
        severity,
        signature: breached ? `leak:${role}` : null,
        summary: breached
          ? `${role} RSS grows ${round(windowSlope)} MB/h over the last ${leak.windowMinutes ?? 120} min and ${round(secondHalf)} MB/h in the second half (limit ${limit} MB/h)`
          : `${role} RSS slope ${round(windowSlope)} MB/h (second half ${round(secondHalf)}), limit ${limit} MB/h`,
        value: round(Math.max(windowSlope ?? 0, secondHalf ?? 0)),
        threshold: limit,
        unit: 'MB/h',
        evidence: ['census.csv', `charts/rss-${role}.png`]
      })
    )
  }
  if (census.length > 0) {
    const maxOwnedGb = Math.max(...census.map((sample) => sample.totalKb)) / 1024 / 1024
    const limitGb = thresholds.memory?.maxOwnedRssGb ?? 3
    const { status, severity } = judge(maxOwnedGb > limitGb, 'P1')
    signals.push(
      signal('memory:owned-rss', {
        status,
        severity,
        signature: status === 'pass' ? null : 'memory:owned-rss',
        summary: `peak owned RSS ${round(maxOwnedGb, 2)} GB (limit ${limitGb} GB)`,
        value: round(maxOwnedGb, 2),
        threshold: limitGb,
        unit: 'GB',
        evidence: ['census.csv']
      })
    )
  } else {
    signals.push(
      signal('memory:owned-rss', {
        status: 'skipped',
        summary: 'no census samples',
        evidence: ['census.csv']
      })
    )
  }
  signals.push(
    signal('handles:fds', {
      status: 'skipped',
      summary: 'file handles are not sampled yet (lsof every 10 min, plan 166)',
      threshold: thresholds.handles?.maxFdsPerHour ?? null,
      unit: 'fds/h'
    }),
    signal('handles:threads', {
      status: 'skipped',
      summary: 'threads are not sampled yet (ps -M every 10 min, plan 166)',
      threshold: thresholds.handles?.maxThreadsPerHour ?? null,
      unit: 'threads/h'
    })
  )

  // --- orphans (teardown) -------------------------------------------------------
  const cleanLedger = (manifest.teardown?.steps ?? []).find((step) => step.name === 'clean-ledger')
  if (!manifest.teardown) {
    signals.push(
      signal('teardown:orphans', {
        status: 'skipped',
        summary: 'no teardown recorded',
        evidence: ['manifest.json']
      })
    )
  } else {
    const orphaned = cleanLedger ? !cleanLedger.ok : false
    signals.push(
      signal('teardown:orphans', {
        status: orphaned ? 'fail' : 'pass',
        severity: orphaned ? 'P1' : null,
        signature: orphaned ? 'teardown:orphans' : null,
        summary: orphaned
          ? `owned PIDs outlived the app: ${String(cleanLedger.detail ?? '').slice(0, 200)}`
          : `ledger clean after quit${manifest.teardown.clean ? '' : ' (another teardown step failed)'}`,
        evidence: ['manifest.json']
      })
    )
    if (!manifest.teardown.clean) {
      const failed = (manifest.teardown.steps ?? []).filter(
        (step) => !step.ok && step.name !== 'clean-ledger'
      )
      for (const step of failed) {
        signals.push(
          signal(`teardown:${step.name}`, {
            status: 'fail',
            severity: 'P1',
            signature: `teardown:${step.name}`,
            summary: `teardown ${step.name} failed: ${String(step.detail ?? '').slice(0, 200)}`,
            evidence: ['manifest.json', 'run.log']
          })
        )
      }
    }
  }

  // --- journal: dropped frames, encoder speed, bitrate --------------------------
  const samples = journal.filter((line) => line.kind === 'sample')
  const liveSamples = samples.filter((line) =>
    (line.legs ?? []).some((leg) => leg.state === 'live')
  )
  series.bitrate = liveSamples.map((line) => ({
    atMs: line.tsMs,
    value: (line.legs ?? []).reduce((sum, leg) => sum + (leg.bitrateKbps ?? 0), 0)
  }))
  series.speed = liveSamples
    .map((line) => {
      const speeds = (line.legs ?? []).map((leg) => leg.speed).filter(Number.isFinite)
      return { atMs: line.tsMs, value: speeds.length ? Math.min(...speeds) : null }
    })
    .filter((p) => p.value !== null)
  const dropWindows = droppedFrameWindows(
    journal,
    (thresholds.droppedFrames?.windowMinutes ?? 5) * 60000
  )
  series.dropped = dropWindows.map((w) => ({ atMs: w.atMs, value: round(w.percent, 3) }))
  if (liveSamples.length === 0) {
    for (const id of ['stream:dropped-frames', 'stream:encoder-speed', 'stream:bitrate']) {
      signals.push(
        signal(id, {
          status: 'skipped',
          summary: 'no live journal samples',
          evidence: ['journal.ndjson']
        })
      )
    }
  } else {
    const dropLimit = thresholds.droppedFrames?.maxPercent ?? 0.5
    const worst = dropWindows.reduce((max, w) => (w.percent > (max?.percent ?? -1) ? w : max), null)
    if (!worst) {
      signals.push(
        signal('stream:dropped-frames', {
          status: 'skipped',
          summary: 'run shorter than one dropped-frame window',
          evidence: ['journal.ndjson']
        })
      )
    } else {
      const { status, severity } = judge(worst.percent > dropLimit, 'P1')
      signals.push(
        signal('stream:dropped-frames', {
          status,
          severity,
          signature: status === 'pass' ? null : 'stream:dropped-frames',
          summary: `worst ${thresholds.droppedFrames?.windowMinutes ?? 5}-min window dropped ${round(worst.percent, 3)}% on ${worst.targetId} (limit ${dropLimit}%)`,
          value: round(worst.percent, 3),
          threshold: dropLimit,
          unit: '%',
          evidence: ['journal.ndjson', 'charts/dropped-frames.png']
        })
      )
    }
    const speedMin = thresholds.encoderSpeed?.min ?? 0.97
    const speedFor = (thresholds.encoderSpeed?.forSeconds ?? 60) * 1000
    const slow = longestBadRunMs(series.speed, (p) => p.value < speedMin)
    const minSpeed = series.speed.length ? Math.min(...series.speed.map((p) => p.value)) : null
    const speedBreach = slow >= speedFor
    const speedJudge = judge(speedBreach, 'P1')
    signals.push(
      signal('stream:encoder-speed', {
        status: series.speed.length ? speedJudge.status : 'skipped',
        severity: speedJudge.severity,
        signature: speedBreach ? 'stream:encoder-speed' : null,
        summary: series.speed.length
          ? speedBreach
            ? `encoder speed under ${speedMin} for ${Math.round(slow / 1000)} s (min ${round(minSpeed, 3)})`
            : `encoder speed min ${round(minSpeed, 3)}, longest slow run ${Math.round(slow / 1000)} s`
          : 'no encoder speed in the journal',
        value: round(minSpeed, 3),
        threshold: speedMin,
        unit: 'x',
        evidence: ['journal.ndjson', 'charts/encoder-speed.png']
      })
    )
    const profile = features.find((feature) => feature.kind === 'profile')
    const target =
      Number(manifest.params?.targetBitrateKbps) ||
      profile?.bitrateKbps ||
      thresholds.bitrate?.defaultTargetKbps ||
      6000
    const fraction = thresholds.bitrate?.minFractionOfTarget ?? 0.7
    const bitrateFor = (thresholds.bitrate?.forSeconds ?? 60) * 1000
    const low = longestBadRunMs(series.bitrate, (p) => p.value < target * fraction)
    const bitrateBreach = low >= bitrateFor
    const bitrateJudge = judge(bitrateBreach, 'P1')
    const medianBitrate = series.bitrate.map((p) => p.value).sort((a, b) => a - b)[
      Math.floor(series.bitrate.length / 2)
    ]
    signals.push(
      signal('stream:bitrate', {
        status: bitrateJudge.status,
        severity: bitrateJudge.severity,
        signature: bitrateBreach ? 'stream:bitrate' : null,
        summary: bitrateBreach
          ? `bitrate under ${Math.round(fraction * 100)}% of ${target} kbps for ${Math.round(low / 1000)} s`
          : `median bitrate ${Math.round(medianBitrate)} kbps against a ${target} kbps target`,
        value: Math.round(medianBitrate),
        threshold: Math.round(target * fraction),
        unit: 'kbps',
        evidence: ['journal.ndjson', 'charts/bitrate.png']
      })
    )
  }

  // --- health events: destination, host overload ------------------------------
  const flatHealth = flattenHealthEvents(health)
  const destinationCodes = new Set(thresholds.destination?.codes ?? [])
  const expectedHere = (thresholds.destination?.expectedInScenarios ?? []).includes(
    manifest.scenario
  )
  const seenDestination = new Map()
  for (const event of flatHealth) {
    if (destinationCodes.has(event.code) && !seenDestination.has(event.code))
      seenDestination.set(event.code, event)
  }
  if (seenDestination.size === 0) {
    signals.push(
      signal('destination', {
        summary: 'no reconnect, stall or failure events',
        evidence: ['health.ndjson']
      })
    )
  }
  for (const [code, event] of seenDestination) {
    const { status, severity } = expectedHere
      ? { status: 'pass', severity: null }
      : judge(true, 'P1')
    signals.push(
      signal(`destination:${code}`, {
        status,
        severity,
        signature: status === 'pass' ? null : `destination:${code}`,
        summary: expectedHere
          ? `${code} at ${new Date(event.at).toISOString()} (expected under injected faults)`
          : `${code} at ${new Date(event.at).toISOString()}`,
        evidence: ['health.ndjson']
      })
    )
  }
  const overloadCode = thresholds.hostOverload?.code ?? 'host-overloaded'
  const overload = flatHealth.find((event) => event.code === overloadCode)
  const overloadJudge = judge(Boolean(overload), 'P1')
  signals.push(
    signal('host:overloaded', {
      status: overloadJudge.status,
      severity: overloadJudge.severity,
      signature: overload ? 'host:overloaded' : null,
      summary: overload
        ? `${overloadCode} at ${new Date(overload.at).toISOString()} (the rig should never be overloaded)`
        : 'no host overload event',
      evidence: ['health.ndjson']
    })
  )

  // --- preview downgrade ------------------------------------------------------------
  const downgrade = journal.find((line) => line.previewFallbackReason)
  const downgradeJudge = judge(Boolean(downgrade), 'P1')
  signals.push(
    signal('preview:downgrade', {
      status: downgradeJudge.status,
      severity: downgradeJudge.severity,
      signature: downgrade ? `preview:downgrade:${downgrade.previewFallbackReason}` : null,
      summary: downgrade
        ? `preview fell back (${downgrade.previewFallbackReason}) at ${downgrade.ts}`
        : 'native preview held for the whole run',
      evidence: ['journal.ndjson']
    })
  )

  // --- observer: noData while live, Studio end, YouTube health --------------------
  const observerIncidents = observer.flatMap((snapshot) => snapshot.incidents ?? [])
  const firstOf = (type) => observerIncidents.find((incident) => incident.type === type) ?? null
  const noData = firstOf('stream:noData-while-live')
  signals.push(
    signal('stream:noData-while-live', {
      status: noData ? 'fail' : observer.length ? 'pass' : 'skipped',
      severity: noData ? 'P0' : null,
      signature: noData ? 'stream:noData-while-live' : null,
      summary: noData
        ? `P0: ${noData.detail}`
        : observer.length
          ? 'YouTube had data on every poll while the app was On air'
          : 'no observer snapshots (local sink or observer off)',
      threshold: thresholds.noDataWhileLive?.polls ?? 2,
      unit: 'polls',
      evidence: ['observer.ndjson', 'journal.ndjson']
    })
  )
  const ended = firstOf('studio-ended')
  const attendedResilience =
    manifest.scenario === 'resilience' && manifest.params?.attended === true
  if (ended) {
    signals.push(
      signal('studio-ended', {
        status: attendedResilience ? 'pass' : 'fail',
        severity: attendedResilience ? null : 'P0',
        signature: attendedResilience ? null : 'studio-ended',
        summary: attendedResilience
          ? `the owner ended the stream from Studio as the scenario asked (${ended.at})`
          : `P0: ${ended.detail}`,
        evidence: ['observer.ndjson']
      })
    )
  }
  series.health = observer
    .map((snapshot) => ({
      atMs: Date.parse(snapshot.at),
      state: snapshot.stream
        ? snapshot.stream.streamStatus === 'active'
          ? (snapshot.stream.healthStatus ?? 'unknown')
          : (snapshot.stream.streamStatus ?? 'unknown')
        : 'noStream'
    }))
    .filter((band) => Number.isFinite(band.atMs))
  const healthIncidents = observerIncidents.filter((incident) =>
    /^youtube-(health|config)/.test(incident.type)
  )
  if (observer.length === 0) {
    signals.push(
      signal('youtube:health', {
        status: 'skipped',
        summary: 'no observer snapshots',
        evidence: ['observer.ndjson']
      })
    )
  } else if (healthIncidents.length === 0) {
    signals.push(
      signal('youtube:health', {
        summary: `YouTube health stayed good over ${observer.length} polls`,
        value: observer.length,
        unit: 'polls',
        evidence: ['observer.ndjson', 'charts/youtube-health.png']
      })
    )
  } else {
    const seen = new Set()
    for (const incident of healthIncidents) {
      if (seen.has(incident.type)) continue
      seen.add(incident.type)
      const { status, severity } = judge(true, incident.severity ?? 'P2')
      signals.push(
        signal(`youtube:${incident.type.replace(/^youtube-/, '')}`, {
          status,
          severity,
          signature: incident.type,
          summary: incident.detail,
          evidence: ['observer.ndjson', 'charts/youtube-health.png']
        })
      )
    }
  }
  const refused =
    firstOf('observer:quota-refused') ??
    observerIncidents.find((i) => i.type === 'observer:quota-refused')
  if (refused) {
    signals.push(
      signal('observer:quota-refused', {
        status: 'warn',
        severity: 'P2',
        signature: 'observer:quota-refused',
        summary: refused.detail,
        evidence: ['observer.ndjson', 'quota.json']
      })
    )
  }

  // --- clips -------------------------------------------------------------------------------
  const clipIncidents = clips.flatMap((clip) =>
    (clip.incidents ?? []).map((incident) => ({ ...incident, file: clip.file }))
  )
  const pullsSkippedOff =
    pulls.length > 0 &&
    pulls.every((pull) => pull.status === 'skipped' && pull.reason === 'clip-pull-disabled')
  if (clips.length === 0) {
    signals.push(
      signal('clips', {
        status: 'skipped',
        summary:
          pullsSkippedOff || pulls.length === 0
            ? 'clips: skipped (clipPull off)'
            : `no clip analyzed (${pulls.map((p) => p.reason ?? p.status).join(', ')})`,
        evidence: pulls.length ? ['clips/pulls.ndjson'] : []
      })
    )
  } else if (clipIncidents.length === 0) {
    signals.push(
      signal('clips', {
        summary: `${clips.length} clip(s) of the public output clean (freeze, audio gap, A/V offset within limits)`,
        value: clips.length,
        unit: 'clips',
        evidence: clips.map((clip) => clip.file)
      })
    )
  } else {
    const seen = new Set()
    for (const incident of clipIncidents) {
      if (seen.has(incident.type)) continue
      seen.add(incident.type)
      const { status, severity } = judge(true, incident.severity ?? 'P1')
      signals.push(
        signal(incident.type, {
          status,
          severity,
          signature: incident.type,
          summary: incident.detail,
          evidence: [incident.file]
        })
      )
    }
  }

  // --- crashes ------------------------------------------------------------------------------
  const crashes = []
  for (const name of run.crashFiles ?? []) {
    if (name === 'backend-crashes.json') continue
    const process = name.startsWith('crashpad-')
      ? 'electron'
      : (
          name.match(/^(videorc-backend|native_preview_host_helper|ffmpeg|Videorc)/i)?.[1] ??
          'unknown'
        ).toLowerCase()
    crashes.push({ process, file: `crash/${name}` })
  }
  const backendEntries = Array.isArray(run.backendCrashes)
    ? run.backendCrashes
    : (run.backendCrashes?.crashes ?? run.backendCrashes?.entries ?? [])
  for (const entry of Array.isArray(backendEntries) ? backendEntries : []) {
    const at = Date.parse(entry?.at ?? entry?.timestamp ?? entry?.exitedAt ?? '')
    if (Number.isFinite(at) && at >= startedAtMs)
      crashes.push({ process: 'videorc-backend', file: 'crash/backend-crashes.json' })
  }
  if (crashes.length === 0) {
    signals.push(
      signal('crashes', {
        summary: 'no crash report, minidump or backend exit during the run',
        evidence: ['crash/']
      })
    )
  } else {
    const seen = new Set()
    for (const crash of crashes) {
      if (seen.has(crash.process)) continue
      seen.add(crash.process)
      const endedStream = failedSteps.length > 0 || manifest.outcome === 'crashed'
      signals.push(
        signal(`crash:${crash.process}`, {
          status: 'fail',
          severity: endedStream
            ? (thresholds.crashes?.severityWhenStreamEnded ?? 'P0')
            : (thresholds.crashes?.severity ?? 'P1'),
          signature: `crash:${crash.process}`,
          summary: `${crash.process} crashed during the run (${crashes.filter((c) => c.process === crash.process).length} file(s))`,
          evidence: crashes.filter((c) => c.process === crash.process).map((c) => c.file)
        })
      )
    }
  }

  // --- start latency -----------------------------------------------------------------------
  const latencies = [
    ...steps
      .filter((step) => /go-live$/.test(step.id) && Number.isFinite(step.evidence?.liveAfterMs))
      .map((step) => step.evidence.liveAfterMs),
    ...features
      .filter((feature) => feature.kind === 'go-live' && Number.isFinite(feature.liveAfterMs))
      .map((feature) => feature.liveAfterMs)
  ]
  if (latencies.length === 0) {
    signals.push(
      signal('stream:start-latency', {
        status: 'skipped',
        summary: 'no go-live timing recorded',
        evidence: ['steps.ndjson']
      })
    )
  } else {
    const maxMs = Math.max(...latencies)
    const slope = latencies.length >= 5 ? slopePerIndex(latencies) : 0
    const limit = thresholds.startLatency?.maxMs ?? 10000
    const slopeLimit = thresholds.startLatency?.slopeMsPerCycle ?? 100
    const breached = maxMs > limit || slope > slopeLimit
    const { status, severity } = judge(breached, 'P1')
    signals.push(
      signal('stream:start-latency', {
        status,
        severity,
        signature: breached ? 'stream:start-latency' : null,
        summary: `${latencies.length} go live(s), slowest ${Math.round(maxMs)} ms${latencies.length >= 5 ? `, trend ${round(slope)} ms per cycle` : ''} (limit ${limit} ms)`,
        value: Math.round(maxMs),
        threshold: limit,
        unit: 'ms',
        evidence: ['steps.ndjson', 'features.ndjson']
      })
    )
  }

  // --- chat -----------------------------------------------------------------------------------
  const arrivals = features.filter((feature) => feature.kind === 'chat-arrival')
  if (arrivals.length > 0) {
    const missing = arrivals.flatMap((feature) => feature.missing ?? [])
    const maxLatency = Math.max(...arrivals.map((feature) => feature.maxLatencyMs ?? 0))
    const sent = arrivals.reduce((sum, feature) => sum + (feature.sent ?? 0), 0)
    signals.push(
      signal('chat:delivery', {
        status: missing.length ? 'fail' : 'pass',
        severity: missing.length ? 'P1' : null,
        signature: missing.length ? 'chat:message-missing' : null,
        summary: missing.length
          ? `${missing.length} of ${sent} viewer messages never reached the app (${missing.join(', ')})`
          : `all ${sent} viewer messages reached the app`,
        value: sent - missing.length,
        threshold: sent,
        unit: 'messages',
        evidence: ['features.ndjson', 'events.ndjson']
      })
    )
    const limit = thresholds.chat?.maxArrivalMs ?? 10000
    const { status, severity } = judge(maxLatency > limit, 'P2')
    signals.push(
      signal('chat:latency', {
        status,
        severity,
        signature: status === 'pass' ? null : 'chat:latency',
        summary: `slowest arrival ${Math.round(maxLatency)} ms (limit ${limit} ms)`,
        value: Math.round(maxLatency),
        threshold: limit,
        unit: 'ms',
        evidence: ['features.ndjson']
      })
    )
  }

  // --- frame checks ---------------------------------------------------------------------------
  const frameOptions = { ...DEFAULT_FRAME_OPTIONS, ...(thresholds.frames ?? {}) }
  const clipRecords = clips.map((clip) => ({
    recordedAt: clip.recordedAt,
    seconds: clip.seconds,
    clipFile: clip.clipFile
  }))
  const frameResults = runFrames
    ? await frameChecks({ runDir: run.runDir, features, clips: clipRecords, options: frameOptions })
    : []
  for (const result of frameResults) {
    signals.push(
      signal(`frames:${result.id}`, {
        status: result.status,
        severity: result.status === 'fail' ? 'P1' : null,
        signature: result.status === 'fail' ? `frames:${result.kind}-missing` : null,
        summary: `${result.kind} at ${result.at}: ${result.reason}`,
        evidence: result.frames.length ? result.frames : ['features.ndjson']
      })
    )
  }

  // --- needs-eyes -------------------------------------------------------------------------------
  const frameFor = (hint) => frameResults.find((result) => result.id === hint)?.frames?.[0] ?? null
  const needsEyes = [
    ...features
      .filter((feature) => feature.kind === 'needs-eyes')
      .map((feature) => ({
        id: feature.id,
        question: feature.question,
        frame: frameFor(feature.frameHint)
      })),
    ...frameResults
      .filter((result) => result.status === 'needs-eyes')
      .map((result) => ({
        id: `frame:${result.id}`,
        question: `${result.reason}. Check the ${result.kind} at ${result.at} on the VOD.`,
        frame: result.frames[0] ?? null
      }))
  ]

  // --- incidents, outcome ------------------------------------------------------------------------
  const incidents = []
  const seenSignatures = new Set()
  for (const entry of signals) {
    if (
      !entry.signature ||
      !['fail', 'warn'].includes(entry.status) ||
      seenSignatures.has(entry.signature)
    )
      continue
    seenSignatures.add(entry.signature)
    incidents.push({
      signature: entry.signature,
      severity: entry.severity,
      summary: entry.summary,
      firstAt: firstAtOf(entry, { noData, ended, observerIncidents, flatHealth, manifest }),
      evidence: entry.evidence
    })
  }
  const anyFail = signals.some((entry) => entry.status === 'fail')
  const anyWarn = signals.some((entry) => entry.status === 'warn')
  let outcome = 'pass'
  if (manifest.outcome === 'crashed') outcome = 'crashed'
  else if (anyFail) outcome = 'fail'
  else if (manifest.outcome === 'stopped') outcome = 'stopped'
  else if (anyWarn) outcome = 'warn'

  const vodId = observer.map((snapshot) => snapshot.broadcast?.id).find(Boolean) ?? null
  const verdict = redactValue({
    schema: VERDICT_SCHEMA,
    runId: manifest.runId,
    scenario: manifest.scenario,
    trigger: manifest.trigger,
    privacy: manifest.privacy,
    build: {
      source: manifest.build?.source ?? null,
      version: manifest.build?.version ?? null,
      sha: manifest.build?.sha ? String(manifest.build.sha).slice(0, 12) : null
    },
    startedAt: manifest.startedAt ?? null,
    endedAt: manifest.endedAt ?? null,
    outcome,
    thresholdsMode: mode,
    signals,
    incidents,
    needsEyes,
    quota: {
      labUnits: run.quota?.labUnits ?? 0,
      bundledUnits: run.quota?.bundledUnits ?? 0
    },
    vod: vodId ? { videoId: vodId, url: `https://www.youtube.com/watch?v=${vodId}` } : null,
    // Additions to the pinned contract (fields only, never renames):
    thresholdsVersion: thresholds.version ?? 1,
    generatedAt: now().toISOString(),
    stopReason: manifest.stopReason ?? null,
    exitCode: manifest.exitCode ?? null,
    harnessCommit: manifest.harness?.commit ? String(manifest.harness.commit).slice(0, 12) : null,
    steps: stepCounts,
    frameChecks: {
      total: frameResults.length,
      passed: frameResults.filter((r) => r.status === 'pass').length,
      failed: frameResults.filter((r) => r.status === 'fail').length,
      needsEyes: frameResults.filter((r) => r.status === 'needs-eyes').length
    }
  })
  return { verdict, series, frameResults }
}

function firstAtOf(entry, { noData, ended, observerIncidents, flatHealth, manifest }) {
  if (entry.signature === 'stream:noData-while-live' && noData) return noData.at
  if (entry.signature === 'studio-ended' && ended) return ended.at
  const observed = observerIncidents.find((incident) => incident.type === entry.signature)
  if (observed?.at) return observed.at
  const code = entry.signature?.startsWith('destination:')
    ? entry.signature.slice('destination:'.length)
    : null
  const health = code ? flatHealth.find((event) => event.code === code) : null
  if (health) return new Date(health.at).toISOString()
  return manifest.startedAt ?? null
}

// Plan 178 U15: once the owner merges the calibrated thresholds.v2.json, every
// verdict uses it; until then v1 (report-only) applies.
export const CALIBRATED_THRESHOLDS_PATH = join(
  dirname(DEFAULT_THRESHOLDS_PATH),
  'thresholds.v2.json'
)

export function activeThresholdsPath({ exists = existsSync } = {}) {
  return exists(CALIBRATED_THRESHOLDS_PATH) ? CALIBRATED_THRESHOLDS_PATH : DEFAULT_THRESHOLDS_PATH
}

export async function loadThresholds(path = activeThresholdsPath()) {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (![1, 2].includes(parsed.version) || !['report', 'gate'].includes(parsed.mode)) {
    throw new Error(`${path}: expected thresholds version 1 or 2 with mode report|gate`)
  }
  return parsed
}

/** Reads a run folder, computes its verdict. Writes nothing (see report.mjs). */
export async function verdictForRun(runDir, { thresholdsPath, thresholds, ...options } = {}) {
  const run = await readRunFolder(runDir)
  const loaded = thresholds ?? (await loadThresholds(thresholdsPath))
  await stat(runDir)
  return { run, ...(await computeVerdict(run, loaded, options)) }
}
