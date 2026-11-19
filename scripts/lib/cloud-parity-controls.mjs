/** Maintained real-page controls case, intentionally never imported by unit tests.
 * Uses only an isolated profile, fake browser media, local LiveKit and fake cloud.
 * Controller Stop evidence is NOT encoded managed-egress acceptance. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import {
  RemoteClient,
  parseFragment
} from '../../crates/videorc-backend/remote_web/remote-client.js'
import {
  connectRemote,
  remoteRequest,
  waitForRemoteEvent,
  waitForRemoteDescribe
} from './remote-control-client.mjs'
import { postMcp } from './agent-mcp-client.mjs'
import { waitFor } from './cloud-managed-smoke.mjs'
import { roomFixtureDevicesSource } from './room-fixture-devices.mjs'
import {
  CONTROL_LANES,
  assertControlAudio,
  assertIndependentStop
} from './cloud-parity-controls-contract.mjs'

/** The fake Chromium devices have labels unlike the native fixture catalog:
 * see `roomFixtureDevicesSource`. */
export async function prepareParityRoom(h, controls) {
  return h.eval(roomFixtureDevicesSource(controls))
}

export async function assertInitialRoomControls(h, cameraId) {
  const host = (await h.web.roomRpc('ListParticipants', { room: h.showId })).participants.find(
    (p) => p.identity === 'host:' + h.showId
  )
  assert.ok(host, 'The host must have joined')
  assert.ok(
    !host.tracks.some((t) => t.source === 'CAMERA' || t.source === 1),
    'None must publish no camera'
  )
  const mic = host.tracks.find((t) => t.source === 'MICROPHONE' || t.source === 2)
  assert.ok(mic?.muted, 'The initial microphone must be muted before publication')
  assert.equal(
    await h.eval(
      `await window.__videorcSmokeScenePresets.camera(${JSON.stringify(cameraId)}); return await window.__videorcSmokeScenePresets.microphone('unmute')`
    ),
    true,
    'Initial mute must be explicitly reversible'
  )
}

export async function exerciseControls({ h, clients, captureAudio, report, cameraId }) {
  let deck, phone, agentId, agentPort, agentToken
  const controlReport = {
    status: 'running',
    initialNoneAndMute: true,
    lanes: [],
    outputStops: 'not-run',
    managedEgress: 'not-run',
    physicalDevices: 'not-run'
  }
  report.controls = controlReport
  const facts = () => h.eval('return window.__videorcSmokeScenePresets.outputFacts()')
  const setMic = async (muted) => {
    assert.equal(
      await h.eval(
        `return await window.__videorcSmokeScenePresets.microphone('${muted ? 'mute' : 'unmute'}')`
      ),
      true
    )
    await waitFor(async () => (await facts()).microphoneMuted === muted, 'confirmed microphone')
  }
  const click = async (selector) => {
    assert.equal(
      await h.eval(
        `const button = document.querySelector(${JSON.stringify(selector)}); if (!button || button.disabled) return false; button.click(); return true`
      ),
      true,
      `Missing enabled control ${selector}`
    )
  }
  const agentCall = async (name, args = {}) => {
    const response = await postMcp({
      port: agentPort,
      token: agentToken,
      body: {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: args }
      }
    })
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body)
    assert.ok(!body.error && !body.result?.isError, `${name} refused`)
    return body.result.structuredContent
  }
  const deckIntent = async (kind) => {
    const ack = waitForRemoteEvent(deck, 'remote.ack', () => true, { timeoutMs: 15000 })
    const ticket = await remoteRequest(deck, 'remote.intent', { kind })
    const settled = await ack
    assert.equal(ticket.payload?.accepted, true)
    assert.equal(settled.intentId, ticket.payload.intentId)
    assert.equal(settled.ok, true)
  }
  try {
    const remote = await h.rpc('remote.control.enable')
    const discovery = JSON.parse(readFileSync(remote.discoveryPath, 'utf8'))
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(discovery.host))
    deck = await connectRemote(discovery.host, discovery.port, discovery.token)
    await waitForRemoteDescribe(deck)
    const enabled = await h.rpc('agents.enable')
    agentPort = enabled.port
    const created = await h.rpc('agents.create', { name: 'Parity fixture', client: 'other' })
    agentId = created.id ?? created.agent?.id
    agentToken = created.token
    const lan = await h.rpc('remote.lan.enable')
    assert.ok(lan.port, 'Phone remote listener unavailable; this case cannot pass')
    const pairing = await h.rpc('remote.lan.pairing.begin', {})
    const pairedUrl = new URL(pairing.url)
    phone = new RemoteClient({
      url: `ws://127.0.0.1:${pairedUrl.port}/ws`,
      credentials: parseFragment(pairedUrl.hash),
      deviceName: 'Parity fixture',
      WebSocketImpl: WebSocket,
      reconnect: false
    })
    await phone.connect()
    await waitFor(
      async () => (await agentCall('get_status')).outputSession?.owner === 'cloud-room',
      'agent room facts'
    )
    for (const lane of CONTROL_LANES) {
      await setMic(false)
      if (lane === 'tile') {
        await h.command('open-tab', { tab: 'studio' })
        await click(`[data-stage-identity="host:${h.showId}"] [data-testid="show-stage-mute"]`)
      } else if (lane === 'mixer') {
        await h.command('open-tab', { tab: 'sources' })
        await click('button[aria-label="Mute microphone"]')
      } else if (lane === 'hotkey') {
        await h.eval("window.__videorcSmokeScenePresets.shortcut('mic-toggle'); return true")
      } else if (lane === 'deck') await deckIntent('micMute')
      else if (lane === 'phone') assert.equal((await phone.intent({ kind: 'micMute' })).ok, true)
      else await agentCall('set_audio', { microphone: { muted: true } })
      await waitFor(async () => (await facts()).microphoneMuted === true, `${lane} mute confirmed`)
      assertControlAudio(await captureAudio(`controls-${lane}-muted`, clients), true)
      await setMic(false)
      assertControlAudio(await captureAudio(`controls-${lane}-restored`, clients), false)
      controlReport.lanes.push({ lane, status: 'passed' })
    }
    await h.eval('await window.__videorcSmokeScenePresets.camera(null); return true')
    await waitFor(async () => {
      const host = (await h.web.roomRpc('ListParticipants', { room: h.showId })).participants.find(
        (p) => p.identity === `host:${h.showId}`
      )
      return host && !host.tracks.some((t) => t.source === 1 || t.source === 'CAMERA')
    }, 'None unpublishes physical picture')
    await h.eval(
      `await window.__videorcSmokeScenePresets.camera(${JSON.stringify(cameraId)}); return true`
    )

    await h.rpc('cloud.show.goLive', { streaming: h.streaming() })
    await h.rpc('cloud.recording.start')
    await h.status((s) => s.room?.live && s.recording?.active, 'both cloud outputs')
    await deckIntent('recordStop')
    assertIndependentStop(await h.rpc('cloud.status'), 'recording')
    await h.rpc('cloud.recording.start')
    await deckIntent('streamStop')
    assertIndependentStop(await h.rpc('cloud.status'), 'live')
    await agentCall('stop')
    await h.status(
      (s) => !s.room?.live && !s.recording?.active && s.room?.phase === 'open',
      'agent record-only Stop'
    )
    assert.equal(
      (await h.rpc('recording.status')).state,
      'idle',
      'No native session was fabricated'
    )
    controlReport.outputStops = 'passed-controller-fixture'
    controlReport.status = 'passed'
  } catch (error) {
    controlReport.status = 'failed'
    throw error
  } finally {
    deck?.close()
    phone?.close()
    // All access belongs to this disposable profile; cleanup never touches the owner profile.
    if (agentId) await h.rpc('agents.remove', { id: agentId }).catch(() => {})
    await Promise.all([
      h.rpc('agents.stop'),
      h.rpc('remote.control.disable'),
      h.rpc('remote.lan.disable')
    ])
  }
}
