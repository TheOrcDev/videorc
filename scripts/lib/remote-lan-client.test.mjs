// Reference phone-remote client (crates/videorc-backend/remote_web) checked
// against an INDEPENDENT server-side implementation built on node:crypto, so a
// shared bug in the pure-JS HMAC cannot make both sides agree by accident.

import assert from 'node:assert/strict'
import { createHmac, createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'

import {
  b64urlDecode,
  b64urlEncode,
  hmacSha256,
  mac,
  sha256
} from '../../crates/videorc-backend/remote_web/hmac.js'
import {
  RemoteClient,
  deviceFragment,
  parseFragment
} from '../../crates/videorc-backend/remote_web/remote-client.js'

const nodeMac = (key, parts) => createHmac('sha256', key).update(parts.join('\n')).digest()
const b64 = (buffer) => Buffer.from(buffer).toString('base64url')

test('sha256 and hmac match node:crypto across block boundaries', () => {
  for (const length of [0, 1, 31, 32, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
    const data = randomBytes(length)
    assert.equal(
      Buffer.from(sha256(data)).toString('hex'),
      createHash('sha256').update(data).digest('hex'),
      `sha256 length ${length}`
    )
    for (const keyLength of [1, 32, 64, 65, 200]) {
      const key = randomBytes(keyLength)
      assert.equal(
        Buffer.from(hmacSha256(key, data)).toString('hex'),
        createHmac('sha256', key).update(data).digest('hex'),
        `hmac key ${keyLength} data ${length}`
      )
    }
  }
  // RFC 4231 test case 2 — the same vector the Rust side asserts.
  assert.equal(
    Buffer.from(
      hmacSha256(
        new TextEncoder().encode('Jefe'),
        new TextEncoder().encode('what do ya want for nothing?')
      )
    ).toString('hex'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  )
  assert.deepEqual(
    Buffer.from(mac(Buffer.from('k'), ['a', 'ü', '3'])),
    nodeMac('k', ['a', 'ü', '3'])
  )
})

test('base64url round-trips every remainder length', () => {
  for (let length = 0; length < 40; length++) {
    const data = randomBytes(length)
    assert.equal(b64urlEncode(data), data.toString('base64url'))
    assert.deepEqual(Buffer.from(b64urlDecode(data.toString('base64url'))), data)
  }
  assert.throws(() => b64urlDecode('not base64!'))
})

test('fragments parse strictly', () => {
  const secret = b64(randomBytes(32))
  assert.deepEqual(parseFragment(`#p=abc123.${secret}`), {
    kind: 'pair',
    pairingId: 'abc123',
    pairingSecret: secret
  })
  assert.deepEqual(parseFragment(deviceFragment({ deviceId: 'dev', deviceKey: secret })), {
    kind: 'device',
    deviceId: 'dev',
    deviceKey: secret
  })
  for (const bad of [
    '',
    '#',
    '#p=abc',
    `#x=a.${secret}`,
    `#p=a.${b64(randomBytes(16))}`,
    '#p=a.!!!'
  ]) {
    assert.equal(parseFragment(bad), null, bad)
  }
})

/** Minimal protocol-2 desktop, written against the docs with node:crypto. */
async function fakeDesktop({ corruptReady = false, refuseWith = null } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => server.once('listening', resolve))
  const desktop = {
    url: `ws://127.0.0.1:${server.address().port}/ws`,
    pairing: { id: 'ticket-1', secret: randomBytes(32) },
    devices: new Map(),
    sockets: [],
    commands: [],
    rejectedFrames: 0,
    close: () =>
      new Promise((resolve) => {
        for (const socket of server.clients) socket.terminate()
        server.close(resolve)
      })
  }
  server.on('connection', (socket) => {
    desktop.sockets.push(socket)
    const serverNonce = b64(randomBytes(32))
    let sessionKey = null
    let lastSeq = 0
    socket.send(JSON.stringify({ t: 'hello', protocol: 2, serverNonce }))
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (!sessionKey) {
        if (refuseWith) {
          socket.send(JSON.stringify({ t: 'error', code: refuseWith, message: 'refused' }))
          socket.close()
          return
        }
        let deviceKey
        let deviceId
        if (message.t === 'pair') {
          const expected = nodeMac(desktop.pairing.secret, [
            'pair',
            serverNonce,
            message.clientNonce
          ])
          assert.equal(message.mac, b64(expected), 'pair mac')
          deviceKey = nodeMac(desktop.pairing.secret, ['device', serverNonce, message.clientNonce])
          deviceId = `device-${desktop.devices.size + 1}`
          desktop.devices.set(deviceId, deviceKey)
        } else {
          deviceId = message.deviceId
          deviceKey = desktop.devices.get(deviceId)
          const expected = nodeMac(deviceKey, ['auth', serverNonce, message.clientNonce])
          assert.equal(message.mac, b64(expected), 'auth mac')
        }
        const readyMac = corruptReady
          ? randomBytes(32)
          : nodeMac(deviceKey, ['ready', message.clientNonce, serverNonce])
        sessionKey = nodeMac(deviceKey, ['session', serverNonce, message.clientNonce])
        socket.send(
          JSON.stringify({
            t: 'ready',
            protocol: 2,
            deviceId,
            deviceName: 'Test',
            mac: b64(readyMac)
          })
        )
        return
      }
      const expected = b64(nodeMac(sessionKey, ['frame', String(message.seq), message.body]))
      if (message.mac !== expected || message.seq <= lastSeq) {
        desktop.rejectedFrames += 1
        socket.close()
        return
      }
      lastSeq = message.seq
      const command = JSON.parse(message.body)
      desktop.commands.push(command)
      desktop.onCommand?.(socket, command)
    })
  })
  return desktop
}

const reply = (socket, id, payload) => socket.send(JSON.stringify({ id, ok: true, payload }))
const push = (socket, event, payload) => socket.send(JSON.stringify({ event, payload }))

test('pairs, derives the device key locally, signs frames, and re-auths with the derived key', async () => {
  const desktop = await fakeDesktop()
  desktop.onCommand = (socket, command) =>
    reply(socket, command.id, { protocol: 1, describe: {}, state: {} })
  try {
    const client = new RemoteClient({
      url: desktop.url,
      credentials: parseFragment(`#p=${desktop.pairing.id}.${b64(desktop.pairing.secret)}`),
      reconnect: false
    })
    let paired = null
    client.on('paired', (credentials) => (paired = credentials))
    const credentials = await client.connect()
    assert.equal(credentials.kind, 'device')
    assert.deepEqual(paired, credentials)
    assert.equal(credentials.deviceKey, b64(desktop.devices.get(credentials.deviceId)))

    await client.describe()
    await client.describe()
    assert.deepEqual(
      desktop.commands.map((command) => command.method),
      ['remote.describe', 'remote.describe']
    )
    assert.equal(desktop.rejectedFrames, 0)
    client.close()

    const again = new RemoteClient({ url: desktop.url, credentials, reconnect: false })
    await again.connect()
    await again.describe()
    assert.equal(desktop.rejectedFrames, 0)
    again.close()
  } finally {
    await desktop.close()
  }
})

test('a desktop that cannot prove the key is refused (mutual auth)', async () => {
  const desktop = await fakeDesktop({ corruptReady: true })
  try {
    const client = new RemoteClient({
      url: desktop.url,
      credentials: parseFragment(`#p=${desktop.pairing.id}.${b64(desktop.pairing.secret)}`)
    })
    await assert.rejects(client.connect(), { code: 'bad-server' })
    assert.equal(client.status, 'unpaired')
  } finally {
    await desktop.close()
  }
})

test('a revoked device stops instead of hammering the desktop', async () => {
  const desktop = await fakeDesktop({ refuseWith: 'unknown-device' })
  try {
    const client = new RemoteClient({
      url: desktop.url,
      credentials: { kind: 'device', deviceId: 'gone', deviceKey: b64(randomBytes(32)) }
    })
    await assert.rejects(client.connect(), { code: 'unknown-device' })
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(desktop.sockets.length, 1, 'no reconnect after a fatal refusal')
  } finally {
    await desktop.close()
  }
})

test('intents resolve on the renderer ack, and a chat gap triggers a re-snapshot', async () => {
  const desktop = await fakeDesktop()
  desktop.onCommand = (socket, command) => {
    if (command.method === 'remote.intent') {
      const debounced = command.params.kind === 'micToggle'
      reply(
        socket,
        command.id,
        debounced
          ? { intentId: '', accepted: false, message: 'Debounced' }
          : { intentId: 'ri-1', accepted: true }
      )
      if (!debounced)
        push(socket, 'remote.ack', { intentId: 'ri-1', ok: false, message: 'Not live' })
    } else if (command.method === 'remote.chat.snapshot') {
      reply(socket, command.id, {
        chatSeq: 9,
        messages: [{ id: 'm9' }],
        highlight: { phase: 'idle' }
      })
    }
  }
  try {
    const client = new RemoteClient({
      url: desktop.url,
      credentials: parseFragment(`#p=${desktop.pairing.id}.${b64(desktop.pairing.secret)}`),
      reconnect: false
    })
    await client.connect()
    assert.deepEqual(await client.intent({ kind: 'commentHighlight', messageId: 'youtube:1' }), {
      ok: false,
      message: 'Not live'
    })
    assert.deepEqual(await client.intent({ kind: 'micToggle' }), {
      ok: false,
      message: 'Debounced'
    })

    const messages = []
    const resets = []
    client.on('chat.message', (message) => messages.push(message.id))
    client.on('chat.reset', (list) => resets.push(list.map((message) => message.id)))
    const socket = desktop.sockets[0]
    push(socket, 'remote.chat.message', { chatSeq: 1, message: { id: 'm1' } })
    push(socket, 'remote.chat.message', { chatSeq: 2, message: { id: 'm2' } })
    push(socket, 'remote.chat.message', { chatSeq: 5, message: { id: 'm5' } }) // 3–4 lost
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(messages, ['m1', 'm2'], 'the out-of-order message waits for the snapshot')
    assert.deepEqual(resets, [['m9']])
    push(socket, 'remote.chat.message', { chatSeq: 10, message: { id: 'm10' } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(messages, ['m1', 'm2', 'm10'])
    client.close()
  } finally {
    await desktop.close()
  }
})

test('reconnects after a drop and re-authenticates with fresh nonces', async () => {
  const desktop = await fakeDesktop()
  desktop.onCommand = (socket, command) => reply(socket, command.id, {})
  try {
    const client = new RemoteClient({
      url: desktop.url,
      credentials: parseFragment(`#p=${desktop.pairing.id}.${b64(desktop.pairing.secret)}`)
    })
    await client.connect()
    const statuses = []
    client.on('status', ({ status }) => statuses.push(status))
    desktop.sockets[0].terminate()
    await new Promise((resolve) => {
      const off = client.on('status', ({ status }) => {
        if (status === 'connected') {
          off()
          resolve()
        }
      })
    })
    assert.ok(statuses.includes('reconnecting'))
    await client.describe()
    assert.equal(desktop.sockets.length, 2)
    assert.equal(desktop.rejectedFrames, 0)
    client.close()
  } finally {
    await desktop.close()
  }
})
