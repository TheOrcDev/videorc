import { performance } from 'node:perf_hooks'

import { remoteRequest } from './remote-control-client.mjs'
import { request } from '../smoke-recording-session.mjs'

/**
 * Buffers backend events with a monotonic receive time so a waiter registered
 * before an intent is sent can never miss the transition it waits for.
 */
export class BackendEventRecorder {
  constructor(ws, { debug = false, timeoutMs = 120000 } = {}) {
    this.ws = ws
    this.timeoutMs = timeoutMs
    this.events = []
    this.waiters = new Set()
    this.latestDiagnostics = null
    this.disposed = false
    this.listenerRemoved = false
    this.onMessage = (event) => {
      if (this.disposed) return
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message?.event) return
      const record = { event: message.event, payload: message.payload, at: performance.now() }
      if (message.event === 'diagnostics.stats') {
        this.latestDiagnostics = record
        return
      }
      this.events.push(record)
      if (debug && message.event === 'recording.status') {
        console.log(
          `[event] ${message.event} ${message.payload?.state ?? ''} ${message.payload?.sessionId ?? ''}`
        )
      }
      for (const waiter of this.waiters) {
        if (waiter.predicate(record)) {
          this.waiters.delete(waiter)
          waiter.resolve(record)
        }
      }
    }
    ws.addEventListener('message', this.onMessage)
  }

  waitFor(label, predicate, waitTimeoutMs = this.timeoutMs) {
    return this.createWait(label, predicate, waitTimeoutMs).promise
  }

  createWait(label, predicate, waitTimeoutMs = this.timeoutMs) {
    if (this.disposed) throw new Error('Record-latency event recorder is disposed.')
    let active = true
    let cancel
    const promise = new Promise((resolveWait, rejectWait) => {
      const waiter = { predicate, resolve: null }
      const timer = setTimeout(() => {
        if (!active) return
        active = false
        this.waiters.delete(waiter)
        rejectWait(new Error(`timed out waiting for ${label}`))
      }, waitTimeoutMs)
      cancel = () => {
        if (!active) return
        active = false
        clearTimeout(timer)
        this.waiters.delete(waiter)
      }
      waiter.cancel = cancel
      waiter.resolve = (record) => {
        if (!active) return
        cancel()
        resolveWait(record)
      }
      this.waiters.add(waiter)
    })
    // A sibling may time out while its owning request rejects first. Handling
    // that abandoned rejection does not change the promise returned to callers.
    promise.catch(() => {})
    return { promise, cancel }
  }

  dispose() {
    this.disposed = true
    for (const waiter of [...this.waiters]) waiter.cancel()
    if (!this.listenerRemoved) {
      this.ws.removeEventListener('message', this.onMessage)
      this.listenerRemoved = true
    }
  }
}

export function createRemoteAckWait(remote, { timeoutMs = 120000 } = {}) {
  let active = true
  let cancel
  const promise = new Promise((resolveEvent, rejectEvent) => {
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw))
      if (message.event === 'remote.ack') {
        if (!active) return
        cancel()
        resolveEvent(message.payload)
      }
    }
    const timer = setTimeout(() => {
      if (!active) return
      cancel()
      rejectEvent(new Error('timed out waiting for remote.ack'))
    }, timeoutMs)
    cancel = () => {
      if (!active) return
      active = false
      clearTimeout(timer)
      remote.off('message', onMessage)
    }
    try {
      remote.on('message', onMessage)
    } catch (error) {
      cancel()
      rejectEvent(error)
    }
  })
  promise.catch(() => {})
  return { promise, cancel }
}

export function createRecordLatencyWaitScope(recorder) {
  const owned = new Set()
  let disposed = false
  const retain = (wait) => {
    if (disposed) {
      wait.cancel()
      throw new Error('Record-latency wait scope is disposed.')
    }
    owned.add(wait)
    return wait.promise
  }
  return {
    waitFor: (...args) => retain(recorder.createWait(...args)),
    waitForRemoteAck: (remote, options) => retain(createRemoteAckWait(remote, options)),
    dispose() {
      disposed = true
      for (const wait of owned) wait.cancel()
      owned.clear()
    }
  }
}

export function statusEvent(state, sessionId) {
  return (record) =>
    record.event === 'recording.status' &&
    record.payload?.state === state &&
    (sessionId === undefined || record.payload?.sessionId === sessionId)
}

export async function startRecordLatencyCycle({
  remote,
  recorder,
  smoke,
  timeoutMs,
  describeRendererFailure,
  fail,
  sleep
}) {
  const waits = createRecordLatencyWaitScope(recorder)
  try {
    const startingPromise = waits
      .waitFor('recording.status(starting)', statusEvent('starting'), timeoutMs)
      .catch(() => null)
    const recordingPromise = waits.waitFor(
      'recording.status(recording)',
      (record) =>
        record.event === 'recording.status' &&
        (record.payload?.state === 'recording' || record.payload?.state === 'streaming') &&
        typeof record.payload?.sessionId === 'string',
      timeoutMs
    )
    const startFailurePromise = waits
      .waitFor(
        'recording.status(failed)',
        (record) => record.event === 'recording.status' && record.payload?.state === 'failed',
        timeoutMs
      )
      .catch(() => null)
    const startAckPromise = waits
      .waitForRemoteAck(remote, { timeoutMs })
      .then((payload) => ({ payload, at: performance.now() }))
    startAckPromise.catch(() => {})

    const clickAt = performance.now()
    const ticket = await remoteRequest(
      remote,
      'remote.intent',
      { kind: 'recordStart' },
      { timeoutMs }
    )
    if (!ticket.payload?.accepted)
      fail(`recordStart intent was not accepted: ${JSON.stringify(ticket)}`)

    const recordingRecord = await Promise.race([
      recordingPromise,
      startFailurePromise.then((record) => {
        if (record) fail(`start failed: ${record.payload?.message ?? 'no message'}`)
        return new Promise(() => {})
      }),
      // A refused start acks ok=false without ever publishing `recording`.
      startAckPromise.then(async (ack) => {
        if (ack.payload?.ok === false) {
          const detail = await describeRendererFailure(smoke)
          fail(
            `recordStart was refused by the renderer: ${ack.payload?.message ?? 'no message'}.${detail}`
          )
        }
        return new Promise(() => {})
      })
    ])
    const sessionId = recordingRecord.payload.sessionId
    const startAck = await startAckPromise
    if (startAck.payload?.intentId !== ticket.payload.intentId || startAck.payload?.ok !== true) {
      fail(`recordStart was not acknowledged successfully: ${JSON.stringify(startAck.payload)}`)
    }
    const startingRecord = await Promise.race([startingPromise, sleep(0).then(() => null)])
    return { clickAt, sessionId, startAck, startingRecord, recordingRecord }
  } finally {
    waits.dispose()
  }
}

export async function stopRecordLatencyCycle({
  remote,
  recorder,
  smoke,
  sessionId,
  timeoutMs,
  describeRendererFailure,
  fail,
  sleep
}) {
  const waits = createRecordLatencyWaitScope(recorder)
  try {
    const stoppingPromise = waits
      .waitFor('recording.status(stopping)', statusEvent('stopping', sessionId), timeoutMs)
      .catch(() => null)
    const terminalPromise = waits.waitFor(
      `terminal recording.status for ${sessionId}`,
      terminalStatusEvent(sessionId),
      timeoutMs
    )
    const stopAckPromise = waits
      .waitForRemoteAck(remote, { timeoutMs })
      .then((payload) => ({ payload, at: performance.now() }))
    stopAckPromise.catch(() => {})
    const stopClickAt = performance.now()
    const stopTicket = await remoteRequest(
      remote,
      'remote.intent',
      { kind: 'recordStop' },
      { timeoutMs }
    )
    if (!stopTicket.payload?.accepted) {
      fail(`recordStop intent was not accepted: ${JSON.stringify(stopTicket)}`)
    }
    const terminalRecord = await Promise.race([
      terminalPromise,
      stopAckPromise.then(async (ack) => {
        if (ack.payload?.ok === false) {
          const detail = await describeRendererFailure(smoke)
          fail(
            `recordStop was refused by the renderer: ${ack.payload?.message ?? 'no message'}.${detail}`
          )
        }
        return new Promise(() => {})
      })
    ])
    if (terminalRecord.payload.state !== 'idle') {
      fail(
        `session ${sessionId} ended in ${terminalRecord.payload.state}: ${terminalRecord.payload.message ?? ''}`
      )
    }
    const stopAck = await stopAckPromise
    if (stopAck.payload?.intentId !== stopTicket.payload.intentId || stopAck.payload?.ok !== true) {
      fail(`recordStop was not acknowledged successfully: ${JSON.stringify(stopAck.payload)}`)
    }
    const stoppingRecord = await Promise.race([stoppingPromise, sleep(0).then(() => null)])
    return { stopClickAt, terminalRecord, stopAck, stoppingRecord }
  } finally {
    waits.dispose()
  }
}

function terminalStatusEvent(sessionId) {
  return (record) =>
    record.event === 'recording.status' &&
    (record.payload?.state === 'idle' || record.payload?.state === 'failed') &&
    record.payload?.sessionId === sessionId
}

function finalizationEvent(sessionId) {
  return (record) =>
    record.event === 'recording.finalization' &&
    record.payload?.sessionId === sessionId &&
    (record.payload?.state === 'finalized' || record.payload?.state === 'failed')
}

export async function waitForPublishedMp4({
  ws,
  recorder,
  sessionId,
  idleRecord,
  finalizationTimeoutMs,
  timeoutMs,
  fail,
  sleep
}) {
  const idlePath = idleRecord.payload?.outputPath
  if (typeof idlePath === 'string' && idlePath.toLowerCase().endsWith('.mp4')) {
    return { mp4Path: idlePath, finalizedAt: idleRecord.at, source: 'stop-reply' }
  }
  const waits = createRecordLatencyWaitScope(recorder)
  try {
    const eventPromise = waits
      .waitFor(
        `recording.finalization for ${sessionId}`,
        finalizationEvent(sessionId),
        finalizationTimeoutMs
      )
      .catch(() => null)
    const deadline = performance.now() + finalizationTimeoutMs
    for (;;) {
      const raced = await Promise.race([eventPromise, sleep(250).then(() => 'poll')])
      if (raced && raced !== 'poll') {
        if (raced.payload.state === 'failed') {
          fail(`finalization failed for ${sessionId}: ${raced.payload.error ?? 'unknown error'}`)
        }
        return { mp4Path: raced.payload.mp4Path, finalizedAt: raced.at, source: 'event' }
      }
      const page = await request(ws, timeoutMs, 'sessions.list', { limit: 20 })
      const item = page?.items?.find((entry) => entry.id === sessionId)
      if (item?.mp4Path) {
        return { mp4Path: item.mp4Path, finalizedAt: performance.now(), source: 'sessions.list' }
      }
      if (item?.finalizationState === 'failed') {
        fail(`finalization failed for ${sessionId}: ${item.finalizationError ?? 'unknown error'}`)
      }
      if (performance.now() > deadline) {
        fail(`MP4 for ${sessionId} was not published within ${finalizationTimeoutMs}ms`)
      }
    }
  } finally {
    waits.dispose()
  }
}

export async function closeRecordLatencySocket(socket, { timeoutMs = 5000 } = {}) {
  if (!socket || socket.readyState === 3) return
  let timer
  let onClose
  const closed = new Promise((resolveClose) => {
    onClose = resolveClose
    socket.addEventListener('close', onClose, { once: true })
  })
  try {
    if (socket.readyState !== 2) socket.close()
    if (socket.readyState === 3) return
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned record-latency socket close timed out.')),
          timeoutMs
        )
      })
    ])
  } finally {
    clearTimeout(timer)
    socket.removeEventListener('close', onClose)
  }
}

export async function disposeRecordLatencyRun({
  recorder,
  renderer,
  remote,
  stopApp,
  removeProfile,
  closeSocket = closeRecordLatencySocket
}) {
  const failures = []
  try {
    recorder?.dispose()
  } catch (error) {
    failures.push({ owner: 'event recorder', error })
  }
  const sockets = [
    { owner: 'renderer socket', socket: renderer },
    { owner: 'remote socket', socket: remote }
  ]
  const results = await Promise.allSettled(
    sockets.map(({ socket }) => Promise.resolve().then(() => closeSocket(socket)))
  )
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status === 'rejected') {
      failures.push({ owner: sockets[index].owner, error: results[index].reason })
    }
  }
  let appStopped = false
  if (stopApp) {
    try {
      const result = await stopApp()
      appStopped = result?.childExited === true && result?.processGroupExited === true
      if (!appStopped)
        failures.push({ owner: 'app', error: new Error('Owned app teardown was not confirmed.') })
    } catch (error) {
      failures.push({ owner: 'app', error })
    }
  }
  if (appStopped && removeProfile) {
    try {
      await removeProfile()
    } catch (error) {
      failures.push({ owner: 'isolated profile', error })
    }
  }
  return { failures, appStopped }
}
