import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { planTick, upcomingSlots } from './schedule-plan.mjs'
import {
  DEFAULT_SCHEDULE_PATH,
  loadScheduleTable,
  validateScheduleTable
} from './schedule-table.mjs'
import { addDays, localDate, zonedInstant } from './schedule-time.mjs'

const MADRID = 'Europe/Madrid'

function d9() {
  return validateScheduleTable({
    version: 1,
    graceMinutes: 15,
    slots: [
      { id: 'update-check', at: '04:00', action: 'update-check' },
      { id: 'churn', at: '04:30', action: 'run', scenario: 'churn' },
      {
        id: 'marathon',
        at: '06:00',
        action: 'run',
        scenario: 'marathon',
        params: { marathonHours: 4 }
      },
      { id: 'idle', at: '11:00', action: 'run', scenario: 'idle' },
      { id: 'report', at: '13:30', action: 'report', graceMinutes: 360 }
    ]
  }).table
}

// The schedule started long ago, so yesterday's windows count too.
const OLD = { version: 1, since: '2026-01-01T00:00:00.000Z', days: {}, history: [] }

function ids(windows) {
  return windows.map((window) => `${window.date} ${window.slot.id}`)
}

test('the committed schedule.json is D9 and validates', async () => {
  const loaded = await loadScheduleTable()
  assert.deepEqual(loaded.problems, [])
  assert.equal(loaded.path, DEFAULT_SCHEDULE_PATH)
  assert.deepEqual(
    loaded.table.slots.map((slot) => [slot.id, slot.at, slot.action, slot.scenario ?? null]),
    [
      ['update-check', '04:00', 'update-check', null],
      ['churn', '04:30', 'run', 'churn'],
      ['marathon', '06:00', 'run', 'marathon'],
      ['idle', '11:00', 'run', 'idle'],
      ['report', '13:30', 'report', null]
    ]
  )
  assert.equal(loaded.table.graceMinutes, 15)
  assert.deepEqual(loaded.table.slots[2].params, { marathonHours: 4 })
  const raw = JSON.parse(await readFile(DEFAULT_SCHEDULE_PATH, 'utf8'))
  assert.match(raw.weeklyReboot.note, /pmset repeat restart U 03:30:00/)
})

test('a bad table is refused whole, with every problem', async () => {
  const { table, problems } = validateScheduleTable({
    version: 2,
    slots: [
      { id: 'churn', at: '4:30', action: 'run' },
      { id: 'churn', at: '05:00', action: 'stream', extra: true },
      { id: 'report', at: '13:30', action: 'report', scenario: 'x', graceMinutes: 0 }
    ]
  })
  assert.equal(table, null)
  for (const expected of [
    /version must be 1/,
    /slots\[0\]\.at must be HH:MM/,
    /slots\[0\]\.scenario must name a scenario/,
    /"churn" is used twice/,
    /slots\[1\] has unknown field "extra"/,
    /slots\[1\]\.action must be one of/,
    /slots\[2\]\.scenario only applies/,
    /slots\[2\]\.graceMinutes/
  ]) {
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${expected} in ${problems}`
    )
  }
  const broken = await loadScheduleTable({ read: async () => '{' })
  assert.equal(broken.table, null)
  assert.match(broken.problems[0], /not valid JSON/)
})

test('zonedInstant follows Madrid summer and winter time', () => {
  assert.equal(
    zonedInstant('2026-10-12', '04:30', MADRID).toISOString(),
    '2026-10-12T02:30:00.000Z'
  )
  assert.equal(
    zonedInstant('2026-10-26', '04:30', MADRID).toISOString(),
    '2026-10-26T03:30:00.000Z'
  )
  assert.equal(
    zonedInstant('2026-01-15', '13:30', MADRID).toISOString(),
    '2026-01-15T12:30:00.000Z'
  )
})

test('zonedInstant on the DST change days: after-change slots, gap and repeated hour', () => {
  // 2026-10-25: Madrid falls back 03:00 CEST -> 02:00 CET. 04:30 is CET.
  assert.equal(
    zonedInstant('2026-10-25', '04:30', MADRID).toISOString(),
    '2026-10-25T03:30:00.000Z'
  )
  // 02:30 happens twice that night: the first (CEST) one wins.
  assert.equal(
    zonedInstant('2026-10-25', '02:30', MADRID).toISOString(),
    '2026-10-25T00:30:00.000Z'
  )
  // 2026-03-29: Madrid springs forward 02:00 CET -> 03:00 CEST. 04:30 is CEST.
  assert.equal(
    zonedInstant('2026-03-29', '04:30', MADRID).toISOString(),
    '2026-03-29T02:30:00.000Z'
  )
  // 02:30 does not exist: it moves forward by the gap, to 03:30 CEST.
  assert.equal(
    zonedInstant('2026-03-29', '02:30', MADRID).toISOString(),
    '2026-03-29T01:30:00.000Z'
  )
  // Other zones.
  assert.equal(
    zonedInstant('2026-11-01', '01:30', 'America/New_York').toISOString(),
    '2026-11-01T05:30:00.000Z'
  )
  assert.equal(
    zonedInstant('2026-07-01', '04:00', 'Asia/Tokyo').toISOString(),
    '2026-06-30T19:00:00.000Z'
  )
  assert.equal(zonedInstant('2026-07-01', '04:00', 'UTC').toISOString(), '2026-07-01T04:00:00.000Z')
})

test('localDate and addDays cross midnight and month ends', () => {
  assert.equal(localDate(new Date('2026-10-11T22:30:00Z'), MADRID), '2026-10-12')
  assert.equal(localDate(new Date('2026-10-11T22:30:00Z'), 'UTC'), '2026-10-11')
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('a slot is due from its start through start + grace, inclusive', () => {
  const table = d9()
  const at = (iso) => planTick({ table, state: OLD, now: new Date(iso), timeZone: MADRID })
  // 04:30 CEST = 02:30Z.
  assert.deepEqual(ids(at('2026-10-12T02:30:00.000Z').due), ['2026-10-12 churn'])
  assert.deepEqual(ids(at('2026-10-12T02:45:00.000Z').due), ['2026-10-12 churn'])
  const late = at('2026-10-12T02:45:00.001Z')
  assert.deepEqual(ids(late.due), [])
  assert.ok(ids(late.missed).includes('2026-10-12 churn'))
  assert.deepEqual(ids(at('2026-10-12T02:29:59.999Z').due), [])
})

test('missed windows are listed once each and never become due', () => {
  const table = d9()
  // 07:00 CEST: update-check, churn and marathon all closed unrun today; all
  // of yesterday's closed too (report's 6 h grace ended 19:30).
  const plan = planTick({
    table,
    state: OLD,
    now: new Date('2026-10-12T05:00:00Z'),
    timeZone: MADRID
  })
  assert.deepEqual(plan.due, [])
  assert.deepEqual(ids(plan.missed), [
    '2026-10-11 update-check',
    '2026-10-11 churn',
    '2026-10-11 marathon',
    '2026-10-11 idle',
    '2026-10-11 report',
    '2026-10-12 update-check',
    '2026-10-12 churn',
    '2026-10-12 marathon'
  ])
  assert.deepEqual(ids(plan.upcoming), ['2026-10-12 idle', '2026-10-12 report'])
  assert.equal(plan.missed[0].reason, 'no tick ran inside the window')
})

test('windows that closed before the first tick are not missed', () => {
  const state = { version: 1, since: '2026-10-12T04:55:00.000Z', days: {}, history: [] }
  const plan = planTick({
    table: d9(),
    state,
    now: new Date('2026-10-12T05:00:00Z'),
    timeZone: MADRID
  })
  assert.deepEqual(ids(plan.missed), [])
})

test('a final outcome closes the slot for the day; deferred-lock keeps it open', () => {
  const table = d9()
  const now = new Date('2026-10-12T02:35:00Z')
  const done = {
    ...OLD,
    days: { '2026-10-12': { churn: { status: 'refused', reason: 'STOP file present' } } }
  }
  assert.deepEqual(ids(planTick({ table, state: done, now, timeZone: MADRID }).due), [])

  const deferred = {
    ...OLD,
    days: {
      '2026-10-12': { churn: { status: 'deferred-lock', reason: 'run lock held (od-1, pid 7)' } }
    }
  }
  assert.deepEqual(ids(planTick({ table, state: deferred, now, timeZone: MADRID }).due), [
    '2026-10-12 churn'
  ])
  const closed = planTick({
    table,
    state: deferred,
    now: new Date('2026-10-12T02:46:00Z'),
    timeZone: MADRID
  })
  const churn = closed.missed.find(
    (window) => window.slot.id === 'churn' && window.date === '2026-10-12'
  )
  assert.match(churn.reason, /run lock was held \(run lock held \(od-1, pid 7\)\)/)
})

test('the same instant is due in one timezone and not another', () => {
  const table = d9()
  const now = new Date('2026-10-12T11:35:00Z')
  // 13:35 in Madrid: report is due. 04:35 in Los Angeles: churn is due.
  assert.deepEqual(ids(planTick({ table, state: OLD, now, timeZone: MADRID }).due), [
    '2026-10-12 report'
  ])
  assert.deepEqual(ids(planTick({ table, state: OLD, now, timeZone: 'America/Los_Angeles' }).due), [
    '2026-10-12 churn'
  ])
})

test('Madrid autumn change: churn is due at 04:30 CET, not an hour early', () => {
  const table = d9()
  const state = { ...OLD, days: { '2026-10-25': { 'update-check': { status: 'passed' } } } }
  // 02:35Z is 03:35 CET (after the change): with a summer offset churn would
  // wrongly be due now.
  assert.deepEqual(
    ids(planTick({ table, state, now: new Date('2026-10-25T02:35:00Z'), timeZone: MADRID }).due),
    []
  )
  assert.deepEqual(
    ids(planTick({ table, state, now: new Date('2026-10-25T03:31:00Z'), timeZone: MADRID }).due),
    ['2026-10-25 churn']
  )
})

test('Madrid spring change: churn is due at 04:30 CEST and missed an hour later', () => {
  const table = d9()
  const state = { ...OLD, days: { '2026-03-29': { 'update-check': { status: 'passed' } } } }
  assert.deepEqual(
    ids(planTick({ table, state, now: new Date('2026-03-29T02:31:00Z'), timeZone: MADRID }).due),
    ['2026-03-29 churn']
  )
  const later = planTick({ table, state, now: new Date('2026-03-29T03:31:00Z'), timeZone: MADRID })
  assert.deepEqual(ids(later.due), [])
  assert.ok(ids(later.missed).includes('2026-03-29 churn'))
})

test('a 02:30 slot on the spring-forward night runs once, at 03:30 CEST', () => {
  const { table } = validateScheduleTable({
    version: 1,
    slots: [{ id: 'night', at: '02:30', action: 'report' }]
  })
  const at = (iso) => ids(planTick({ table, state: OLD, now: new Date(iso), timeZone: MADRID }).due)
  assert.deepEqual(at('2026-03-29T00:35:00Z'), []) // 01:35 CET
  assert.deepEqual(at('2026-03-29T01:35:00Z'), ['2026-03-29 night']) // 03:35 CEST
})

test('upcomingSlots lists today and tomorrow with their outcome', () => {
  const state = { ...OLD, days: { '2026-10-12': { 'update-check': { status: 'passed' } } } }
  const rows = upcomingSlots({
    table: d9(),
    state,
    now: new Date('2026-10-12T02:35:00Z'),
    timeZone: MADRID
  })
  assert.equal(rows.length, 10)
  assert.deepEqual(
    rows.slice(0, 3).map((row) => [row.slot.id, row.when, row.entry?.status ?? null]),
    [
      ['update-check', 'past', 'passed'],
      ['churn', 'open', null],
      ['marathon', 'later', null]
    ]
  )
  assert.equal(rows[5].date, '2026-10-13')
})
