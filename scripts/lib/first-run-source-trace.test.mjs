import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { FIRST_RUN_SOURCE_TRACE_SCRIPT } from './first-run-source-trace.mjs'

function documentFixture(documentId, observations, setup = null) {
  const sent = []
  class WebSocket {
    send(...args) {
      sent.push({ socket: this, args })
      return 'sent'
    }
  }
  const window = {
    WebSocket,
    __firstRunSmoke: { documentId },
    __firstRunSourceRequest: (payload) => observations.push(JSON.parse(payload)),
    performance: { timeOrigin: 1000, now: () => 25 },
    document: { querySelector: () => (setup ? { dataset: { firstRunSetup: setup } } : null) }
  }
  runInNewContext(FIRST_RUN_SOURCE_TRACE_SCRIPT, { window })
  return { window, socket: new WebSocket(), sent }
}

test('trace distinguishes the old workspace from a new setup document without retaining payloads', () => {
  const observations = []
  const old = documentFixture('old', observations)
  const next = documentFixture('new', observations, 'open')
  const payload = JSON.stringify({
    id: 'private-request',
    method: 'preview.camera.start',
    params: { token: 'secret', sources: { cameraId: 'private-device' } }
  })
  assert.equal(old.socket.send(payload), 'sent')
  assert.equal(next.socket.send(payload), 'sent')
  assert.deepEqual(observations, [
    { documentId: 'old', at: 1025, method: 'preview.camera.start', setup: null },
    { documentId: 'new', at: 1025, method: 'preview.camera.start', setup: 'open' }
  ])
  assert.deepEqual(old.sent, [{ socket: old.socket, args: [payload] }])
  assert.deepEqual(next.sent, [{ socket: next.socket, args: [payload] }])
})

test('binary, malformed, unrelated and response frames are forwarded without observation', () => {
  const observations = []
  const { socket, sent } = documentFixture('doc', observations)
  const inputs = [
    new Uint8Array([1, 2]),
    '{invalid',
    JSON.stringify({ method: 'account.connect', params: { secret: 'private' } }),
    JSON.stringify({ id: 1, result: { method: 'preview.camera.start' } }),
    'null'
  ]
  for (const input of inputs) assert.equal(socket.send(input), 'sent')
  assert.deepEqual(
    sent.map((call) => call.args[0]),
    inputs
  )
  assert.deepEqual(observations, [])
})

test('a missing or failed binding never prevents a real send', () => {
  const { window, socket, sent } = documentFixture('doc', [])
  delete window.__firstRunSourceRequest
  socket.send('{"method":"preview.screen.start"}')
  window.__firstRunSourceRequest = () => {
    throw new Error('observer unavailable')
  }
  socket.send('{"method":"preview.live.start"}')
  assert.equal(sent.length, 2)
})

test('installing twice does not double-send or double-report and native errors propagate', () => {
  const observations = []
  const { window, socket, sent } = documentFixture('doc', observations, 'leaving')
  runInNewContext(FIRST_RUN_SOURCE_TRACE_SCRIPT, { window })
  socket.send('{"method":"session.start"}')
  assert.equal(sent.length, 1)
  assert.equal(observations.length, 1)
  assert.equal(observations[0].setup, 'leaving')

  const failure = new Error('socket closed')
  class ClosedWebSocket {
    send() {
      throw failure
    }
  }
  window.WebSocket = ClosedWebSocket
  runInNewContext(FIRST_RUN_SOURCE_TRACE_SCRIPT, { window })
  assert.throws(
    () => new ClosedWebSocket().send('{"method":"preview.camera.start"}'),
    (error) => error === failure
  )
})
