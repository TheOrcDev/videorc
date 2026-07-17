// Remote-control end-to-end smoke (remote-control plan RC5, issue #143).
//
// Drives the REAL dev app: enables the remote surface over the renderer
// socket, pairs a fake Stream Deck client via the discovery file, and proves
// the security contract + the intent round trip:
//
//   1. discovery file exists, is owner-only (0600), and matches port+token
//   2. the remote role is a hard allowlist (health.ping → forbidden-method)
//   3. remote sockets cannot widen their event filter (events.setIncluded)
//   4. micToggle + sceneApply intents ack ok AND the state projection
//      reflects them (backend-confirmed state, not optimistic)
//   5. token regenerate closes the paired client
//
// No recording is started: the intents exercised here are disk-free.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-remote-control-user-data-'))

function fail(message) {
  throw new Error(`remote-control smoke FAIL: ${message}`)
}

function connectRemote(host, port, token) {
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

function remoteRequest(ws, method, params) {
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

function waitForRemoteEvent(ws, event, predicate = () => true) {
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

let stopApp = async () => {}
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_USER_DATA_DIR: userDataDir
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_REMOTE_SMOKE_DEBUG === '1' && /DEBUG-/.test(line)) {
        console.log('[app]', line)
      }
    }
  })
  stopApp = launch.stop
  const renderer = await connectBackend(launch.connections['backend-ready'], timeoutMs)

  // 1. Enable + discovery file contract.
  const status = await request(renderer, timeoutMs, 'remote.control.enable')
  if (!status.enabled || !status.token) fail('enable did not return an enabled status + token')
  if (!status.discoveryPath || !existsSync(status.discoveryPath)) {
    fail('discovery file missing after enable')
  }
  const mode = statSync(status.discoveryPath).mode & 0o777
  if (process.platform !== 'win32' && mode !== 0o600) {
    fail(`discovery file mode ${mode.toString(8)} != 600`)
  }
  const discovery = JSON.parse(readFileSync(status.discoveryPath, 'utf8'))
  if (discovery.port !== status.port || discovery.token !== status.token) {
    fail('discovery file does not match remote.control.status')
  }
  console.log('remote-control smoke: discovery contract OK')

  // 2 + 3. Security: hard allowlist + locked event filter.
  const remote = await connectRemote(discovery.host, discovery.port, discovery.token)
  const forbidden = await remoteRequest(remote, 'health.ping')
  if (forbidden.error?.code !== 'forbidden-method') {
    fail(`remote health.ping expected forbidden-method, got ${JSON.stringify(forbidden)}`)
  }
  const widen = await remoteRequest(remote, 'events.setIncluded', { events: ['recording.status'] })
  if (widen.error?.code !== 'forbidden-method') {
    fail(`remote events.setIncluded expected forbidden-method, got ${JSON.stringify(widen)}`)
  }
  console.log('remote-control smoke: allowlist + filter lock OK')

  // 4. Intent round trip with backend-confirmed state. The studio renderer
  // connects and publishes AFTER backend-ready — wait for its first publish
  // (non-null describe) before sending intents, exactly like a deck key that
  // stays disabled until state arrives.
  let describe = null
  const describeDeadline = Date.now() + timeoutMs
  for (;;) {
    describe = await remoteRequest(remote, 'remote.describe')
    if (describe.payload?.protocol !== 1) fail('remote.describe did not answer protocol 1')
    if (describe.payload?.describe && describe.payload?.state) break
    if (Date.now() > describeDeadline) {
      fail('renderer never published its remote surface (describe/state stayed empty)')
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500))
  }
  const micBefore = describe.payload?.state?.micMuted ?? false

  if (process.env.VIDEORC_REMOTE_SMOKE_DEBUG === '1') {
    renderer.addEventListener('message', (raw) => {
      const message = JSON.parse(String(raw.data ?? raw))
      if (message.event?.startsWith('remote.')) {
        console.log('[DEBUG-rc] renderer saw event:', message.event, JSON.stringify(message.payload).slice(0, 120))
      }
    })
    remote.on('message', (raw) => {
      console.log('[DEBUG-rc] remote saw:', String(raw).slice(0, 160))
    })
  }
  const micAckPromise = waitForRemoteEvent(remote, 'remote.ack', (ack) => ack?.ok === true)
  const micStatePromise = waitForRemoteEvent(
    remote,
    'remote.state',
    (state) => state?.micMuted === !micBefore
  )
  const micTicket = await remoteRequest(remote, 'remote.intent', { kind: 'micToggle' })
  if (!micTicket.payload?.accepted) fail('micToggle intent was not accepted')
  await micAckPromise
  await micStatePromise
  console.log('remote-control smoke: micToggle ack + confirmed state OK')

  const sceneAckPromise = waitForRemoteEvent(remote, 'remote.ack', (ack) => ack?.ok === true)
  const sceneStatePromise = waitForRemoteEvent(
    remote,
    'remote.state',
    (state) => state?.layoutPreset === 'screen-only'
  )
  const sceneTicket = await remoteRequest(remote, 'remote.intent', {
    kind: 'sceneApply',
    layoutPreset: 'screen-only'
  })
  if (!sceneTicket.payload?.accepted) fail('sceneApply intent was not accepted')

  // Debounce: a same-kind intent within the window is rejected without relay
  // (sent BEFORE awaiting the first one's ack — a bouncing deck key).
  const bounced = await remoteRequest(remote, 'remote.intent', {
    kind: 'sceneApply',
    layoutPreset: 'screen-camera'
  })
  if (bounced.payload?.accepted !== false) fail('immediate same-kind intent was not debounced')
  console.log('remote-control smoke: debounce OK')

  await sceneAckPromise
  await sceneStatePromise
  console.log('remote-control smoke: sceneApply ack + confirmed state OK')

  // 5. Regenerate cuts the paired client.
  const closed = new Promise((resolveClose) => remote.once('close', resolveClose))
  await request(renderer, timeoutMs, 'remote.control.regenerate')
  await Promise.race([
    closed,
    new Promise((_, rejectClose) =>
      setTimeout(() => rejectClose(new Error('remote socket not closed after regenerate')), 10000)
    )
  ])
  console.log('remote-control smoke: regenerate cut the client OK')

  // Disable removes the discovery file.
  await request(renderer, timeoutMs, 'remote.control.disable')
  if (existsSync(status.discoveryPath)) fail('discovery file still present after disable')
  console.log('remote-control smoke: PASS')
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  try {
    await stopApp()
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}
