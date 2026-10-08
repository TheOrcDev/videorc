import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertFakeActivityTotals,
  probeCommentsTotals,
  waitForFakeActivityReceipts
} from './comments-totals-probe.mjs'

// ServerResponse::ok converts the actual persisted totals to serde_json::Value
// before websocket serialization. Its object keys arrive in this order; the
// ordered currency rows and every accounting value remain unchanged.
function fakeActivityWireTotals() {
  return JSON.parse(
    '{"bits":1800,"chatters":7,"follows":2,"messageCount":16,"raids":1,"status":"available","supporters":7,"tips":[{"amountMicros":5000000,"currency":"USD"},{"amountMicros":2000000,"currency":"EUR"}]}'
  )
}

test('normalized fake activity accounting accepts the actual RPC tip property order', () => {
  assert.doesNotThrow(() => assertFakeActivityTotals(fakeActivityWireTotals()))
})

test('normalized fake activity accounting accepts the equivalent fixture property order', () => {
  const totals = fakeActivityWireTotals()
  totals.tips = totals.tips.map(({ currency, amountMicros }) => ({ currency, amountMicros }))
  assert.doesNotThrow(() => assertFakeActivityTotals(totals))
})

for (const [field, value] of [
  ['status', 'legacy-unavailable'],
  ['messageCount', 15],
  ['supporters', 6],
  ['bits', 1799],
  ['follows', 1],
  ['raids', 0],
  ['chatters', 6]
]) {
  test(`normalized fake activity accounting refuses an incorrect ${field}`, () => {
    const totals = fakeActivityWireTotals()
    totals.tips = totals.tips.map(({ currency, amountMicros }) => ({ currency, amountMicros }))
    totals[field] = value
    assert.throws(() => assertFakeActivityTotals(totals), /accounting disagreed/)
  })
}

for (const [label, tips] of [
  [
    'amount',
    [
      { currency: 'USD', amountMicros: 4_999_999 },
      { currency: 'EUR', amountMicros: 2_000_000 }
    ]
  ],
  [
    'currency',
    [
      { currency: 'GBP', amountMicros: 5_000_000 },
      { currency: 'EUR', amountMicros: 2_000_000 }
    ]
  ],
  [
    'order',
    [
      { currency: 'EUR', amountMicros: 2_000_000 },
      { currency: 'USD', amountMicros: 5_000_000 }
    ]
  ],
  ['missing row', [{ currency: 'USD', amountMicros: 5_000_000 }]],
  [
    'extra row',
    [
      { currency: 'USD', amountMicros: 5_000_000 },
      { currency: 'EUR', amountMicros: 2_000_000 },
      { currency: 'GBP', amountMicros: 0 }
    ]
  ],
  [
    'extra property',
    [
      { currency: 'USD', amountMicros: 5_000_000, unexpected: true },
      { currency: 'EUR', amountMicros: 2_000_000 }
    ]
  ]
]) {
  test(`normalized fake activity accounting refuses an incorrect tip ${label}`, () => {
    const totals = fakeActivityWireTotals()
    totals.tips = tips
    assert.throws(() => assertFakeActivityTotals(totals), /accounting disagreed/)
  })
}

function harness(failPhase) {
  const calls = []
  let history = false
  let reopened = false
  const checks = []
  return {
    calls,
    checks,
    command: async (name, params = {}) => {
      calls.push({ name, params })
      if (name === 'comments-window-open') reopened = true
      if (params.mode?.kind === 'history') history = true
    },
    waitFor: async (read, predicate, deadline) => {
      assert.equal(deadline, 8000)
      const last = await read()
      return { ok: predicate(last), last }
    },
    layoutAt: async (width) => {
      assert.equal(width, 1280)
      const failed =
        failPhase === 'live' ||
        (failPhase === 'reopen' && reopened) ||
        (failPhase === 'history' && history)
      return {
        stats: [
          { id: 'supporters', text: failed ? '0' : '1' },
          { id: 'tips', text: '$20' },
          { id: 'chat', text: history ? '6,003' : '0' }
        ]
      }
    },
    assert: (ok, label) => checks.push({ ok, label }),
    sessionId: 'fixture-owner'
  }
}

test('maintained detached probe verifies reduced live/reopen/History accounting through existing commands', async () => {
  const fixture = harness()
  await probeCommentsTotals(fixture)
  assert.equal(fixture.checks.length, 3)
  assert.ok(fixture.checks.every((check) => check.ok))
  const snapshots = fixture.calls.filter((call) => call.name === 'comments-window-push-snapshot')
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[0].params.snapshot.messages.length, 2000)
  assert.ok(
    snapshots[0].params.snapshot.messages.every(
      (message) => message.platform === 'x' && !message.details
    )
  )
  const adoption = fixture.calls[0].params.delta.deliveryBoundary
  assert.equal(adoption.ownerId, snapshots[0].params.snapshot.delivery.ownerId)
  assert.equal(snapshots[1].params.mode.sessionId, 'fixture-owner')
  for (const call of fixture.calls.filter(
    (call) => call.name === 'comments-window-seed-dashboard'
  )) {
    assert.equal(call.params.state.chatTotals.sessionId, 'fixture-owner')
    assert.equal(call.params.state.chatTotals.messageCount, 6003)
  }
  assert.equal(fixture.calls.filter((call) => call.name === 'comments-window-close').length, 1)
  assert.equal(fixture.calls.filter((call) => call.name === 'comments-window-open').length, 1)
})

for (const phase of ['live', 'reopen', 'history'])
  test(`missing rendered ${phase} accounting refuses acceptance`, async () => {
    const fixture = harness(phase)
    await assert.rejects(probeCommentsTotals(fixture), /accounting observation failed/)
    assert.equal(fixture.checks.at(-1).ok, false)
  })

const activityKinds = [
  'subscription',
  'cheer',
  'raid',
  'follow',
  'super-chat',
  'super-sticker',
  'membership',
  'kicks',
  'watch-streak',
  'power-up',
  'redemption'
]

function activityReceipts(sessionId = 'owned-activity') {
  const destinations = {
    twitch: 'smoke-twitch-events',
    youtube: 'smoke-youtube-events',
    kick: 'smoke-kick-events'
  }
  return [
    ['twitch', 'fake-0'],
    ['youtube', 'fake-0'],
    ['kick', 'fake-0'],
    ['twitch', 'fake-event-resub', 'subscription'],
    ['twitch', 'fake-event-community-sub-gift', 'subscription'],
    ['twitch', 'fake-event-cheer', 'cheer'],
    ['twitch', 'fake-event-raid', 'raid'],
    ['kick', 'fake-event-channel.followed', 'follow'],
    ['kick', 'fake-event-kicks.gifted', 'kicks'],
    ['youtube', 'fake-event-super-chat', 'super-chat'],
    ['youtube', 'fake-event-super-sticker', 'super-sticker'],
    ['youtube', 'fake-event-membership', 'membership'],
    ['twitch', 'fake-event-watch-streak', 'watch-streak'],
    ['twitch', 'fake-event-follow', 'follow'],
    ['twitch', 'fake-event-channel.bits.use:power_up', 'power-up'],
    ['twitch', 'fake-event-channel.channel_points_custom_reward_redemption.add', 'redemption']
  ].map(([platform, providerMessageId, kind]) => ({
    id: `${sessionId}:${platform}:${destinations[platform]}:${providerMessageId}`,
    sessionId,
    platform,
    providerMessageId,
    details: kind ? { kind } : undefined
  }))
}

function controlledActivityDelivery(initial, final = []) {
  const eventMessages = []
  const delivered = Promise.withResolvers()
  const releaseFinal = Promise.withResolvers()
  const readiness = Promise.withResolvers()
  let pending = true
  let check
  let admissions = 0
  let waitArguments
  const owner = waitForFakeActivityReceipts({
    eventMessages,
    eventsSessionId: 'owned-activity',
    expectedKinds: activityKinds,
    timeoutMs: 90_000,
    waitFor: (predicate, timeoutMs, label) => {
      waitArguments = { timeoutMs, label }
      check = () => {
        if (pending && predicate()) {
          pending = false
          readiness.resolve()
        }
      }
      check()
      return readiness.promise
    }
  }).then(
    (rows) => {
      admissions += 1
      return { rows }
    },
    (error) => ({ error })
  )
  const producer = (async () => {
    eventMessages.push(...initial)
    check()
    delivered.resolve()
    await releaseFinal.promise
    eventMessages.push(...final)
    check()
  })()
  return {
    async observe() {
      await delivered.promise
      // If the actual readiness owner admitted this batch, await that outcome
      // before observing the next (totals) phase; pending owners stay held.
      if (!pending) await owner
      return { pending, admissions }
    },
    expire(error) {
      if (pending) {
        pending = false
        readiness.reject(error)
      }
    },
    async finish() {
      releaseFinal.resolve()
      await producer
      if (pending) {
        pending = false
        readiness.reject(new Error('Owned delivery fixture disposed.'))
      }
      const outcome = await owner
      return { ...outcome, admissions, waitArguments, producerJoined: true, ownerJoined: true }
    }
  }
}

for (const substitute of [
  'held',
  'foreign-session',
  'duplicate-id',
  'missing-id',
  'empty-id',
  'non-string-id'
]) {
  test(`fake activity receipts keep totals pending with the last follow ${substitute}`, async () => {
    const rows = activityReceipts()
    const initial = rows.slice(0, 15)
    if (substitute === 'foreign-session') initial.push(activityReceipts('foreign-activity').at(-1))
    if (substitute === 'duplicate-id') initial.push({ ...initial[0] })
    if (substitute === 'missing-id') initial.push({ ...initial[0], id: undefined })
    if (substitute === 'empty-id') initial.push({ ...initial[0], id: '' })
    if (substitute === 'non-string-id') initial.push({ ...initial[0], id: 13 })
    const fixture = controlledActivityDelivery(initial, [rows.at(-1)])
    let observed
    let finished
    try {
      observed = await fixture.observe()
    } finally {
      finished = await fixture.finish()
    }
    assert.equal(finished.producerJoined && finished.ownerJoined, true)
    assert.deepEqual(observed, { pending: true, admissions: 0 })
    assert.equal(finished.error, undefined)
    assert.equal(
      new Set(
        finished.rows.map((row) => row.id).filter((id) => typeof id === 'string' && id.length > 0)
      ).size,
      16
    )
    assert.ok(finished.rows.every((row) => row.sessionId === 'owned-activity'))
    assert.equal(finished.admissions, 1)
  })
}

test('complete owned activity receipts admit totals with the original wait budget and label', async () => {
  const rows = activityReceipts()
  const fixture = controlledActivityDelivery([...activityReceipts('foreign-activity'), ...rows])
  let observed
  let finished
  try {
    observed = await fixture.observe()
  } finally {
    finished = await fixture.finish()
  }
  assert.equal(finished.producerJoined && finished.ownerJoined, true)
  assert.deepEqual(observed, { pending: false, admissions: 1 })
  assert.deepEqual(finished.rows, rows)
  assert.deepEqual(finished.waitArguments, {
    timeoutMs: 90_000,
    label: `every activity kind (${activityKinds.join(', ')})`
  })
  assert.doesNotThrow(() => assertFakeActivityTotals(fakeActivityWireTotals()))
})

test('incomplete activity deadline preserves the original rejection object without totals admission', async () => {
  const fixture = controlledActivityDelivery(
    activityReceipts().filter((row) => row.details?.kind !== 'raid')
  )
  const deadlineError = new Error('Original activity wait deadline.')
  let observed
  let finished
  try {
    observed = await fixture.observe()
    fixture.expire(deadlineError)
  } finally {
    finished = await fixture.finish()
  }
  assert.equal(finished.producerJoined && finished.ownerJoined, true)
  assert.deepEqual(observed, { pending: true, admissions: 0 })
  assert.equal(finished.error, deadlineError)
  assert.equal(finished.admissions, 0)
  assert.equal(finished.waitArguments.timeoutMs, 90_000)
})

test('sixteen distinct owned receipts still require every original activity kind', async () => {
  const rows = activityReceipts().map((row) =>
    row.details?.kind === 'raid' ? { ...row, details: undefined } : row
  )
  const fixture = controlledActivityDelivery(rows)
  const deadlineError = new Error('Original missing-kind wait deadline.')
  let observed
  let finished
  try {
    observed = await fixture.observe()
    fixture.expire(deadlineError)
  } finally {
    finished = await fixture.finish()
  }
  assert.equal(finished.producerJoined && finished.ownerJoined, true)
  assert.equal(new Set(rows.map((row) => row.id)).size, 16)
  assert.deepEqual(observed, { pending: true, admissions: 0 })
  assert.equal(finished.error, deadlineError)
  assert.equal(finished.admissions, 0)
  assert.equal(finished.waitArguments.timeoutMs, 90_000)
})

test('complete activity receipts still reject incorrect settled accounting', async () => {
  const fixture = controlledActivityDelivery(activityReceipts())
  let finished
  try {
    await fixture.observe()
  } finally {
    finished = await fixture.finish()
  }
  assert.equal(finished.producerJoined && finished.ownerJoined, true)
  assert.equal(finished.error, undefined)
  assert.equal(finished.rows.length, 16)
  const incorrect = fakeActivityWireTotals()
  incorrect.messageCount = 15
  assert.throws(() => assertFakeActivityTotals(incorrect), /accounting disagreed/)
})

test('additional owned receipts remain available to the strict over-count assertion', async () => {
  const rows = activityReceipts()
  rows.push({
    ...rows[0],
    id: 'owned-activity:twitch:smoke-twitch-events:fake-extra',
    providerMessageId: 'fake-extra'
  })
  const fixture = controlledActivityDelivery(rows)
  let observed
  let finished
  try {
    observed = await fixture.observe()
  } finally {
    finished = await fixture.finish()
  }
  assert.equal(finished.producerJoined && finished.ownerJoined, true)
  assert.deepEqual(observed, { pending: false, admissions: 1 })
  assert.deepEqual(finished.rows, rows)
  const incorrect = fakeActivityWireTotals()
  incorrect.messageCount = 15
  assert.throws(() => assertFakeActivityTotals(incorrect), /accounting disagreed/)
})
