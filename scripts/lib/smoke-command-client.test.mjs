import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  assertSmokeCommandConnection,
  requestSmokeCommand,
  requestSmokeCommandWithRetry
} from './smoke-command-client.mjs'

const capability = 'a'.repeat(43)

test('assertSmokeCommandConnection requires a loopback endpoint and per-run capability', () => {
  assert.deepEqual(
    assertSmokeCommandConnection({ host: '127.0.0.1', port: 41_234, capability }),
    { host: '127.0.0.1', port: 41_234, capability }
  )
  assert.throws(
    () => assertSmokeCommandConnection({ host: '127.0.0.1', port: 41_234 }),
    /per-run capability/
  )
  assert.throws(
    () => assertSmokeCommandConnection({ host: '0.0.0.0', port: 41_234, capability }),
    /loopback/
  )
})

test('requestSmokeCommand uses a one-shot connection and returns the command result', async (t) => {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        connection: request.headers.connection,
        body: JSON.parse(body)
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result: { open: true } }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')

  const result = await requestSmokeCommand(
    { host: '127.0.0.1', port: address.port, capability },
    'preview-window-state',
    { generation: 7 }
  )

  assert.deepEqual(result, { open: true })
  assert.deepEqual(requests, [
    {
      authorization: `Bearer ${capability}`,
      connection: 'close',
      body: {
        command: 'preview-window-state',
        params: { generation: 7 }
      }
    }
  ])
})

test('requestSmokeCommand surfaces a command-server error without replaying it', async (t) => {
  let requestCount = 0
  const server = createServer((_request, response) => {
    requestCount += 1
    response.writeHead(409, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'preview generation is stale' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')

  await assert.rejects(
    requestSmokeCommand(
      { host: '127.0.0.1', port: address.port, capability },
      'preview-window-toggle',
      {}
    ),
    /preview generation is stale/
  )
  assert.equal(requestCount, 1)
})

test('requestSmokeCommandWithRetry recovers a target-state command after ECONNRESET', async (t) => {
  let requestCount = 0
  const server = createServer((request, response) => {
    requestCount += 1
    if (requestCount === 1) {
      request.socket.destroy()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        ok: true,
        result: { open: true, supervisor: { generation: 9 } }
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')

  const result = await requestSmokeCommandWithRetry(
    { host: '127.0.0.1', port: address.port, capability },
    'preview-window-toggle',
    { expectedOpen: true },
    { timeoutMs: 1000, retryDelayMs: 1 }
  )

  assert.deepEqual(result, { open: true, supervisor: { generation: 9 } })
  assert.equal(requestCount, 2)
})
