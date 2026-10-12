import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LEDGER_FILE,
  QUOTA_COSTS,
  QuotaRefused,
  costOf,
  createQuotaLedger,
  pacificDay
} from './quota-ledger.mjs'

// The live lab runs on macOS only (launchd, pf, codesign, POSIX paths and modes).
const macOnly = { skip: process.platform === 'win32' && 'the live lab runs on macOS only' }

async function withDir(work) {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-quota-ledger-'))
  try {
    await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('documented costs: writes 50, lists 1, unknown methods refuse', () => {
  for (const method of [
    'liveBroadcasts.insert',
    'liveBroadcasts.bind',
    'liveBroadcasts.transition',
    'liveChatMessages.insert',
    'liveChatMessages.delete',
    'videos.update'
  ]) {
    assert.equal(costOf(method), 50, method)
  }
  for (const method of [
    'liveBroadcasts.list',
    'liveStreams.list',
    'videos.list',
    'liveChatMessages.list',
    'channels.list'
  ]) {
    assert.equal(costOf(method), 1, method)
  }
  assert.throws(() => costOf('search.list'), /Unknown YouTube Data API method/)
  assert.ok(Object.isFrozen(QUOTA_COSTS))
})

test('Pacific day follows midnight Pacific, across DST', () => {
  // 07:59 UTC on a PDT day is 00:59 Pacific: still that day.
  assert.equal(pacificDay(new Date('2026-07-01T07:59:00Z')), '2026-07-01')
  assert.equal(pacificDay(new Date('2026-07-01T06:59:00Z')), '2026-06-30')
  // PST (UTC-8) in winter.
  assert.equal(pacificDay(new Date('2026-12-01T07:59:00Z')), '2026-11-30')
  assert.equal(pacificDay(new Date('2026-12-01T08:00:00Z')), '2026-12-01')
})

test('charges persist per day in a 0600 file and refuse past the cap', macOnly, async () => {
  await withDir(async (dir) => {
    let clock = new Date('2026-10-12T15:00:00Z')
    const ledger = createQuotaLedger({ dir, maxUnitsPerDay: 120, now: () => clock })
    assert.deepEqual(ledger.charge('liveStreams.list'), {
      method: 'liveStreams.list',
      units: 1,
      day: '2026-10-12',
      spent: 1,
      remaining: 119
    })
    ledger.charge('liveChatMessages.insert', 2)
    assert.equal(ledger.today().units, 101)
    assert.equal(ledger.canSpend(19), true)
    assert.equal(ledger.canSpend(20), false)

    const fileMode = (await stat(join(dir, LEDGER_FILE))).mode & 0o777
    assert.equal(fileMode, 0o600)

    // A second ledger over the same dir sees the same day (persisted).
    const reopened = createQuotaLedger({ dir, maxUnitsPerDay: 120, now: () => clock })
    assert.deepEqual(reopened.today().calls['liveChatMessages.insert'], { calls: 2, units: 100 })

    assert.throws(
      () => reopened.charge('liveChatMessages.delete'),
      (error) =>
        error instanceof QuotaRefused &&
        error.code === 'QUOTA_REFUSED' &&
        error.units === 50 &&
        error.spent === 101 &&
        error.max === 120
    )
    // A refused charge is not recorded.
    assert.equal(reopened.today().units, 101)

    // Midnight Pacific resets the day.
    clock = new Date('2026-10-13T07:00:01Z')
    assert.equal(reopened.today().day, '2026-10-13')
    assert.equal(reopened.today().units, 0)
    reopened.charge('liveChatMessages.delete')
    const saved = JSON.parse(await readFile(join(dir, LEDGER_FILE), 'utf8'))
    assert.deepEqual(Object.keys(saved.days).sort(), ['2026-10-12', '2026-10-13'])
  })
})

test('default cap is 8000 units a day', async () => {
  await withDir(async (dir) => {
    const ledger = createQuotaLedger({ dir, now: () => new Date('2026-10-12T15:00:00Z') })
    assert.equal(ledger.today().max, 8000)
    ledger.charge('liveChatMessages.insert', 160)
    assert.equal(ledger.today().remaining, 0)
    assert.throws(() => ledger.charge('videos.list'), QuotaRefused)
  })
})

test('keeps only the last 14 days', async () => {
  await withDir(async (dir) => {
    let clock = new Date('2026-10-01T15:00:00Z')
    const ledger = createQuotaLedger({ dir, now: () => clock })
    for (let day = 0; day < 20; day += 1) {
      clock = new Date(Date.UTC(2026, 9, 1 + day, 15))
      ledger.charge('videos.list')
    }
    const saved = JSON.parse(await readFile(join(dir, LEDGER_FILE), 'utf8'))
    assert.equal(Object.keys(saved.days).length, 14)
    assert.equal(Object.keys(saved.days).sort()[0], '2026-10-07')
  })
})

test('a corrupt ledger fails closed instead of reading as zero', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, LEDGER_FILE), '{nope', 'utf8')
    const ledger = createQuotaLedger({ dir })
    assert.throws(() => ledger.charge('videos.list'), /not valid JSON/)
    assert.throws(() => ledger.today(), /not valid JSON/)
  })
})
