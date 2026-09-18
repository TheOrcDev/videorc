// Phone remote (LAN, protocol 2) end-to-end smoke — docs/remote-control.md.
//
// Drives the REAL dev app and the REAL reference client
// (crates/videorc-backend/remote_web/remote-client.js) over the machine's LAN
// address — never 127.0.0.1, because the whole point is the off-loopback path:
//
//   1. enabling Phone remote binds a stable port and turns on remote control
//   2. the LAN listener serves the page with a strict CSP and NOTHING from the
//      main backend router; renderer/admin tokens do not authenticate on it
//   3. QR pairing derives a device key; the single-use ticket is dead after
//   4. re-auth with the derived key; describe + micToggle round trip against
//      backend-confirmed state; chat snapshot; commentHighlight refuses with a
//      human reason when the comment does not exist
//   5. no remote socket (LAN or loopback) ever receives backend.ready — it
//      carries the renderer token
//   6. revoking the phone cuts it and leaves the loopback Stream Deck client up
//   7. disabling closes the port
//
// No recording is started.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

import { RemoteClient, parseFragment } from '../crates/videorc-backend/remote_web/remote-client.js'
import { launchDevApp } from './lib/app-launcher.mjs'
import { connectRemote, remoteRequest } from './lib/remote-control-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-remote-lan-user-data-'))

class SkipSmoke extends Error {}

function fail(message) {
  throw new Error(`remote-lan smoke FAIL: ${message}`)
}

// Records EVERY frame from the first byte — backend.ready, if it were sent,
// would arrive immediately after the handshake.
const seenByPhone = []
class RecordingWebSocket extends WebSocket {
  constructor(url) {
    super(url)
    this.on('message', (raw) => seenByPhone.push(String(raw)))
  }
}

function phone(url, credentials) {
  return new RemoteClient({
    url,
    credentials,
    deviceName: 'Smoke · Node',
    WebSocketImpl: RecordingWebSocket,
    reconnect: false
  })
}

async function waitFor(predicate, label, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`)
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200))
  }
}

let stopApp = async () => {}
try {
  const launch = await launchDevApp({
    env: { VIDEORC_USER_DATA_DIR: userDataDir },
    timeoutMs,
    requiredMarkers: ['backend-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_REMOTE_SMOKE_DEBUG === '1') console.log('[app]', line)
    }
  })
  stopApp = launch.stop
  const backend = launch.connections['backend-ready']
  const renderer = await connectBackend(backend, timeoutMs)

  // 1. Enable.
  const status = await request(renderer, timeoutMs, 'remote.lan.enable')
  if (!status.enabled) fail('remote.lan.enable did not enable')
  if (status.bindError) fail(`listener did not bind: ${status.bindError}`)
  if (!(status.port >= 7420 && status.port < 7430)) fail(`unexpected port ${status.port}`)
  const master = await request(renderer, timeoutMs, 'remote.control.status')
  if (!master.enabled) fail('Phone remote must switch Remote control on')
  if (JSON.stringify(status).includes('"key"')) fail('status leaked device key material')
  if (status.addresses.length === 0) {
    console.log(
      'remote-lan smoke: SKIP — this machine has no private LAN address (no Wi-Fi/Ethernet), so the off-loopback path cannot be exercised here.'
    )
    await request(renderer, timeoutMs, 'remote.lan.disable')
    throw new SkipSmoke()
  }
  console.log(`remote-lan smoke: bound ${status.addresses[0]}:${status.port}`)

  // 2. Page + isolation.
  const pairing = await request(renderer, timeoutMs, 'remote.lan.pairing.begin', {})
  const pairUrl = new URL(pairing.url)
  if (pairUrl.hostname === '127.0.0.1' || pairUrl.hostname === 'localhost') {
    fail('pairing URL must use the LAN address')
  }
  const origin = pairUrl.origin
  const page = await fetch(`${origin}/`)
  const csp = page.headers.get('content-security-policy') ?? ''
  if (page.status !== 200 || !csp.includes("default-src 'self'")) {
    fail(`page not served with a strict CSP (status ${page.status}, csp "${csp}")`)
  }
  const html = await page.text()
  if (/https?:\/\//.test(html)) fail('page references a third-party URL')
  for (const asset of ['/app.js', '/remote-client.js', '/hmac.js', '/app.css', '/icon.svg']) {
    if ((await fetch(`${origin}${asset}`)).status !== 200) fail(`${asset} not served`)
  }
  // Main-backend routes, probed WITHOUT credentials on purpose: they must not
  // exist here at all. (Segments, not literals — smoke-command-callers.test
  // statically requires a bearer next to any smoke-command-server path.)
  const mainRouterRoutes = ['health', 'preview/live.jpg', 'compositor/status', 'oauth/callback']
  for (const route of mainRouterRoutes) {
    const response = await fetch(`${origin}/${route}`)
    if (response.status !== 404) fail(`/${route} answered ${response.status} on the LAN listener`)
  }
  // The loopback port must NOT be reachable through the LAN address either.
  const leaked = await fetch(`http://${pairUrl.hostname}:${backend.port}/${mainRouterRoutes[0]}`)
    .then((response) => response.status)
    .catch(() => 'refused')
  if (leaked !== 'refused') fail(`main backend port answered on the LAN address (${leaked})`)
  console.log('remote-lan smoke: page + router isolation OK')

  const wsUrl = `ws://${pairUrl.host}/ws`
  {
    const probe = new WebSocket(`${wsUrl}?token=${encodeURIComponent(backend.token)}`)
    const frames = []
    await new Promise((resolveProbe, rejectProbe) => {
      probe.on('message', (raw) => {
        frames.push(JSON.parse(String(raw)))
        if (frames.length === 1) probe.send('{"id":"1","method":"remote.describe"}')
      })
      probe.on('close', resolveProbe)
      probe.on('error', rejectProbe)
    })
    if (frames[0]?.t !== 'hello' || frames[1]?.t !== 'error' || frames.length !== 2) {
      fail(`backend token was not refused on the LAN socket: ${JSON.stringify(frames)}`)
    }
  }
  console.log('remote-lan smoke: backend tokens refused OK')

  // 3. Pair.
  const first = phone(wsUrl, parseFragment(pairUrl.hash))
  const credentials = await first.connect()
  if (credentials.kind !== 'device') fail('pairing did not yield device credentials')
  const replay = phone(wsUrl, parseFragment(pairUrl.hash))
  const replayError = await replay.connect().then(
    () => null,
    (error) => error
  )
  if (replayError?.code !== 'pairing-expired') fail('the pairing ticket was usable twice')
  first.close()
  console.log('remote-lan smoke: pairing + single-use ticket OK')

  // 4. Re-auth + round trips.
  const device = phone(wsUrl, credentials)
  await device.connect()
  const paired = await request(renderer, timeoutMs, 'remote.lan.status')
  const row = paired.devices.find((candidate) => candidate.id === credentials.deviceId)
  if (!row?.connected || row.name !== 'Smoke · Node') {
    fail(`paired device not reported connected: ${JSON.stringify(paired.devices)}`)
  }

  const described = await waitFor(
    async () => {
      const answer = await device.describe()
      return answer.describe && answer.state ? answer : null
    },
    'the renderer to publish its remote surface',
    timeoutMs
  )
  const micBefore = described.state.micMuted
  const micState = new Promise((resolveState) => {
    const off = device.on('state', (state) => {
      if (state.micMuted === !micBefore) {
        off()
        resolveState(state)
      }
    })
  })
  const mic = await device.intent({ kind: 'micToggle' })
  if (!mic.ok) fail(`micToggle was refused: ${mic.message}`)
  await Promise.race([
    micState,
    new Promise((_, rejectState) =>
      setTimeout(
        () => rejectState(new Error('remote-lan smoke FAIL: mic state never confirmed')),
        15000
      )
    )
  ])
  console.log('remote-lan smoke: signed intent + confirmed state OK')

  const snapshot = await device.chatSnapshot()
  if (!Array.isArray(snapshot.messages) || snapshot.highlight?.phase !== 'idle') {
    fail(`unexpected chat snapshot: ${JSON.stringify(snapshot)}`)
  }
  const refused = await device.intent({ kind: 'commentHighlight', messageId: 'youtube:missing' })
  if (refused.ok || !/no longer available/i.test(refused.message ?? '')) {
    fail(`commentHighlight for a missing comment: ${JSON.stringify(refused)}`)
  }
  const forbidden = await device.request('liveChat.snapshot').then(
    () => null,
    (error) => error
  )
  if (forbidden?.code !== 'forbidden-method') fail('liveChat.snapshot was reachable from a phone')
  console.log('remote-lan smoke: chat snapshot + highlight refusal + allowlist OK')

  // 5. backend.ready never reaches a remote socket.
  const deck = await connectRemote('127.0.0.1', master.port, master.token, { timeoutMs })
  const seenByDeck = []
  deck.on('message', (raw) => seenByDeck.push(String(raw)))
  await remoteRequest(deck, 'remote.describe', undefined, { timeoutMs })
  for (const [label, frames] of [
    ['phone', seenByPhone],
    ['deck', seenByDeck]
  ]) {
    const joined = frames.join('\n')
    if (joined.includes('backend.ready') || joined.includes(backend.token)) {
      fail(`${label} socket received the renderer credential`)
    }
  }
  console.log('remote-lan smoke: no renderer credential on remote sockets OK')

  // 6. Revoke cuts the phone only.
  const phoneClosed = new Promise((resolveClose) =>
    device.ws.addEventListener('close', resolveClose)
  )
  await request(renderer, timeoutMs, 'remote.lan.devices.revoke', { id: credentials.deviceId })
  await Promise.race([
    phoneClosed,
    new Promise((_, rejectClose) =>
      setTimeout(
        () => rejectClose(new Error('remote-lan smoke FAIL: revoked phone stayed connected')),
        10000
      )
    )
  ])
  const stillUp = await remoteRequest(deck, 'remote.describe', undefined, { timeoutMs })
  if (!stillUp.ok) fail('revoking a phone cut the loopback client')
  const revoked = await phone(wsUrl, credentials)
    .connect()
    .then(
      () => null,
      (error) => error
    )
  if (revoked?.code !== 'unknown-device') fail('a revoked phone could re-authenticate')
  console.log('remote-lan smoke: revoke cuts one device OK')

  // 7. Disable closes the port.
  await request(renderer, timeoutMs, 'remote.lan.disable')
  await waitFor(
    () =>
      fetch(`${origin}/`).then(
        () => false,
        () => true
      ),
    'the LAN port to close'
  )
  deck.close()
  console.log('remote-lan smoke: PASS')
} catch (error) {
  if (!(error instanceof SkipSmoke)) {
    process.exitCode = 1
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  }
} finally {
  try {
    await stopApp()
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}
