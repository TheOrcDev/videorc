import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { remoteRequest, waitForRemoteEvent } from './remote-control-client.mjs'

const DEFAULT_TIMEOUT_MS = 90000
const failures = [
  { name: 'request send throws', operation: 'request', fault: 'send' },
  { name: 'request registration throws', operation: 'request', fault: 'registration' },
  { name: 'event registration throws', operation: 'event', fault: 'registration' },
  {
    name: 'request reaches its actual deadline',
    operation: 'request',
    fault: 'timeout',
    message: 'remote.intent timed out'
  },
  {
    name: 'event reaches its actual deadline',
    operation: 'event',
    fault: 'timeout',
    message: 'timed out waiting for remote.ack'
  }
]

for (const scenario of failures) {
  test(`${scenario.name} preserves refusal and releases only its owned timer/listener`, async (t) => {
    const observed = await withRemote(t, async (fixture) => {
      const error = new Error('fixture transport refusal')
      if (scenario.fault === 'registration') {
        const on = fixture.ws.on.bind(fixture.ws)
        t.mock.method(fixture.ws, 'on', (event, listener) => {
          on(event, listener)
          throw error
        })
      }
      fixture.sendError = scenario.fault === 'send' ? error : null
      const operation = settle(
        scenario.operation === 'request'
          ? remoteRequest(fixture.ws, 'remote.intent', { kind: 'recordStart' })
          : waitForRemoteEvent(fixture.ws, 'remote.ack')
      )
      let armed = null
      if (
        scenario.fault === 'send' ||
        (scenario.fault === 'timeout' && scenario.operation === 'request')
      ) {
        await fixture.sendReady.promise
      }
      if (scenario.fault === 'timeout') {
        armed = fixture.inspect()
        fixture.fireDeadline()
      }
      return { outcome: await operation, error, armed, after: fixture.inspect() }
    })

    assert.equal(observed.outcome.status, 'rejected')
    if (scenario.message) {
      assert.equal(observed.outcome.reason.message, scenario.message)
      assert.deepEqual(observed.armed.deadlines, [DEFAULT_TIMEOUT_MS])
    } else {
      assert.equal(observed.outcome.reason, observed.error)
    }
    assert.equal(observed.after.independentInstalled, true)
    assert.deepEqual(observed.after.deadlines, [], 'No refused operation may retain its deadline.')
    assert.equal(observed.after.ownedListeners, 0, 'Only the independent listener may remain.')
  })
}

test('actual request registers before send, ignores a wrong ID and preserves its matching response', async (t) => {
  const observed = await withRemote(t, async (fixture) => {
    const operation = remoteRequest(fixture.ws, 'remote.intent', { kind: 'recordStart' })
    await fixture.sendReady.promise
    fixture.emit({ id: 'unrelated-fixture-request', payload: { accepted: true } })
    const beforeMatch = fixture.inspect()
    const response = {
      id: fixture.sent.id,
      payload: { accepted: true, intentId: 'fixture-intent' }
    }
    fixture.emit(response)
    return {
      result: await operation,
      response,
      sent: fixture.sent,
      atSend: fixture.atSend,
      beforeMatch,
      after: fixture.inspect()
    }
  })

  assert.equal(observed.sent.method, 'remote.intent')
  assert.deepEqual(observed.sent.params, { kind: 'recordStart' })
  assert.match(observed.sent.id, /^rc-/)
  assert.deepEqual(observed.atSend.deadlines, [DEFAULT_TIMEOUT_MS])
  assert.equal(observed.atSend.ownedListeners, 1)
  assert.equal(observed.beforeMatch.ownedListeners, 1)
  assert.deepEqual(observed.beforeMatch.deadlines, [DEFAULT_TIMEOUT_MS])
  assert.deepEqual(observed.result, observed.response)
  assert.equal(observed.after.independentInstalled, true)
  assert.equal(observed.after.ownedListeners, 0)
  assert.deepEqual(observed.after.deadlines, [])
})

test('actual event wait ignores other events and a false predicate, returning the exact admitted payload', async (t) => {
  const observed = await withRemote(t, async (fixture) => {
    let admittedPayload
    let predicateCalls = 0
    const operation = waitForRemoteEvent(fixture.ws, 'remote.ack', (payload) => {
      predicateCalls += 1
      if (payload.ok) admittedPayload = payload
      return payload.ok === true
    })
    fixture.emit({ event: 'remote.other', payload: { ok: true } })
    fixture.emit({ event: 'remote.ack', payload: { ok: false } })
    const beforeMatch = fixture.inspect()
    fixture.emit({ event: 'remote.ack', payload: { ok: true, intentId: 'fixture-intent' } })
    return {
      result: await operation,
      admittedPayload,
      predicateCalls,
      beforeMatch,
      after: fixture.inspect()
    }
  })

  assert.equal(observed.predicateCalls, 2)
  assert.equal(observed.result, observed.admittedPayload)
  assert.deepEqual(observed.result, { ok: true, intentId: 'fixture-intent' })
  assert.equal(observed.beforeMatch.ownedListeners, 1)
  assert.deepEqual(observed.beforeMatch.deadlines, [DEFAULT_TIMEOUT_MS])
  assert.equal(observed.after.independentInstalled, true)
  assert.equal(observed.after.ownedListeners, 0)
  assert.deepEqual(observed.after.deadlines, [])
})

async function withRemote(t, observe) {
  const ws = new EventEmitter()
  const timers = new Map()
  const independent = () => {}
  ws.on('message', independent)
  const fixture = {
    ws,
    sendReady: deferred(),
    sendError: null,
    emit: (message) => ws.emit('message', JSON.stringify(message)),
    inspect: () => ({
      deadlines: [...timers.values()].map(({ delay }) => delay),
      independentInstalled: ws.listeners('message').includes(independent),
      ownedListeners: ws.listeners('message').filter((listener) => listener !== independent).length
    }),
    fireDeadline: () => {
      for (const [timer, { callback, args }] of [...timers]) {
        timers.delete(timer)
        callback(...args)
      }
    }
  }
  try {
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      const timer = {}
      timers.set(timer, { callback, delay, args })
      return timer
    })
    t.mock.method(globalThis, 'clearTimeout', (timer) => timers.delete(timer))
    ws.send = (raw) => {
      fixture.sent = JSON.parse(raw)
      fixture.atSend = fixture.inspect()
      fixture.sendReady.resolve()
      if (fixture.sendError) throw fixture.sendError
    }
    return await observe(fixture)
  } finally {
    // These are only exact synthetic owners: no OS child, socket or real timer.
    // Observe leaks first, then attempt all fixture cleanup before assertions.
    const errors = []
    for (const cleanup of [
      () => timers.clear(),
      () => ws.removeAllListeners(),
      () => t.mock.restoreAll()
    ]) {
      try {
        cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Owned remote fixture cleanup failed.')
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function settle(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  )
}
