import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import {
  BackendEventRecorder,
  closeRecordLatencySocket,
  createRemoteAckWait,
  disposeRecordLatencyRun,
  startRecordLatencyCycle,
  stopRecordLatencyCycle,
  waitForPublishedMp4
} from './record-latency-events.mjs'

const ORIGINAL_TIMEOUT_MS = 120000

test('successful real start race releases its losing failed-start deadline', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const started = fixture.start()
    await fixture.intentSent.promise
    fixture.publish('starting')
    fixture.accept()
    fixture.publish('recording')
    fixture.ack()
    const result = await started
    fixture.timers.fireDelay(0)
    return {
      result,
      registeredAtSend: fixture.registeredAtSend,
      remainingDeadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      remainingWaiters: fixture.recorder.waiters.size
    }
  })

  assert.equal(observed.registeredAtSend, 3)
  assert.equal(observed.result.sessionId, 'fixture-session')
  assert.equal(observed.result.recordingRecord.payload.state, 'recording')
  assert.equal(observed.result.startAck.payload.ok, true)
  assert.equal(
    observed.remainingDeadlines,
    0,
    'A successful start must not retain a failed-start timer.'
  )
  assert.equal(observed.remainingWaiters, 0)
})

test('successful start without optional starting event releases both abandoned deadlines', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const started = fixture.start()
    await fixture.intentSent.promise
    fixture.accept()
    fixture.publish('recording')
    fixture.ack()
    await fixture.sleepZeroArmed.promise
    fixture.timers.fireDelay(0)
    const result = await started
    return {
      result,
      remainingDeadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      remainingWaiters: fixture.recorder.waiters.size
    }
  })

  assert.equal(observed.result.startingRecord, null)
  assert.equal(observed.result.sessionId, 'fixture-session')
  assert.equal(
    observed.remainingDeadlines,
    0,
    'Optional and losing waits must not outlive start completion.'
  )
  assert.equal(observed.remainingWaiters, 0)
})

test('matching recorder delivery clears its unchanged deadline and preserves the exact record', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const delivered = fixture.recorder.waitFor(
      'recording delivery',
      (record) => record.event === 'recording.status' && record.payload.state === 'recording'
    )
    fixture.publish('recording')
    const result = await delivered
    return {
      result,
      buffered: fixture.recorder.events,
      deadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      waiters: fixture.recorder.waiters.size
    }
  })

  assert.equal(observed.result, observed.buffered[0])
  assert.equal(observed.result.payload.sessionId, 'fixture-session')
  assert.ok(Number.isFinite(observed.result.at))
  assert.equal(observed.deadlines, 0)
  assert.equal(observed.waiters, 0)
})

test('unmatched recorder delivery fails at the original deadline without fabricating an event', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const waiting = settle(fixture.recorder.waitFor('original recording deadline', () => false))
    const deadlines = fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS)
    fixture.timers.fireDelay(ORIGINAL_TIMEOUT_MS)
    return {
      outcome: await waiting,
      deadlines,
      events: fixture.recorder.events,
      remaining: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      waiters: fixture.recorder.waiters.size
    }
  })

  assert.equal(observed.deadlines, 1)
  assert.equal(observed.outcome.status, 'rejected')
  assert.equal(observed.outcome.reason.message, 'timed out waiting for original recording deadline')
  assert.deepEqual(observed.events, [])
  assert.equal(observed.remaining, 0)
  assert.equal(observed.waiters, 0)
})

test('actual failed-start status retains the original failure outcome', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const started = settle(fixture.start())
    await fixture.intentSent.promise
    fixture.accept()
    fixture.ack()
    fixture.publish('failed', { message: 'fixture start failed' })
    return await started
  })

  assert.equal(observed.status, 'rejected')
  assert.equal(observed.reason.message, 'start failed: fixture start failed')
})

test('actual refused renderer ACK remains a failure without a recording event', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const started = settle(fixture.start())
    await fixture.intentSent.promise
    fixture.accept()
    fixture.ack({ ok: false, message: 'fixture refusal' })
    return { outcome: await started, described: fixture.described, events: fixture.recorder.events }
  })

  assert.equal(observed.outcome.status, 'rejected')
  assert.equal(
    observed.outcome.reason.message,
    'recordStart was refused by the renderer: fixture refusal. fixture detail'
  )
  assert.equal(observed.described, 1)
  assert.deepEqual(observed.events, [])
})

test('a recording event cannot override an ACK for another intent', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const started = settle(fixture.start())
    await fixture.intentSent.promise
    fixture.accept()
    fixture.publish('recording')
    fixture.ack({ intentId: 'other-fixture-intent' })
    return await started
  })

  assert.equal(observed.status, 'rejected')
  assert.match(observed.reason.message, /^recordStart was not acknowledged successfully:/)
})

test('an unaccepted actual request ticket does not become a successful start', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const started = settle(fixture.start())
    await fixture.intentSent.promise
    fixture.accept({ accepted: false })
    const outcome = await started
    return {
      outcome,
      events: fixture.recorder.events,
      deadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      waiters: fixture.recorder.waiters.size,
      remoteListeners: fixture.remote.listenerCount('message')
    }
  })

  assert.equal(observed.outcome.status, 'rejected')
  assert.match(observed.outcome.reason.message, /^recordStart intent was not accepted:/)
  assert.deepEqual(observed.events, [])
  assert.equal(observed.deadlines, 0)
  assert.equal(observed.waiters, 0)
  assert.equal(observed.remoteListeners, 0)
})

test('actual start timeout preserves its recording deadline and disposes failed siblings', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const started = settle(fixture.start())
    await fixture.intentSent.promise
    fixture.accept()
    await fixture.replyAccepted.promise
    fixture.timers.fireDelay(ORIGINAL_TIMEOUT_MS)
    const outcome = await started
    return {
      outcome,
      deadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      waiters: fixture.recorder.waiters.size,
      remoteListeners: fixture.remote.listenerCount('message')
    }
  })

  assert.equal(observed.outcome.status, 'rejected')
  assert.equal(observed.outcome.reason.message, 'timed out waiting for recording.status(recording)')
  assert.equal(observed.deadlines, 0)
  assert.equal(observed.waiters, 0)
  assert.equal(observed.remoteListeners, 0)
})

test('shared send-throw deadline stays distinct from disposed local ACK and recorder waits', async (t) => {
  const originalError = new Error('fixture send failed')
  const observed = await withFixture(t, async (fixture) => {
    const send = fixture.remote.send
    fixture.remote.send = (raw) => {
      send(raw)
      throw originalError
    }
    const outcome = await settle(fixture.start())
    return {
      outcome,
      remainingSharedRequestDeadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      remainingSharedRequestListeners: fixture.remote.listenerCount('message'),
      recorderWaiters: fixture.recorder.waiters.size
    }
  })

  assert.equal(observed.outcome.reason, originalError)
  assert.equal(observed.recorderWaiters, 0)
  // remoteRequest is intentionally unchanged: its own send-throw timer and
  // reply listener remain. These are not a local ACK cleanup success claim.
  assert.equal(observed.remainingSharedRequestDeadlines, 1)
  assert.equal(observed.remainingSharedRequestListeners, 1)
})

test('actual successful stop disposes the optional stopping-event loser', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const stopped = fixture.stop()
    await fixture.intentSent.promise
    fixture.accept()
    fixture.publish('idle')
    fixture.ack()
    await fixture.sleepZeroArmed.promise
    fixture.timers.fireDelay(0)
    const result = await stopped
    return {
      result,
      sentKind: fixture.sentKind,
      deadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      waiters: fixture.recorder.waiters.size
    }
  })

  assert.equal(observed.sentKind, 'recordStop')
  assert.equal(observed.result.terminalRecord.payload.state, 'idle')
  assert.equal(observed.result.stoppingRecord, null)
  assert.equal(observed.result.stopAck.payload.ok, true)
  assert.equal(observed.deadlines, 0)
  assert.equal(observed.waiters, 0)
})

test('actual sessions-list MP4 winner disposes the finalization-event deadline', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const published = fixture.publishedMp4()
    await fixture.sleepPollArmed.promise
    fixture.timers.fireDelay(250)
    await fixture.rendererRequestSent.promise
    fixture.replyPage([{ id: 'fixture-session', mp4Path: '/fixture-published.mp4' }])
    const result = await published
    return {
      result,
      method: fixture.rendererMethod,
      finalizationDeadlines: fixture.timers.countDelay(30000),
      waiters: fixture.recorder.waiters.size
    }
  })

  assert.equal(observed.method, 'sessions.list')
  assert.equal(observed.result.mp4Path, '/fixture-published.mp4')
  assert.equal(observed.result.source, 'sessions.list')
  assert.equal(observed.finalizationDeadlines, 0)
  assert.equal(observed.waiters, 0)
})

test('recorder cancellation and repeated disposal remove timers/listener without making an event', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const wait = fixture.recorder.createWait('abandoned recording', () => true)
    let resolved = false
    wait.promise.then(() => {
      resolved = true
    })
    wait.cancel()
    wait.cancel()
    fixture.recorder.dispose()
    fixture.recorder.dispose()
    fixture.publish('recording')
    fixture.timers.fireDelay(ORIGINAL_TIMEOUT_MS)
    await Promise.resolve()
    return {
      resolved,
      deadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      waiters: fixture.recorder.waiters.size,
      listeners: fixture.renderer.listeners.size,
      events: fixture.recorder.events
    }
  })

  assert.equal(observed.resolved, false)
  assert.equal(observed.deadlines, 0)
  assert.equal(observed.waiters, 0)
  assert.equal(observed.listeners, 0)
  assert.deepEqual(observed.events, [])
})

test('local ACK cancellation removes only its timer/listener and never creates an ACK', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const wait = createRemoteAckWait(fixture.remote, { timeoutMs: ORIGINAL_TIMEOUT_MS })
    let resolved = false
    wait.promise.then(() => {
      resolved = true
    })
    wait.cancel()
    wait.cancel()
    fixture.ack()
    fixture.timers.fireDelay(ORIGINAL_TIMEOUT_MS)
    await Promise.resolve()
    return {
      resolved,
      deadlines: fixture.timers.countDelay(ORIGINAL_TIMEOUT_MS),
      listeners: fixture.remote.listenerCount('message')
    }
  })

  assert.equal(observed.resolved, false)
  assert.equal(observed.deadlines, 0)
  assert.equal(observed.listeners, 0)
})

test('local ACK real timeout still rejects and unregisters its listener', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const wait = createRemoteAckWait(fixture.remote, { timeoutMs: ORIGINAL_TIMEOUT_MS })
    const outcome = settle(wait.promise)
    fixture.timers.fireDelay(ORIGINAL_TIMEOUT_MS)
    return { outcome: await outcome, listeners: fixture.remote.listenerCount('message') }
  })

  assert.equal(observed.outcome.status, 'rejected')
  assert.equal(observed.outcome.reason.message, 'timed out waiting for remote.ack')
  assert.equal(observed.listeners, 0)
})

test('owned socket close waits for its actual close event and clears its deadline', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const closing = closeRecordLatencySocket(fixture.renderer)
    await fixture.renderer.closeRequested.promise
    fixture.renderer.finishClose()
    await closing
    return {
      closeCalls: fixture.renderer.closeCalls,
      closeListeners: fixture.renderer.listenerCount('close'),
      deadlines: fixture.timers.countDelay(5000)
    }
  })

  assert.equal(observed.closeCalls, 1)
  assert.equal(observed.closeListeners, 0)
  assert.equal(observed.deadlines, 0)
})

test('owned socket close deadline is a cleanup failure and removes its observer', async (t) => {
  const observed = await withFixture(t, async (fixture) => {
    const closing = settle(closeRecordLatencySocket(fixture.renderer))
    await fixture.renderer.closeRequested.promise
    fixture.timers.fireDelay(5000)
    return {
      outcome: await closing,
      closeListeners: fixture.renderer.listenerCount('close'),
      deadlines: fixture.timers.countDelay(5000)
    }
  })

  assert.equal(observed.outcome.status, 'rejected')
  assert.equal(observed.outcome.reason.message, 'Owned record-latency socket close timed out.')
  assert.equal(observed.closeListeners, 0)
  assert.equal(observed.deadlines, 0)
})

test('all teardown owners are attempted and launch stop awaited before retaining an unproved profile', async () => {
  const remoteCloseRequested = deferred()
  const finishRemoteClose = deferred()
  const stopRequested = deferred()
  const finishStop = deferred()
  const calls = []
  const renderer = { fixture: 'renderer' }
  const remote = { fixture: 'remote' }
  let removed = false
  const disposing = disposeRecordLatencyRun({
    recorder: {
      dispose() {
        calls.push('recorder')
        throw new Error('fixture recorder cleanup')
      }
    },
    renderer,
    remote,
    closeSocket: (socket) => {
      calls.push(socket.fixture)
      if (socket === renderer) throw new Error('fixture renderer close')
      remoteCloseRequested.resolve()
      return finishRemoteClose.promise
    },
    stopApp: async () => {
      calls.push('app')
      stopRequested.resolve()
      await finishStop.promise
      throw new Error('fixture app stop')
    },
    removeProfile: () => {
      removed = true
    }
  })
  await remoteCloseRequested.promise
  const beforeRemoteClose = [...calls]
  finishRemoteClose.resolve()
  await stopRequested.promise
  const beforeAppStop = removed
  finishStop.resolve()
  const result = await disposing

  assert.deepEqual(beforeRemoteClose, ['recorder', 'renderer', 'remote'])
  assert.equal(beforeAppStop, false)
  assert.deepEqual(calls, ['recorder', 'renderer', 'remote', 'app'])
  assert.equal(result.appStopped, false)
  assert.equal(removed, false)
  assert.deepEqual(
    result.failures.map(({ owner }) => owner),
    ['event recorder', 'renderer socket', 'app']
  )
})

test('profile removal requires confirmed exact app/group stop and reports its own failure', async () => {
  let unprovedRemoved = false
  const unproved = await disposeRecordLatencyRun({
    stopApp: async () => undefined,
    removeProfile: () => {
      unprovedRemoved = true
    }
  })
  let provedRemoved = 0
  const proved = await disposeRecordLatencyRun({
    stopApp: async () => ({ childExited: true, processGroupExited: true }),
    removeProfile: () => {
      provedRemoved += 1
      throw new Error('fixture profile cleanup')
    }
  })

  assert.equal(unproved.appStopped, false)
  assert.equal(unprovedRemoved, false)
  assert.deepEqual(
    unproved.failures.map(({ owner }) => owner),
    ['app']
  )
  assert.equal(proved.appStopped, true)
  assert.equal(provedRemoved, 1)
  assert.deepEqual(
    proved.failures.map(({ owner }) => owner),
    ['isolated profile']
  )
})

async function withFixture(t, observe) {
  const timers = new ControlledTimers()
  const renderer = new OwnedEventTarget()
  const remote = new EventEmitter()
  const intentSent = deferred()
  const replyAccepted = deferred()
  const sleepZeroArmed = deferred()
  const sleepPollArmed = deferred()
  const rendererRequestSent = deferred()
  let ticket = null
  let rendererTicket = null
  const fixture = {
    timers,
    renderer,
    remote,
    intentSent,
    replyAccepted,
    sleepZeroArmed,
    sleepPollArmed,
    rendererRequestSent,
    recorder: null,
    registeredAtSend: null,
    described: 0
  }

  try {
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
      timers.add(callback, delay, args)
    )
    t.mock.method(globalThis, 'clearTimeout', (timer) => timers.remove(timer))
    fixture.recorder = new BackendEventRecorder(renderer, { timeoutMs: ORIGINAL_TIMEOUT_MS })
    remote.send = (raw) => {
      ticket = JSON.parse(raw)
      fixture.sentKind = ticket.params?.kind
      fixture.registeredAtSend = fixture.recorder.waiters.size
      intentSent.resolve()
    }
    fixture.start = () =>
      startRecordLatencyCycle({
        remote,
        recorder: fixture.recorder,
        smoke: { fixture: true },
        timeoutMs: ORIGINAL_TIMEOUT_MS,
        fail: (message) => {
          throw new Error(message)
        },
        describeRendererFailure: async () => {
          fixture.described += 1
          return ' fixture detail'
        },
        sleep: (delay) =>
          new Promise((resolveSleep) => {
            setTimeout(resolveSleep, delay)
            if (delay === 0) sleepZeroArmed.resolve()
          })
      })
    const fail = (message) => {
      throw new Error(message)
    }
    const sleep = (delay) =>
      new Promise((resolveSleep) => {
        setTimeout(resolveSleep, delay)
        if (delay === 0) sleepZeroArmed.resolve()
        if (delay === 250) sleepPollArmed.resolve()
      })
    fixture.stop = () =>
      stopRecordLatencyCycle({
        remote,
        recorder: fixture.recorder,
        smoke: { fixture: true },
        sessionId: 'fixture-session',
        timeoutMs: ORIGINAL_TIMEOUT_MS,
        fail,
        describeRendererFailure: async () => ' fixture detail',
        sleep
      })
    fixture.publishedMp4 = () =>
      waitForPublishedMp4({
        ws: renderer,
        recorder: fixture.recorder,
        sessionId: 'fixture-session',
        idleRecord: { payload: { state: 'idle' }, at: 0 },
        finalizationTimeoutMs: 30000,
        timeoutMs: ORIGINAL_TIMEOUT_MS,
        fail,
        sleep
      })
    renderer.send = (raw) => {
      rendererTicket = JSON.parse(raw)
      fixture.rendererMethod = rendererTicket.method
      rendererRequestSent.resolve()
    }
    fixture.replyPage = (items) =>
      renderer.publish({ id: rendererTicket.id, ok: true, payload: { items } })
    fixture.accept = (payload = {}) => {
      remote.emit(
        'message',
        JSON.stringify({
          id: ticket.id,
          payload: { accepted: true, intentId: 'fixture-intent', ...payload }
        })
      )
      replyAccepted.resolve()
    }
    fixture.ack = (payload = {}) =>
      remote.emit(
        'message',
        JSON.stringify({
          event: 'remote.ack',
          payload: { intentId: 'fixture-intent', ok: true, ...payload }
        })
      )
    fixture.publish = (state, payload = {}) =>
      renderer.publish({
        event: 'recording.status',
        payload: { state, sessionId: 'fixture-session', ...payload }
      })
    return await observe(fixture)
  } finally {
    // No real socket, OS child, background task, or filesystem fixture exists.
    // Clear exact synthetic timer/listener owners even when the RED fails.
    const failures = []
    for (const cleanup of [
      () => renderer.removeOwnedListeners(),
      () => remote.removeAllListeners(),
      () => timers.clear(),
      () => fixture.recorder?.waiters.clear(),
      () => t.mock.restoreAll()
    ]) {
      try {
        cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Owned fixture cleanup failed.')
  }
}

class OwnedEventTarget extends EventTarget {
  listeners = new Set()
  readyState = 1
  closeCalls = 0
  closeRequested = deferred()

  addEventListener(type, listener, options) {
    this.listeners.add({ type, listener, options })
    super.addEventListener(type, listener, options)
  }

  publish(payload) {
    const event = new Event('message')
    Object.defineProperty(event, 'data', { value: JSON.stringify(payload) })
    this.dispatchEvent(event)
  }

  removeEventListener(type, listener, options) {
    for (const entry of this.listeners) {
      if (entry.type === type && entry.listener === listener) this.listeners.delete(entry)
    }
    super.removeEventListener(type, listener, options)
  }

  listenerCount(type) {
    return [...this.listeners].filter((entry) => entry.type === type).length
  }

  close() {
    this.closeCalls += 1
    this.readyState = 2
    this.closeRequested.resolve()
  }

  finishClose() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  removeOwnedListeners() {
    for (const { type, listener, options } of this.listeners) {
      this.removeEventListener(type, listener, options)
    }
    this.listeners.clear()
  }
}

class ControlledTimers {
  timers = new Map()

  add(callback, delay, args) {
    const timer = {}
    this.timers.set(timer, { callback, delay, args })
    return timer
  }

  remove(timer) {
    this.timers.delete(timer)
  }

  countDelay(delay) {
    return [...this.timers.values()].filter((timer) => timer.delay === delay).length
  }

  fireDelay(delay) {
    for (const [timer, owner] of [...this.timers]) {
      if (owner.delay !== delay) continue
      this.timers.delete(timer)
      owner.callback(...owner.args)
    }
  }

  clear() {
    this.timers.clear()
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
