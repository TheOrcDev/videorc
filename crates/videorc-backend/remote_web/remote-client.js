// Videorc phone remote — reference protocol-2 client (docs/remote-control.md).
//
// Zero dependencies, runs unchanged in a phone browser and in node (the smoke
// and the unit tests import this same file). A native mobile app should be a
// port of THIS file: handshake, signed frames, reconnect, and chat-gap repair
// are all here, and nothing else is needed to talk to the desktop.

import { b64urlDecode, b64urlEncode, mac, macEquals, randomBytes32 } from './hmac.js'

export const PROTOCOL = 2
const REQUEST_TIMEOUT_MS = 8000
const ACK_TIMEOUT_MS = 5000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000]
/** Handshake refusals that a retry can never fix. */
const FATAL_CODES = new Set(['unknown-device', 'bad-mac', 'pairing-expired', 'too-many-devices'])

/**
 * Credentials ride in the URL fragment, which browsers never send over the
 * network: `#p=<pairingId>.<secret>` from the QR code, rewritten to
 * `#d=<deviceId>.<deviceKey>` once paired so a bookmark keeps working.
 */
export function parseFragment(hash) {
  const match = /^#?([pd])=([^.]+)\.([A-Za-z0-9_-]+)$/.exec(hash ?? '')
  if (!match) return null
  try {
    if (b64urlDecode(match[3]).length !== 32) return null
  } catch {
    return null
  }
  return match[1] === 'p'
    ? { kind: 'pair', pairingId: match[2], pairingSecret: match[3] }
    : { kind: 'device', deviceId: match[2], deviceKey: match[3] }
}

export function deviceFragment({ deviceId, deviceKey }) {
  return `#d=${deviceId}.${deviceKey}`
}

export function signFrame(sessionKey, seq, body) {
  return JSON.stringify({
    seq,
    mac: b64urlEncode(mac(sessionKey, ['frame', String(seq), body])),
    body
  })
}

export class RemoteClient {
  /**
   * @param {object} options
   * @param {string} options.url            ws://<host>:<port>/ws
   * @param {object} options.credentials    result of parseFragment()
   * @param {string} [options.deviceName]
   * @param {Function} [options.WebSocketImpl]
   * @param {boolean} [options.reconnect]
   */
  constructor({ url, credentials, deviceName = 'Phone', WebSocketImpl, reconnect = true }) {
    this.url = url
    this.credentials = credentials
    this.deviceName = deviceName
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket
    this.reconnect = reconnect
    this.listeners = new Map()
    this.pending = new Map()
    this.acks = new Map()
    // Acks that beat their ticket: both can arrive in one network read.
    this.earlyAcks = new Map()
    this.status = 'idle'
    this.attempt = 0
    this.closed = false
    this.lastChatSeq = null
    this.nextId = 0
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(listener)
    return () => this.listeners.get(event)?.delete(listener)
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }

  setStatus(status, detail) {
    this.status = status
    this.emit('status', { status, detail })
  }

  /** Resolves once the first handshake completes; rejects on a fatal refusal. */
  connect() {
    this.closed = false
    return new Promise((resolve, reject) => {
      this.firstConnect = { resolve, reject }
      this.open()
    })
  }

  close() {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.failPending(new Error('Remote closed.'))
    this.setStatus('idle')
  }

  /** Skip the backoff: the phone was just woken or changed network. */
  reconnectNow() {
    if (this.closed || this.status === 'unpaired') return
    clearTimeout(this.reconnectTimer)
    const stale = this.ws
    this.ws = null
    stale?.close()
    this.open()
  }

  open() {
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const ws = new this.WebSocketImpl(this.url)
    this.ws = ws
    const session = { key: null, seq: 0, ready: false }
    this.session = session

    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (!session.ready) this.handleHandshake(ws, session, message)
      else this.handleMessage(message)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.failPending(new Error('Connection lost.'))
      if (this.closed || this.status === 'unpaired') return
      if (!this.reconnect) {
        this.setStatus('idle')
        this.firstConnect?.reject(new Error('Connection closed.'))
        this.firstConnect = null
        return
      }
      const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]
      this.attempt += 1
      this.setStatus('reconnecting')
      this.reconnectTimer = setTimeout(() => this.open(), delay)
    }
    ws.onerror = () => {}
  }

  handleHandshake(ws, session, message) {
    if (message.t === 'hello') {
      if (message.protocol !== PROTOCOL) {
        this.fatal('protocol', 'This page is out of date. Reload it.')
        return
      }
      session.serverNonce = message.serverNonce
      session.clientNonce = b64urlEncode(randomBytes32())
      const credentials = this.credentials
      if (credentials.kind === 'pair') {
        const secret = b64urlDecode(credentials.pairingSecret)
        session.deviceKey = mac(secret, ['device', session.serverNonce, session.clientNonce])
        ws.send(
          JSON.stringify({
            t: 'pair',
            pairingId: credentials.pairingId,
            clientNonce: session.clientNonce,
            deviceName: this.deviceName,
            mac: b64urlEncode(mac(secret, ['pair', session.serverNonce, session.clientNonce]))
          })
        )
      } else {
        session.deviceKey = b64urlDecode(credentials.deviceKey)
        ws.send(
          JSON.stringify({
            t: 'auth',
            deviceId: credentials.deviceId,
            clientNonce: session.clientNonce,
            mac: b64urlEncode(
              mac(session.deviceKey, ['auth', session.serverNonce, session.clientNonce])
            )
          })
        )
      }
      return
    }
    if (message.t === 'error') {
      if (FATAL_CODES.has(message.code)) this.fatal(message.code, message.message)
      return
    }
    if (message.t === 'ready') {
      // Mutual auth: only the real desktop can produce this MAC.
      const expected = b64urlEncode(
        mac(session.deviceKey, ['ready', session.clientNonce, session.serverNonce])
      )
      if (!macEquals(expected, String(message.mac))) {
        this.fatal('bad-server', 'This is not your Videorc. Scan a new code.')
        return
      }
      session.key = mac(session.deviceKey, ['session', session.serverNonce, session.clientNonce])
      session.ready = true
      if (this.credentials.kind === 'pair') {
        this.credentials = {
          kind: 'device',
          deviceId: message.deviceId,
          deviceKey: b64urlEncode(session.deviceKey)
        }
        this.emit('paired', this.credentials)
      }
      this.attempt = 0
      this.lastChatSeq = null
      this.setStatus('connected', { deviceName: message.deviceName })
      this.firstConnect?.resolve(this.credentials)
      this.firstConnect = null
    }
  }

  fatal(code, message) {
    this.setStatus('unpaired', { code, message })
    const error = Object.assign(new Error(message ?? code), { code })
    this.firstConnect?.reject(error)
    this.firstConnect = null
    this.ws?.close()
  }

  handleMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(timer)
      if (message.ok) resolve(message.payload)
      else
        reject(
          Object.assign(new Error(message.error?.message ?? 'Request failed.'), {
            code: message.error?.code
          })
        )
      return
    }
    switch (message.event) {
      case 'remote.state':
        this.emit('state', message.payload)
        break
      case 'remote.ack': {
        const intentId = message.payload?.intentId
        const result = { ok: Boolean(message.payload?.ok), message: message.payload?.message }
        const waiter = this.acks.get(intentId)
        if (waiter) {
          this.acks.delete(intentId)
          clearTimeout(waiter.timer)
          waiter.resolve(result)
        } else if (intentId) {
          // Another phone's intents are acked on this socket too — keep the
          // stash tiny.
          this.earlyAcks.set(intentId, result)
          if (this.earlyAcks.size > 16) this.earlyAcks.delete(this.earlyAcks.keys().next().value)
        }
        break
      }
      case 'remote.chat.message':
        if (this.noteChatSeq(message.payload.chatSeq))
          this.emit('chat.message', message.payload.message)
        break
      case 'remote.chat.reset':
        this.lastChatSeq = message.payload.chatSeq
        this.emit('chat.reset', message.payload.messages)
        break
      case 'remote.highlight':
        this.emit('highlight', message.payload)
        break
    }
  }

  /** false = a gap was detected and a full re-snapshot is on its way. */
  noteChatSeq(chatSeq) {
    const contiguous = this.lastChatSeq === null || chatSeq === this.lastChatSeq + 1
    this.lastChatSeq = chatSeq
    if (contiguous) return true
    void this.chatSnapshot().catch(() => {})
    return false
  }

  failPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
    for (const { resolve, timer } of this.acks.values()) {
      clearTimeout(timer)
      resolve({ ok: false, message: error.message })
    }
    this.acks.clear()
  }

  request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const session = this.session
    if (!session?.ready || this.ws?.readyState !== 1) {
      return Promise.reject(new Error('Not connected to Videorc.'))
    }
    const id = `p-${++this.nextId}`
    const body = JSON.stringify({ id, method, ...(params ? { params } : {}) })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      session.seq += 1
      this.ws.send(signFrame(session.key, session.seq, body))
    })
  }

  describe() {
    return this.request('remote.describe')
  }

  async chatSnapshot() {
    const snapshot = await this.request('remote.chat.snapshot')
    this.lastChatSeq = snapshot.chatSeq
    this.emit('chat.reset', snapshot.messages)
    this.emit('highlight', snapshot.highlight)
    return snapshot
  }

  /**
   * End-to-end intent: admission by the backend AND the renderer's ack.
   * Always resolves `{ ok, message? }` — a key press never throws.
   */
  async intent(params) {
    let ticket
    try {
      ticket = await this.request('remote.intent', params)
    } catch (error) {
      return { ok: false, message: error.message }
    }
    if (!ticket.accepted) return { ok: false, message: ticket.message }
    const early = this.earlyAcks.get(ticket.intentId)
    if (early) {
      this.earlyAcks.delete(ticket.intentId)
      return early
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(ticket.intentId)
        resolve({ ok: false, message: 'Videorc did not answer. Is its window still open?' })
      }, ACK_TIMEOUT_MS)
      this.acks.set(ticket.intentId, { resolve, timer })
    })
  }
}
