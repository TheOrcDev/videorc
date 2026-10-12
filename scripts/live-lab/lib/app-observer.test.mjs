import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  censusCsvRows,
  createAppObserver,
  createJournalTail,
  flattenHealthEvents,
  healthRecordFromEvent,
  journalDirCandidates,
  memoryFromCensus,
  parseJournalLine
} from './app-observer.mjs'
import { createFakeClock } from './harness-test-fakes.mjs'
import { createEventBus } from './step-engine.mjs'

// The live lab runs on macOS only (launchd, pf, codesign, POSIX paths and modes).
const macOnly = { skip: process.platform === 'win32' && 'the live lab runs on macOS only' }

const FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'protocol-fixtures',
  'metrics-journal-v1.ndjson'
)

test('every line of the U1 schema v1 fixture parses', async () => {
  const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n')
  assert.ok(lines.length >= 3)
  for (const text of lines) {
    const line = parseJournalLine(text)
    assert.ok(line, text.slice(0, 80))
    assert.equal(line.schemaVersion, 1)
    assert.ok(['sample', 'health'].includes(line.kind))
    assert.ok(Number.isFinite(line.tsMs))
  }
  const health = lines.map(parseJournalLine).find((line) => line.kind === 'health')
  assert.deepEqual(health.healthEventCodes, ['stream-leg-reconnecting'])
  assert.equal(health.healthLevel, 'warn')
  assert.equal(health.legs[1].bitrateKbps, null)
})

test('the parser is tolerant and keeps only allowlisted fields', () => {
  assert.equal(parseJournalLine('not json'), null)
  assert.equal(parseJournalLine('[1,2]'), null)
  assert.equal(parseJournalLine('{"schemaVersion":2,"ts":"2026-10-12T10:00:00.000Z"}'), null)
  assert.equal(parseJournalLine('{"schemaVersion":1}'), null, 'no ts')
  const line = parseJournalLine(
    JSON.stringify({
      schemaVersion: 1,
      ts: '2026-10-12T10:00:00.000Z',
      state: 'weird',
      streamUrl: 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop',
      legs: [{ targetId: 'youtube', bitrateKbps: 'fast', extra: 1 }],
      healthEventCodes: ['ok-code', 'Bad Code With Spaces', 42]
    })
  )
  assert.equal(line.state, null)
  assert.equal(line.legs[0].bitrateKbps, null)
  assert.equal(line.legs[0].extra, undefined)
  assert.deepEqual(line.healthEventCodes, ['ok-code'])
  assert.ok(!JSON.stringify(line).includes('rtmp://'))
})

test('journal dirs: <userData>/logs/metrics first, then beside the database', macOnly, () => {
  assert.deepEqual(
    journalDirCandidates({
      userDataDir: '/p/user-data',
      databasePath: '/p/app-data/videorc.sqlite3'
    }),
    ['/p/user-data/logs/metrics', '/p/app-data/logs/metrics']
  )
})

test('the tail reads appended lines, a late file, and rolls over at UTC midnight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-journal-'))
  const clock = createFakeClock(Date.parse('2026-10-12T23:59:58.000Z'))
  const seen = []
  const tail = createJournalTail({
    dirs: [join(dir, 'missing'), dir],
    onLine: (line) => seen.push(line.ts),
    clock
  })
  await tail.poll()
  assert.deepEqual(seen, [], 'no file yet')
  const line = (ts) =>
    `${JSON.stringify({ schemaVersion: 1, kind: 'sample', ts, state: 'live', legs: [] })}\n`
  await writeFile(join(dir, '2026-10-12.ndjson'), line('2026-10-12T23:59:55.000Z'))
  await tail.poll()
  await appendFile(join(dir, '2026-10-12.ndjson'), line('2026-10-12T23:59:59.000Z').slice(0, 20))
  await tail.poll()
  await appendFile(join(dir, '2026-10-12.ndjson'), line('2026-10-12T23:59:59.000Z').slice(20))
  await tail.poll()
  await writeFile(join(dir, '2026-10-13.ndjson'), line('2026-10-13T00:00:04.000Z'))
  await clock.advance(10_000)
  await tail.poll()
  assert.deepEqual(seen, [
    '2026-10-12T23:59:55.000Z',
    '2026-10-12T23:59:59.000Z',
    '2026-10-13T00:00:04.000Z'
  ])
})

test('census memory per card role and CSV rows without args', () => {
  const census = {
    processRows: [
      { pid: 10, ppid: 1, role: 'electron-main', rssKb: 200 * 1024, args: '/Users/someone/secret' },
      { pid: 11, ppid: 10, role: 'electron-renderer', rssKb: 300 * 1024 },
      { pid: 12, ppid: 10, role: 'electron-renderer-comments', rssKb: 100 * 1024 },
      { pid: 13, ppid: 10, role: 'backend', rssKb: 400 * 1024 },
      { pid: 14, ppid: 13, role: 'ffmpeg', rssKb: 150 * 1024 },
      { pid: 15, ppid: 10, role: 'other', rssKb: 5 }
    ]
  }
  assert.deepEqual(memoryFromCensus(census), {
    main: 200,
    renderer: 400,
    backend: 400,
    ffmpeg: 150
  })
  const csv = censusCsvRows(census, 'T')
  assert.ok(csv.startsWith('T,10,1,electron-main,204800\n'))
  assert.ok(!csv.includes('/Users/'))
})

test('health events from both feeds flatten to { code, at } and dedupe', () => {
  const backend = healthRecordFromEvent({
    event: 'health.event',
    payload: {
      id: 'h1',
      code: 'stream-target-reconnecting',
      level: 'warn',
      message: 'rtmp://secret',
      createdAt: '2026-10-12T10:00:07.250Z'
    }
  })
  assert.deepEqual(backend, {
    ts: '2026-10-12T10:00:07.250Z',
    source: 'backend',
    code: 'stream-target-reconnecting',
    level: 'warn',
    sessionId: null
  })
  assert.equal(healthRecordFromEvent({ event: 'stream.health', payload: {} }), null)
  const flat = flattenHealthEvents([
    backend,
    {
      ts: '2026-10-12T10:00:07.400Z',
      source: 'journal',
      codes: ['stream-target-reconnecting'],
      level: 'warn'
    },
    {
      ts: '2026-10-12T10:00:20.000Z',
      source: 'journal',
      codes: ['stream-target-resumed'],
      level: 'info'
    }
  ])
  assert.deepEqual(
    flat.map(({ code, at }) => ({ code, at })),
    [
      { code: 'stream-target-reconnecting', at: Date.parse('2026-10-12T10:00:07.250Z') },
      { code: 'stream-target-resumed', at: Date.parse('2026-10-12T10:00:20.000Z') }
    ]
  )
})

test('the observer writes evidence, emits bus events and pushes the card', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'videorc-observer-run-'))
  const journalDir = await mkdtemp(join(tmpdir(), 'videorc-observer-journal-'))
  const clock = createFakeClock(Date.parse('2026-10-12T10:00:00.000Z'))
  const bus = createEventBus()
  const pushes = []
  const types = []
  bus.on((type) => types.push(type))
  await writeFile(join(journalDir, '2026-10-12.ndjson'), await readFile(FIXTURE, 'utf8'))
  const observer = createAppObserver({
    bus,
    card: { push: (snapshot) => pushes.push(snapshot) },
    runDir,
    journalDirs: [journalDir],
    ledgerPaths: async () => ['/ledger.json'],
    rootPid: async () => 4321,
    clock,
    collectCensus: async ({ rootPid }) => ({
      rootPid,
      summary: {},
      aliveRecords: [],
      processRows: [{ pid: 4321, ppid: 1, role: 'electron-main', rssKb: 102400 }]
    })
  })
  await observer.start()
  observer.onBackendMessage({
    event: 'health.event',
    payload: { code: 'host-overloaded', level: 'warn', createdAt: '2026-10-12T10:00:30.000Z' }
  })
  await clock.advance(10_000)
  observer.stop()
  assert.ok(observer.journalLines().length >= 3)
  assert.equal(observer.latestJournal().kind, 'sample')
  assert.ok(observer.healthEventsFlat().some((event) => event.code === 'host-overloaded'))
  assert.deepEqual(observer.incidents(), [])
  assert.ok(types.includes('journal') && types.includes('health') && types.includes('census'))
  assert.ok(
    pushes.some((snapshot) => snapshot.memoryMb?.main === 100 && snapshot.memoryMb?.backend === 300)
  )
  await new Promise((resolve) => setImmediate(resolve))
  const census = await readFile(join(runDir, 'census.csv'), 'utf8')
  assert.ok(census.startsWith('ts,pid,ppid,role,rssKb\n'))
  const journal = (await readFile(join(runDir, 'journal.ndjson'), 'utf8')).trim().split('\n')
  assert.ok(journal.length >= 3)
  assert.equal(JSON.parse(journal[0]).tsMs, undefined)
  assert.ok((await readFile(join(runDir, 'health.ndjson'), 'utf8')).includes('host-overloaded'))
})
