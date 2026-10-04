import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertFakeActivityTotals, probeCommentsTotals } from './comments-totals-probe.mjs'

// ServerResponse::ok converts the actual persisted totals to serde_json::Value
// before websocket serialization. Its object keys arrive in this order; the
// ordered currency rows and every accounting value remain unchanged.
function fakeActivityWireTotals() {
  return JSON.parse(
    '{"bits":1500,"chatters":7,"follows":2,"messageCount":13,"raids":1,"status":"available","supporters":7,"tips":[{"amountMicros":5000000,"currency":"USD"},{"amountMicros":2000000,"currency":"EUR"}]}'
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
  ['messageCount', 12],
  ['supporters', 6],
  ['bits', 1499],
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
