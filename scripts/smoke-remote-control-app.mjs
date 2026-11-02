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
//      reflects them (backend-confirmed state, not optimistic); clipMark and
//      systemAudioToggle relay through the renderer
//   5. token regenerate closes the paired client
//
// No recording is started: the intents exercised here are disk-free.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchDevApp } from './lib/app-launcher.mjs'
import {
  connectRemote as connectRemoteClient,
  remoteRequest as remoteRequestClient,
  waitForRemoteEvent as waitForRemoteEventClient
} from './lib/remote-control-client.mjs'
import { syntheticCompositorReady } from './lib/remote-control-smoke-gates.mjs'
import { CAPTURE_CONFIG_STORAGE_KEY, RELOAD_KEEPING_SEED_JS } from './lib/renderer-profile-seed.mjs'
import { requestSmokeCommand, waitForRendererHook } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-remote-control-user-data-'))

function fail(message) {
  throw new Error(`remote-control smoke FAIL: ${message}`)
}

const connectRemote = (host, port, token) => connectRemoteClient(host, port, token, { timeoutMs })
const remoteRequest = (ws, method, params) => remoteRequestClient(ws, method, params, { timeoutMs })
const waitForRemoteEvent = (ws, event, predicate) =>
  waitForRemoteEventClient(ws, event, predicate, { timeoutMs })

async function waitForBackendState(connection, method, predicate, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(connection, timeoutMs, method)
    if (predicate(last)) return last
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
  fail(`timed out waiting for ${label}; last ${method}: ${JSON.stringify(last)}`)
}

let stopApp = async () => {}
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_USER_DATA_DIR: userDataDir
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_REMOTE_SMOKE_DEBUG === '1') {
        console.log('[app]', line)
      }
    }
  })
  stopApp = launch.stop
  const renderer = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  const smoke = launch.connections['preview-motion-ready']

  // A camera-free profile, as the record-latency smoke seeds: the ring checked
  // in 4b runs the app's own scene, and the default layout shows a camera.
  // On a host whose camera the dev app can read (Linux) that camera gives no
  // frames here (no source preview), so the ring was refused three times and
  // gave up before 4's sceneApply removed the camera; Camera off holds the
  // ring on its blocked reason instead, and screen-only clears it.
  await waitForRendererHook(smoke, '__videorcSmokeSetReplayBuffer', { timeoutMs })
  await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const key = ${JSON.stringify(CAPTURE_CONFIG_STORAGE_KEY)};
        let current = {};
        try { current = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch {}
        // Camera None on purpose: no id (capture.ts drops cameraOff beside one).
        const sources = { ...(current.sources ?? {}), cameraId: undefined, cameraName: undefined, cameraOff: true };
        localStorage.setItem(key, JSON.stringify({ ...current, sources }));
        window.__remoteSmokeBeforeReload = true;
        ${RELOAD_KEEPING_SEED_JS}
        return true;
      `
    },
    { timeoutMs }
  )
  const reloadDeadline = Date.now() + timeoutMs
  for (;;) {
    const reloaded = await requestSmokeCommand(
      smoke,
      'eval-js',
      {
        code: 'return !window.__remoteSmokeBeforeReload && typeof window.__videorcSmokeSetReplayBuffer === "function"'
      },
      { timeoutMs: 5000 }
    ).catch(() => null)
    if (reloaded?.result === true) break
    if (Date.now() > reloadDeadline) fail('the renderer did not reload its camera-free profile')
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }

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
        console.log(
          '[DEBUG-rc] renderer saw event:',
          message.event,
          JSON.stringify(message.payload).slice(0, 120)
        )
      }
    })
    remote.on('message', (raw) => {
      console.log('[DEBUG-rc] remote saw:', String(raw).slice(0, 160))
    })
  }
  const micAckPromise = waitForRemoteEvent(remote, 'remote.ack')
  const micStatePromise = waitForRemoteEvent(
    remote,
    'remote.state',
    (state) => state?.micMuted === !micBefore
  )
  const micTicket = await remoteRequest(remote, 'remote.intent', { kind: 'micToggle' })
  if (!micTicket.payload?.accepted) fail('micToggle intent was not accepted')
  const micAck = await micAckPromise
  if (micAck?.intentId !== micTicket.payload.intentId || micAck?.ok !== true) {
    fail(`micToggle was not acknowledged successfully: ${JSON.stringify(micAck)}`)
  }
  await micStatePromise
  console.log('remote-control smoke: micToggle ack + confirmed state OK')

  // The isolated profile intentionally has no persisted capture source. Arm the
  // same deterministic renderer-owned test pattern used by the other live app
  // smokes, then prove the backend compositor is actually rendering it before
  // asking the remote surface to commit a screen-backed layout.
  const compositorBeforeSynthetic = await request(renderer, timeoutMs, 'compositor.status')
  await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
  await waitForBackendState(
    renderer,
    'compositor.status',
    (compositor) => syntheticCompositorReady(compositor, compositorBeforeSynthetic),
    'synthetic compositor readiness'
  )

  const sceneAckPromise = waitForRemoteEvent(remote, 'remote.ack')
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

  const sceneAck = await sceneAckPromise
  if (sceneAck?.intentId !== sceneTicket.payload.intentId || sceneAck?.ok !== true) {
    fail(`sceneApply was not acknowledged successfully: ${JSON.stringify(sceneAck)}`)
  }
  await sceneStatePromise
  console.log('remote-control smoke: sceneApply ack + confirmed state OK')

  // 4b. clipMark (plan 068 D6; plan 181 R4) is on the allowlist and relays
  // through the renderer. Explicitly enable Clips using the Output switch's
  // own path: automatic startup intentionally refuses software encoders such
  // as OpenH264. This tests the remote command on either encoder, not whether
  // the default is admitted. With the ring on, the press saves a clip (the
  // file is proven by pnpm smoke:replay-buffer); with it off, the renderer
  // refuses with the reason. Both round trips must acknowledge the ticket.
  const enabled = await requestSmokeCommand(
    smoke,
    'eval-js',
    { code: 'return window.__videorcSmokeSetReplayBuffer?.(true) ?? null' },
    { timeoutMs }
  )
  if (enabled?.result !== true) fail('the renderer has no clip buffer smoke hook')
  const ringOn = await waitForBackendState(
    renderer,
    'replay.status',
    (ring) => ring?.state === 'on',
    'the explicitly enabled ring'
  )
  console.log(`remote-control smoke: ring on after explicit enable (${ringOn.seconds} s)`)
  const clipOnAckPromise = waitForRemoteEvent(remote, 'remote.ack')
  const clipOnTicket = await remoteRequest(remote, 'remote.intent', { kind: 'clipMark' })
  if (!clipOnTicket.payload?.accepted) fail('clipMark intent was not accepted')
  const clipOnAck = await clipOnAckPromise
  if (clipOnAck?.intentId !== clipOnTicket.payload.intentId || clipOnAck?.ok !== true) {
    fail(`clipMark with the ring on was not acknowledged: ${JSON.stringify(clipOnAck)}`)
  }
  console.log('remote-control smoke: clipMark relay with the ring on OK')
  await waitForRendererHook(smoke, '__videorcSmokeSetReplayBuffer', { timeoutMs })
  const switched = await requestSmokeCommand(
    smoke,
    'eval-js',
    { code: 'return window.__videorcSmokeSetReplayBuffer?.(false) ?? null' },
    { timeoutMs }
  )
  if (switched?.result !== true) fail('the renderer has no clip buffer smoke hook')
  await waitForBackendState(
    renderer,
    'replay.status',
    (ring) => ring?.state === 'off',
    'the ring off after the switch'
  )
  // A buffer-only stop is quick enough to land inside the 150 ms debounce
  // window of the clip intent above: let it pass, this is not the bounce test.
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 400))
  const clipAckPromise = waitForRemoteEvent(remote, 'remote.ack')
  const clipTicket = await remoteRequest(remote, 'remote.intent', { kind: 'clipMark' })
  if (!clipTicket.payload?.accepted) {
    fail(`clipMark intent was not accepted: ${JSON.stringify(clipTicket.payload)}`)
  }
  const clipAck = await clipAckPromise
  if (clipAck?.intentId !== clipTicket.payload.intentId || clipAck?.ok !== false) {
    fail(
      `clipMark with the ring off and no session was not refused through the renderer: ${JSON.stringify(clipAck)}`
    )
  }
  if (clipAck?.message !== "Clips are off, and you're not recording or live.") {
    fail(`clipMark refusal carried the wrong reason: ${JSON.stringify(clipAck)}`)
  }
  console.log('remote-control smoke: clipMark relay + refusal reason OK')

  // 4c. System audio (plan 069 S6): the projection carries exactly two
  // booleans, and systemAudioToggle relays through the renderer. With the
  // Screen Recording grant it flips the confirmed state (and is flipped back);
  // without it the renderer refuses with a reason and nothing changes.
  const systemAudioState = (await remoteRequest(remote, 'remote.describe')).payload?.state
  if (
    typeof systemAudioState?.systemAudioOn !== 'boolean' ||
    typeof systemAudioState?.systemAudioAvailable !== 'boolean'
  ) {
    fail(`remote.state lacks the system-audio booleans: ${JSON.stringify(systemAudioState)}`)
  }
  const toggleSystemAudio = async (expectOn) => {
    const ackPromise = waitForRemoteEvent(remote, 'remote.ack')
    const statePromise =
      expectOn === null
        ? null
        : waitForRemoteEvent(remote, 'remote.state', (state) => state?.systemAudioOn === expectOn)
    const ticket = await remoteRequest(remote, 'remote.intent', { kind: 'systemAudioToggle' })
    if (!ticket.payload?.accepted) fail('systemAudioToggle intent was not accepted')
    const ack = await ackPromise
    if (ack?.intentId !== ticket.payload.intentId)
      fail(`systemAudioToggle ack mismatch: ${JSON.stringify(ack)}`)
    await statePromise
    return ack
  }
  if (systemAudioState.systemAudioAvailable) {
    const before = systemAudioState.systemAudioOn
    const on = await toggleSystemAudio(!before)
    if (on?.ok !== true) fail(`systemAudioToggle was not applied: ${JSON.stringify(on)}`)
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
    const back = await toggleSystemAudio(before)
    if (back?.ok !== true) fail(`systemAudioToggle back was not applied: ${JSON.stringify(back)}`)
    console.log('remote-control smoke: systemAudioToggle ack + confirmed state OK')
  } else {
    const refused = await toggleSystemAudio(null)
    if (refused?.ok !== false || refused?.message !== "System audio isn't available.") {
      fail(`systemAudioToggle without the device was not refused: ${JSON.stringify(refused)}`)
    }
    console.log('remote-control smoke: systemAudioToggle refused without the device OK')
  }

  // Plan 210 S6: a saved-scene key uses only the projected id and name.
  const saved = await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `return window.__videorcSmokeScenePresets.save('Figma');`
    },
    { timeoutMs }
  )
  if (saved?.result !== true) fail(`could not save the Figma fixture: ${JSON.stringify(saved)}`)
  const catalog = await waitForBackendState(
    renderer,
    'remote.describe',
    (surface) => surface?.state?.savedScenes?.some((scene) => scene.name === 'Figma'),
    'saved scene projection'
  )
  const savedScene = catalog.state.savedScenes.find((scene) => scene.name === 'Figma')
  if (Object.keys(savedScene).sort().join(',') !== 'id,name')
    fail('saved scene projection leaked extra fields')
  await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `window.__videorcSmokeScenePresets.layout({ layoutPreset: 'screen-only' }); return true;`
    },
    { timeoutMs }
  )
  await waitForBackendState(
    renderer,
    'remote.describe',
    (surface) => surface?.state?.activeSavedSceneId === null,
    'built-in layout confirmation'
  )
  const savedAckPromise = waitForRemoteEvent(remote, 'remote.ack')
  const savedStatePromise = waitForRemoteEvent(
    remote,
    'remote.state',
    (state) => state?.activeSavedSceneId === savedScene.id
  )
  const savedTicket = await remoteRequest(remote, 'remote.intent', {
    kind: 'sceneApply',
    sceneId: savedScene.id
  })
  if (!savedTicket.payload?.accepted) fail('saved scene intent not accepted')
  const savedAck = await savedAckPromise
  if (savedAck?.intentId !== savedTicket.payload.intentId || savedAck?.ok !== true)
    fail(`saved scene intent refused: ${JSON.stringify(savedAck)}`)
  await savedStatePromise
  console.log('remote-control smoke: saved Figma scene ack + confirmed state OK')

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
