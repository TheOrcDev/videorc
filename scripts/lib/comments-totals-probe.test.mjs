import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probeCommentsTotals } from './comments-totals-probe.mjs'

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
