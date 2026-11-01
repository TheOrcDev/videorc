import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { renderMarkerFrame } from './card-markers.mjs'
import { finalizeRunFolder } from './finalize.mjs'
import { runFrameChecks } from './frame-checks.mjs'
import { findSensitive } from './redact.mjs'
import { renderReport } from './report.mjs'
import {
  computeVerdict,
  droppedFrameWindows,
  loadThresholds,
  longestBadRunMs,
  normalizeRole,
  parseCensusCsv,
  readRunFolder,
  slopePerIndex,
  verdictForRun
} from './verdict.mjs'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures')
const CONTRACT_KEYS = [
  'schema',
  'runId',
  'scenario',
  'trigger',
  'privacy',
  'build',
  'startedAt',
  'endedAt',
  'outcome',
  'thresholdsMode',
  'signals',
  'incidents',
  'needsEyes',
  'quota',
  'vod'
]

async function fixtureCopy(name) {
  const dir = await mkdtemp(join(tmpdir(), `videorc-verdict-${name}-`))
  await cp(join(FIXTURES, name), dir, { recursive: true })
  return dir
}

const byId = (verdict, id) => verdict.signals.find((entry) => entry.id === id)

test('pure helpers: roles, census, bad runs, dropped-frame windows, slope', () => {
  assert.equal(normalizeRole('electron-renderer-comments'), 'electron-renderer')
  assert.equal(normalizeRole('native-preview-host'), 'preview-helper')
  assert.equal(normalizeRole('other'), null)
  const census = parseCensusCsv(
    'ts,pid,ppid,role,rssKb\n2026-10-12T06:00:00.000Z,1,0,backend,1024\n2026-10-12T06:00:00.000Z,2,1,electron-renderer,2048\n2026-10-12T06:00:10.000Z,1,0,backend,1030\nbad line\n'
  )
  assert.equal(census.length, 2)
  assert.deepEqual(census[0].roles, { backend: 1024, 'electron-renderer': 2048 })
  assert.equal(census[0].totalKb, 3072)
  const samples = [0, 5, 10, 15, 20, 25].map((s) => ({
    atMs: s * 1000,
    value: s >= 5 && s <= 15 ? 0.9 : 1
  }))
  // Three bad samples at a 5 s cadence are 15 s of slow encoding: the run is
  // measured from the last good sample, not from its own first sample.
  assert.equal(
    longestBadRunMs(samples, (p) => p.value < 0.97),
    15_000
  )
  // Twelve bad samples at 5 s reach a 60 s `forSeconds` gate.
  const twelveSlow = Array.from({ length: 13 }, (_, i) => ({
    atMs: i * 5000,
    value: i === 0 ? 1 : 0.9
  }))
  assert.equal(
    longestBadRunMs(twelveSlow, (p) => p.value < 0.97),
    60_000
  )
  // Samples without a speed are a gap, not good time: one bad sample after
  // a minute of missing measurements is not a minute of slow encoding.
  const gapped = [
    { atMs: 0, value: 1 },
    ...Array.from({ length: 11 }, (_, i) => ({ atMs: (i + 1) * 5000, value: null })),
    { atMs: 60_000, value: 0.9 }
  ]
  assert.equal(
    longestBadRunMs(
      gapped,
      (p) => p.value < 0.97,
      (p) => p.value !== null
    ),
    0
  )
  // A series that opens bad starts its run at the first bad sample.
  assert.equal(
    longestBadRunMs([{ atMs: 0, value: 0.9 }], (p) => p.value < 0.97),
    0
  )
  const journal = Array.from({ length: 13 }, (_, i) => ({
    kind: 'sample',
    tsMs: i * 30_000,
    legs: [{ targetId: 'yt', droppedFrames: i >= 6 ? 90 : 0, fps: 30, state: 'live' }]
  }))
  const windows = droppedFrameWindows(journal, 300_000)
  assert.ok(windows.length > 0)
  assert.ok(Math.max(...windows.map((w) => w.percent)) > 0.5)
  assert.equal(Math.round(slopePerIndex([1, 2, 3, 4])), 1)
  assert.equal(slopePerIndex([5]), 0)
})

test('thresholds v1 load in report mode with plan 166 values', async () => {
  const thresholds = await loadThresholds()
  assert.equal(thresholds.mode, 'report')
  assert.equal(thresholds.leak.mbPerHourByRole['electron-renderer'], 30)
  assert.equal(thresholds.encoderSpeed.min, 0.97)
  assert.equal(thresholds.bitrate.minFractionOfTarget, 0.7)
  assert.equal(thresholds.droppedFrames.maxPercent, 0.5)
})

test('clean fixture: pass, no incidents, clips skipped (clipPull off), VOD known', async () => {
  const dir = await fixtureCopy('clean')
  try {
    const { verdict, written } = await finalizeRunFolder({ runDir: dir })
    assert.equal(verdict.outcome, 'pass')
    assert.deepEqual(verdict.incidents, [])
    for (const key of CONTRACT_KEYS) assert.ok(key in verdict, `contract key ${key}`)
    assert.equal(verdict.schema, 1)
    assert.equal(verdict.thresholdsMode, 'report')
    assert.equal(byId(verdict, 'clips').status, 'skipped')
    assert.match(byId(verdict, 'clips').summary, /clipPull off/)
    assert.equal(byId(verdict, 'stream:noData-while-live').status, 'pass')
    assert.equal(byId(verdict, 'steps').status, 'pass')
    assert.equal(
      byId(verdict, 'leak:electron-renderer').status,
      'skipped',
      'an 11 min run is too short to judge leaks'
    )
    assert.equal(byId(verdict, 'stream:bitrate').status, 'pass')
    assert.equal(byId(verdict, 'stream:start-latency').value, 5800)
    assert.deepEqual(verdict.vod, {
      videoId: 'fixtVideo01A',
      url: 'https://www.youtube.com/watch?v=fixtVideo01A'
    })
    assert.deepEqual(verdict.quota, { labUnits: 36, bundledUnits: 0 })
    assert.equal(verdict.build.sha, 'abc1234def56')
    assert.deepEqual(verdict.steps, { total: 12, passed: 10, failed: 0, skipped: 2, stopped: 0 })
    assert.ok(written.some((path) => path.endsWith('verdict.json')))
    assert.ok(written.some((path) => path.endsWith('report.md')))
    const charts = await readdir(join(dir, 'charts'))
    assert.ok(charts.includes('rss-electron-renderer.png'))
    assert.ok(charts.includes('bitrate.png'))
    assert.ok(charts.includes('youtube-health.png'))
    const report = await readFile(join(dir, 'report.md'), 'utf8')
    assert.match(report, /Outcome: PASS/)
    assert.match(report, /charts\/bitrate\.png/)
    assert.deepEqual(findSensitive(report), [])
    const onDisk = JSON.parse(await readFile(join(dir, 'verdict.json'), 'utf8'))
    assert.equal(onDisk.runId, verdict.runId)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dead leg while On air: a P0 stream:noData-while-live incident fails the run', async () => {
  const dir = await fixtureCopy('dead-leg')
  try {
    const { verdict } = await finalizeRunFolder({ runDir: dir })
    assert.equal(verdict.outcome, 'fail')
    const noData = byId(verdict, 'stream:noData-while-live')
    assert.equal(noData.status, 'fail')
    assert.equal(noData.severity, 'P0')
    const incident = verdict.incidents.find(
      (entry) => entry.signature === 'stream:noData-while-live'
    )
    assert.ok(incident)
    assert.equal(incident.severity, 'P0')
    assert.equal(incident.firstAt, '2026-10-12T06:08:30.000Z')
    assert.ok(verdict.incidents.some((entry) => entry.signature === 'step:marathon'))
    const report = await readFile(join(dir, 'report.md'), 'utf8')
    assert.match(report, /## Incidents/)
    assert.match(report, /stream:noData-while-live/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chat message never arrives: chat:message-missing plus the failed step', async () => {
  const dir = await fixtureCopy('chat-missing')
  try {
    const { verdict } = await finalizeRunFolder({ runDir: dir })
    assert.equal(verdict.outcome, 'fail')
    const delivery = byId(verdict, 'chat:delivery')
    assert.equal(delivery.status, 'fail')
    assert.equal(delivery.value, 13)
    assert.equal(delivery.threshold, 14)
    assert.match(delivery.summary, /long/)
    assert.deepEqual(verdict.incidents.map((entry) => entry.signature).sort(), [
      'chat:message-missing',
      'step:chat-arrival'
    ])
    assert.equal(byId(verdict, 'chat:latency').status, 'pass')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('highlight card missing from frames: frame check fails, scene check passes, needs-eyes carries a frame', async () => {
  const dir = await fixtureCopy('highlight-missing')
  try {
    const W = 640
    const H = 360
    const base = renderMarkerFrame({ width: W, height: H, sceneId: 1, stepIndex: 1 })
    const scene2 = renderMarkerFrame({ width: W, height: H, sceneId: 2, stepIndex: 7 })
    // The clip starts at 06:02:00; the scene switch is at +30 s, the highlight at +60 s.
    const frameChecks = (options) =>
      runFrameChecks({
        ...options,
        exists: () => true,
        extract: async ({ atSeconds }) => (atSeconds >= 31 && atSeconds <= 36 ? scene2 : base)
      })
    const { verdict } = await finalizeRunFolder({ runDir: dir, frameChecks })
    assert.equal(verdict.outcome, 'fail')
    assert.equal(byId(verdict, 'frames:scene-screen-camera').status, 'pass')
    const highlight = byId(verdict, 'frames:comment-highlight')
    assert.equal(highlight.status, 'fail')
    assert.match(highlight.summary, /highlight missing from frames/)
    assert.deepEqual(highlight.evidence, [
      'frames/comment-highlight-plus2s.png',
      'frames/comment-highlight-plus5s.png',
      'frames/comment-highlight-baseline.png'
    ])
    assert.ok(verdict.incidents.some((entry) => entry.signature === 'frames:highlight-missing'))
    const eyes = verdict.needsEyes.find((entry) => entry.id === 'highlight-card-look')
    assert.equal(eyes.frame, 'frames/comment-highlight-plus2s.png')
    assert.deepEqual(verdict.frameChecks, { total: 2, passed: 1, failed: 1, needsEyes: 0 })
    const frames = await readdir(join(dir, 'frames'))
    assert.equal(frames.length, 3)
    assert.equal(byId(verdict, 'clips').status, 'pass')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without clips the same run is needs-eyes, never a failure', async () => {
  const dir = await fixtureCopy('highlight-missing')
  try {
    await rm(join(dir, 'clips'), { recursive: true, force: true })
    const { verdict } = await verdictForRun(dir)
    assert.ok(['pass', 'warn'].includes(verdict.outcome))
    assert.equal(byId(verdict, 'frames:comment-highlight').status, 'needs-eyes')
    assert.ok(verdict.needsEyes.some((entry) => entry.id === 'frame:comment-highlight'))
    assert.equal(byId(verdict, 'clips').status, 'skipped')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a reconnect gap ends a slow or low-bitrate run instead of counting toward it', async () => {
  const dir = await fixtureCopy('clean')
  try {
    const run = await readRunFolder(dir)
    const thresholds = await loadThresholds()
    const T0 = Date.parse('2026-10-12T06:00:00.000Z')
    const leg = (state, speed, bitrateKbps) => ({ targetId: 'yt', state, speed, bitrateKbps })
    const good = { kind: 'sample', tsMs: T0, legs: [leg('live', 1, 6000)] }
    const bad = { kind: 'sample', tsMs: T0 + 65_000, legs: [leg('live', 0.5, 100)] }
    const reconnecting = Array.from({ length: 12 }, (_, i) => ({
      kind: 'sample',
      tsMs: T0 + (i + 1) * 5000,
      legs: [leg('reconnecting', undefined, 0)]
    }))
    const verdictFor = async (journal) =>
      (await computeVerdict({ ...run, journal }, thresholds, { runFrames: false })).verdict
    // One bad live sample after a minute of reconnecting is not a minute of
    // slow encoding or low bitrate.
    const gapped = await verdictFor([good, ...reconnecting, bad])
    assert.equal(byId(gapped, 'stream:encoder-speed').status, 'pass')
    assert.equal(byId(gapped, 'stream:bitrate').status, 'pass')
    // Control: with no samples between them, the same two samples are a run.
    const unbroken = await verdictFor([good, bad])
    assert.equal(byId(unbroken, 'stream:encoder-speed').status, 'warn')
    assert.equal(byId(unbroken, 'stream:bitrate').status, 'warn')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a synthetic renderer leak over a long run warns in report mode and fails in gate mode', async () => {
  const dir = await fixtureCopy('clean')
  try {
    const run = await readRunFolder(dir)
    const T0 = Date.parse('2026-10-12T06:00:00.000Z')
    const census = []
    for (let minute = 0; minute <= 180; minute += 1) {
      census.push({
        atMs: T0 + minute * 60_000,
        roles: { backend: 300_000, 'electron-renderer': 400_000 + minute * 1024 },
        totalKb: 700_000 + minute * 1024
      })
    }
    const thresholds = await loadThresholds()
    const { verdict } = await computeVerdict({ ...run, census }, thresholds, { runFrames: false })
    const renderer = byId(verdict, 'leak:electron-renderer')
    assert.equal(renderer.status, 'warn', renderer.summary)
    assert.equal(renderer.signature, 'leak:renderer'.replace('renderer', 'electron-renderer'))
    assert.ok(renderer.value > 50, `about 60 MB/h, got ${renderer.value}`)
    assert.equal(byId(verdict, 'leak:backend').status, 'pass')
    assert.equal(verdict.outcome, 'warn')
    assert.ok(verdict.incidents.some((entry) => entry.signature === 'leak:electron-renderer'))
    const gated = await computeVerdict(
      { ...run, census },
      { ...thresholds, mode: 'gate' },
      { runFrames: false }
    )
    assert.equal(byId(gated.verdict, 'leak:electron-renderer').status, 'fail')
    assert.equal(gated.verdict.outcome, 'fail')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('crash evidence, preview downgrade, host overload and a stopped run', async () => {
  const dir = await fixtureCopy('clean')
  try {
    const run = await readRunFolder(dir)
    const thresholds = await loadThresholds()
    const journal = run.journal.map((line, index) =>
      index === 5 ? { ...line, previewFallbackReason: 'metal-unavailable' } : line
    )
    const health = [
      ...run.health,
      { ts: '2026-10-12T06:04:00.000Z', source: 'backend', code: 'host-overloaded', level: 'warn' },
      {
        ts: '2026-10-12T06:05:00.000Z',
        source: 'backend',
        code: 'stream-target-reconnecting',
        level: 'warn'
      }
    ]
    const manifest = {
      ...run.manifest,
      outcome: 'stopped',
      stopReason: 'control.json says enabled: false'
    }
    const { verdict } = await computeVerdict(
      {
        ...run,
        journal,
        health,
        manifest,
        crashFiles: ['videorc-backend-2026-10-12-060300.ips', 'crashpad-abc.dmp']
      },
      thresholds,
      { runFrames: false }
    )
    assert.equal(byId(verdict, 'preview:downgrade').status, 'warn')
    assert.equal(
      byId(verdict, 'preview:downgrade').signature,
      'preview:downgrade:metal-unavailable'
    )
    assert.equal(byId(verdict, 'host:overloaded').status, 'warn')
    assert.equal(byId(verdict, 'destination:stream-target-reconnecting').status, 'warn')
    assert.equal(byId(verdict, 'crash:videorc-backend').status, 'fail')
    assert.equal(byId(verdict, 'crash:videorc-backend').severity, 'P1')
    assert.equal(byId(verdict, 'crash:electron').status, 'fail')
    assert.equal(verdict.outcome, 'fail', 'a crash beats stopped')
    assert.equal(verdict.stopReason, 'control.json says enabled: false')

    const stoppedOnly = await computeVerdict({ ...run, manifest }, thresholds, { runFrames: false })
    assert.equal(stoppedOnly.verdict.outcome, 'stopped')

    const faults = await computeVerdict(
      { ...run, health, manifest: { ...run.manifest, scenario: 'faults' } },
      thresholds,
      { runFrames: false }
    )
    assert.equal(byId(faults.verdict, 'destination:stream-target-reconnecting').status, 'pass')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renderReport never leaks and lists signals, incidents and the owner digest', () => {
  const report = renderReport({
    runId: 'r',
    scenario: 'chat',
    trigger: 'manual',
    privacy: 'unlisted',
    build: { source: 'release', version: '0.9.142', sha: 'abc1234' },
    startedAt: 'a',
    endedAt: 'b',
    outcome: 'warn',
    thresholdsMode: 'report',
    thresholdsVersion: 1,
    steps: { total: 3, passed: 2, failed: 0, skipped: 1 },
    quota: { labUnits: 1, bundledUnits: 0 },
    vod: null,
    signals: [
      {
        id: 'x',
        status: 'warn',
        summary: 's | with pipe',
        value: 1,
        threshold: 2,
        unit: 'MB',
        evidence: ['census.csv']
      }
    ],
    incidents: [
      { signature: 'leak:x', severity: 'P1', summary: 'grew', firstAt: 'a', evidence: [] }
    ],
    needsEyes: [{ id: 'q', question: 'Looks right?', frame: 'frames/q.png' }]
  })
  assert.match(report, /\| WARN \| x \| 1 MB \| 2 MB \| s \\\| with pipe/)
  assert.match(report, /## Owner digest/)
  assert.match(report, /\[frame\]\(frames\/q\.png\)/)
  assert.match(report, /VOD \| unknown/)
  assert.deepEqual(findSensitive(report), [])
})
