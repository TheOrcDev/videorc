// Shared fake Stream Deck client for smokes that drive the renderer through the
// remote-control surface (docs/remote-control.md). Every helper is bounded by
// the caller's timeout so a stuck renderer fails the smoke instead of hanging it.

import { existsSync, readFileSync } from 'node:fs'
import WebSocket from 'ws'

import { request } from '../smoke-recording-session.mjs'

export function connectRemote(host, port, token, { timeoutMs = 90000 } = {}) {
  return new Promise((resolveConnection, rejectConnection) => {
    const ws = new WebSocket(`ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => rejectConnection(new Error('remote connect timeout')), timeoutMs)
    ws.once('open', () => {
      clearTimeout(timer)
      resolveConnection(ws)
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      rejectConnection(error)
    })
  })
}

export function remoteRequest(ws, method, params, { timeoutMs = 90000 } = {}) {
  const id = `rc-${Math.random().toString(36).slice(2)}`
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => rejectRequest(new Error(`${method} timed out`)), timeoutMs)
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolveRequest(message)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }))
  })
}

export function waitForRemoteEvent(ws, event, predicate = () => true, { timeoutMs = 90000 } = {}) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(
      () => rejectEvent(new Error(`timed out waiting for ${event}`)),
      timeoutMs
    )
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw))
      if (message.event === event && predicate(message.payload)) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolveEvent(message.payload)
      }
    }
    ws.on('message', onMessage)
  })
}

/**
 * Enables the remote surface over the renderer socket and returns the paired
 * discovery record (host/port/token) plus the enable status.
 */
export async function enableRemoteControl(rendererWs, { timeoutMs = 90000 } = {}) {
  const status = await request(rendererWs, timeoutMs, 'remote.control.enable')
  if (!status.enabled || !status.token) {
    throw new Error('remote.control.enable did not return an enabled status + token')
  }
  if (!status.discoveryPath || !existsSync(status.discoveryPath)) {
    throw new Error('remote-control discovery file missing after enable')
  }
  const discovery = JSON.parse(readFileSync(status.discoveryPath, 'utf8'))
  if (discovery.port !== status.port || discovery.token !== status.token) {
    throw new Error('remote-control discovery file does not match remote.control.status')
  }
  return { status, discovery }
}

/**
 * The studio renderer connects and publishes AFTER backend-ready. Poll
 * remote.describe until the renderer has published a surface + state, exactly
 * like a deck key that stays disabled until state arrives.
 */
export async function waitForRemoteDescribe(remote, { timeoutMs = 90000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const describe = await remoteRequest(remote, 'remote.describe', undefined, { timeoutMs })
    if (describe.payload?.protocol !== 1) {
      throw new Error('remote.describe did not answer protocol 1')
    }
    if (describe.payload?.describe && describe.payload?.state) return describe.payload
    if (Date.now() > deadline) {
      throw new Error('renderer never published its remote surface (describe/state stayed empty)')
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs))
  }
}
