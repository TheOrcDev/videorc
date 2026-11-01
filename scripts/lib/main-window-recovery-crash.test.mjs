import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeRendererCrash } from './main-window-recovery-crash.mjs'

function fixture(onSend) {
  const sockets = []
  class Socket extends EventTarget {
    sent = []
    closeCount = 0
    constructor() {
      super()
      sockets.push(this)
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    message(message) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
    }
    send(data) {
      const message = JSON.parse(data)
      this.sent.push(message)
      onSend(this, message)
    }
    close() {
      this.closeCount++
      this.dispatchEvent(new Event('close'))
    }
  }
  return { Socket, sockets }
}

test('subscribes before crashing and waits for an explicit crash event', async () => {
  let releaseCrash
  let requested
  const crashRequest = new Promise((resolve) => {
    requested = resolve
  })
  const { Socket, sockets } = fixture((socket, message) => {
    if (message.method === 'Inspector.enable') socket.message({ id: message.id, result: {} })
    else {
      releaseCrash = () => socket.message({ method: 'Inspector.targetCrashed', params: {} })
      requested()
    }
  })
  let completed = false
  const observation = observeRendererCrash('ws://fixture', { Socket }).then((result) => {
    completed = true
    return result
  })
  await crashRequest
  assert.equal(completed, false)
  assert.equal(sockets[0].closeCount, 0)
  releaseCrash()
  const result = await observation
  assert.equal(result.crashed, true)
  assert.equal(result.crashEvent, 'Inspector.targetCrashed')
  assert.equal(result.error, null)
  assert.deepEqual(
    sockets[0].sent.map((m) => m.method),
    ['Inspector.enable', 'Page.crash']
  )
  assert.equal(sockets[0].closeCount, 1)
})

test('a protocol refusal is retained and cannot count as a crash', async () => {
  const { Socket, sockets } = fixture((socket, message) =>
    socket.message(
      message.id === 1
        ? { id: 1, result: {} }
        : { id: 2, error: { code: -32601, message: 'Unavailable method' } }
    )
  )
  const result = await observeRendererCrash('ws://fixture', { Socket, timeoutMs: 20 })
  assert.equal(result.crashRequested, true)
  assert.equal(result.crashed, false)
  assert.match(result.error, /deadline/)
  assert.deepEqual(result.protocolErrors, [
    { method: 'Page.crash', code: -32601, message: 'Unavailable method' }
  ])
  assert.equal(sockets[0].closeCount, 1)
})

test('an ordinary command response without a crash event fails at the deadline', async () => {
  const { Socket } = fixture((socket, message) => socket.message({ id: message.id, result: {} }))
  const result = await observeRendererCrash('ws://fixture', { Socket, timeoutMs: 20 })
  assert.equal(result.crashed, false)
  assert.match(result.error, /deadline/)
})

test('Target crashed command error may precede the positive event', async () => {
  const { Socket } = fixture((socket, message) => {
    if (message.id === 1) socket.message({ id: 1, result: {} })
    else {
      socket.message({ id: 2, error: { code: -32000, message: 'Target crashed' } })
      socket.message({ method: 'Inspector.targetCrashed' })
    }
  })
  const result = await observeRendererCrash('ws://fixture', { Socket })
  assert.equal(result.crashed, true)
  assert.equal(result.protocolErrors[0].message, 'Target crashed')
})

test('unavailable observation refuses to send the crash command', async () => {
  const { Socket, sockets } = fixture((socket) =>
    socket.message({ id: 1, error: { code: -1, message: 'Refused' } })
  )
  const result = await observeRendererCrash('ws://fixture', { Socket })
  assert.equal(result.crashRequested, false)
  assert.equal(result.crashed, false)
  assert.equal(sockets[0].sent.length, 1)
  assert.equal(sockets[0].closeCount, 1)
})

for (const event of ['close', 'error']) {
  test(`socket ${event} is not renderer-crash evidence`, async () => {
    const { Socket, sockets } = fixture((socket) => socket.dispatchEvent(new Event(event)))
    const result = await observeRendererCrash('ws://fixture', { Socket })
    assert.equal(result.crashed, false)
    assert.match(result.error, /socket/)
    assert.equal(sockets[0].closeCount, 1)
  })
}

test('a crash event before requesting the crash cannot satisfy the test', async () => {
  const { Socket } = fixture((socket) => socket.message({ method: 'Inspector.targetCrashed' }))
  const result = await observeRendererCrash('ws://fixture', { Socket, timeoutMs: 20 })
  assert.equal(result.crashed, false)
  assert.equal(result.crashRequested, false)
})

test('send failures close the observer and cannot hang the smoke', async () => {
  const { Socket, sockets } = fixture(() => {
    throw new Error('send refused')
  })
  const result = await observeRendererCrash('ws://fixture', { Socket })
  assert.equal(result.crashed, false)
  assert.match(result.error, /send refused/)
  assert.equal(sockets[0].closeCount, 1)
})

test('invalid response shapes fail closed and clean up the session', async () => {
  const { Socket, sockets } = fixture((socket) => socket.message(null))
  const result = await observeRendererCrash('ws://fixture', { Socket })
  assert.equal(result.crashed, false)
  assert.match(result.error, /invalid JSON/)
  assert.equal(sockets[0].closeCount, 1)
})

test('connection construction and opening both have bounded failure paths', async () => {
  class RefusedSocket {
    constructor() {
      throw new Error('connection refused')
    }
  }
  const refused = await observeRendererCrash('ws://fixture', { Socket: RefusedSocket })
  assert.match(refused.error, /connection refused/)
  let closed = false
  class UnopenedSocket extends EventTarget {
    close() {
      closed = true
    }
  }
  const unopened = await observeRendererCrash('ws://fixture', {
    Socket: UnopenedSocket,
    timeoutMs: 20
  })
  assert.equal(unopened.crashed, false)
  assert.match(unopened.error, /deadline/)
  assert.equal(closed, true)
})
