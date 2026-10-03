import assert from 'node:assert/strict'
import test from 'node:test'
import { probeCommentsArrivals } from './comments-arrival-probe.mjs'

function fixture(invalidAt = -1) {
  const sessionId = 'arrival-fixture'
  const id = (index) => `${sessionId}:twitch:rollover-${index}`
  const observations = [
    { lastMessageId: id(1999), chatAtBottom: true },
    ...[2000, 2001, 2002].map((index) => ({ lastMessageId: id(index), chatAtBottom: true })),
    { pausedChat: '3 new ↓' },
    { pausedChat: null, lastMessageId: id(2005), chatAtBottom: true },
    { pausedChat: null, lastMessageId: id(2005), chatAtBottom: true }
  ]
  const calls = []
  let observation = 0
  const command = async (name, params) => {
    calls.push({ name, params })
    if (name === 'comments-window-reader-state' && !params) {
      const index = observation++
      return index === invalidAt ? {} : observations[index]
    }
  }
  return {
    calls,
    options: {
      sessionId,
      command,
      waitFor: async (read, matches, deadline) => {
        assert.equal(deadline, 8000)
        const last = await read()
        return { ok: matches(last), last }
      },
      assert: (ok) => assert.equal(typeof ok, 'boolean')
    }
  }
}

test('maintained arrival probe seeds hydration and admits six raw deliveries through actual broker command names', async () => {
  const { calls, options } = fixture()
  await probeCommentsArrivals(options)
  const first = calls[0]
  assert.equal(first.name, 'comments-window-push-delta')
  assert.equal(first.params.delta.kind, 'adopt')
  assert.deepEqual(Object.keys(first.params.delta.deliveryBoundary).sort(), [
    'generation',
    'ownerId'
  ])
  const snapshots = calls.filter((call) => call.name === 'comments-window-push-snapshot')
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[0].params.snapshot.messages.length, 2000)
  assert.equal(snapshots[0].params.snapshot.delivery.sequence, 0)
  assert.strictEqual(snapshots[1].params.snapshot, snapshots[0].params.snapshot)
  const messages = calls.filter((call) => call.params?.delta?.kind === 'message')
  assert.equal(messages.length, 6)
  assert.equal(new Set(messages.map((call) => call.params.delta.message.id)).size, 6)
  assert.deepEqual(
    calls.filter((call) => call.params?.chatAction).map((call) => call.params.chatAction),
    ['back', 'latest']
  )
  assert.deepEqual(
    calls
      .filter((call) => ['comments-window-close', 'comments-window-open'].includes(call.name))
      .map((call) => call.name),
    ['comments-window-close', 'comments-window-open']
  )
})

for (const [index, label] of [
  [0, 'full chat'],
  [1, 'rollover'],
  [4, 'three new'],
  [5, 'jump'],
  [6, 'reopen']
]) {
  test(`arrival probe rejects missing ${label} evidence instead of continuing`, async () => {
    const { options } = fixture(index)
    await assert.rejects(probeCommentsArrivals(options), /Comments arrival observation failed/)
  })
}
