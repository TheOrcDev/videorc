/** S19 real-app/local-page acquisition; never imported by focused tests. No paid provider. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFileSync, readFileSync } from 'node:fs'
import { waitFor, holdFor } from './cloud-managed-smoke.mjs'
import { prepareParityRoom } from './cloud-parity-controls.mjs'
import { assessMarkers } from './cloud-parity-markers-contract.mjs'
export async function installMarkers(h, webRoot) {
  const require = createRequire(join(webRoot, 'package.json'))
  const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href)
  const { markerFixture } = await tsImport(join(webRoot, 'tests/fixtures/cloud-markers-kit.ts'), {
    parentURL: import.meta.url,
    tsconfig: join(webRoot, 'tsconfig.json')
  })
  const handler = markerFixture()
  h.web.hooks.markerHandler((request, s) => {
    const show = {
      ...s.show,
      userId: 'fixture-owner',
      createdAt: new Date(s.show.createdAt),
      expiresAt: new Date(s.show.expiresAt)
    }
    const side =
      s.state.recording?.active && s.markerTake
        ? {
            recordTakeId: s.markerTake.id,
            recordEgressId: s.markerTake.provider,
            recordEgressStatus: 'active'
          }
        : {}
    return handler(
      request,
      show,
      { state: { liveInterval: s.state.liveInterval }, h: side, v: {} },
      s.controller
    )
  })
}
export async function exerciseMarkers({ h, output }) {
  const showId = h.showId,
    marks = []
  const save = async (label, operationId = randomUUID()) => {
    const mark = await h.rpc('cloud.marker.create', { showId, operationId, label })
    marks.push(mark)
    return mark
  }
  const ownerPaths = await exerciseOwnerPaths(h, showId)
  const first = await save('room-only')
  assert.equal(first.media.reason, 'no-recording')
  const replay = await save('room-only', first.id)
  assert.deepEqual(replay, first)
  await h.cutHostRoom()
  await h.forwardHostRoom()
  await h.status((s) => s.room?.client === 'connected', 'host reconnected')
  const afterReconnect = await save('after reconnect')
  await h.rpc('cloud.recording.start')
  await h.status((s) => s.recording?.active, 'record-only take')
  const recordOnly = await save('record-only')
  assert.equal(recordOnly.target.liveIntervalId, null)
  assert.ok(recordOnly.target.takeIds.length)
  await h.rpc('cloud.show.goLive', { streaming: h.streaming() })
  await h.status((s) => s.room?.live, 'first live interval')
  const live = await save('first interval')
  await h.rpc('cloud.show.legs.end')
  await h.status((s) => !s.room?.live && s.recording?.active, 'End preserves take')
  const ended = await save('between intervals')
  await h.rpc('cloud.show.goLive', { streaming: h.streaming() })
  await h.status((s) => s.room?.live, 'second live interval')
  const next = await save('second interval')
  assert.deepEqual(
    await h.rpc('cloud.marker.create', { showId, operationId: live.id, label: 'first interval' }),
    live
  )
  // A second computer uses its own disposable profile and account session; the server journal remains shared.
  // Real processed host tap through injected fake speech; guests already publish but never issue voice marks.
  await h.eval('window.__videorcSmokeScenePresets.markerConsent(true);return true')
  await h.rpc('cohost.settings.set', { enabled: true, listen: true })
  await h.rpc('cloud.marker.voice.configure', { showId, consent: true })
  await h.eval(
    "const s=window.__videorcSmokeScenePresets,c=s.streamingState().captureConfig;s.configure({captions:{...c.captions,enabled:true,burnTarget:'both'}});return true"
  )
  await waitFor(() => h.speech.state.audioBytes > 0, 'processed host speech reaches fake gateway')
  await h.speech.emitRealtimeFinal('Sidekick make a marker for HOST VOICE S19')
  const voiceRequests = () =>
    h.web.calls.filter(
      (c) =>
        c.path.endsWith('/markers') &&
        c.method === 'POST' &&
        c.body.source === 'voice' &&
        c.status === 200
    ).length
  await waitFor(() => voiceRequests() > 0, 'host voice accepted')
  const voice = (await h.rpc('cloud.markers.list', { showId })).markers.find(
    (m) => m.source === 'voice'
  )
  assert.equal(voice.sourcePosition.uncertaintyMs, null)
  await h.eval('window.__videorcSmokeScenePresets.markerConsent(false);return true')
  await h.rpc('cloud.marker.voice.configure', { showId, consent: false })
  const voiceCount = voiceRequests()
  await h.speech.emitRealtimeFinal('Sidekick make a marker for DISABLED S19')
  await holdFor(() => voiceRequests() === voiceCount, 'disabled marker consent')
  await h.eval("await window.__videorcSmokeScenePresets.microphone('mute');return true")
  const bytes = h.speech.state.audioBytes
  await holdFor(() => h.speech.state.audioBytes === bytes, 'muted host uploads nothing')
  await h.freshComputer()
  await prepareParityRoom(h, false)
  await h.rpc('cloud.show.resume')
  await h.status((s) => s.show?.id === showId && s.room?.client === 'connected', 'successor host')
  const recovered = await h.rpc('cloud.marker.get', { showId, markerId: first.id })
  assert.deepEqual(recovered, { status: 'found', marker: first })
  const afterHandoff = await save('successor')
  const clip = await h.rpc('clip.mark', { seconds: 30, requestId: 's19-repeated-clip' })
  assert.deepEqual(await h.rpc('clip.mark', { seconds: 30, requestId: 's19-repeated-clip' }), clip)
  assert.equal(clip.reason, 'cloud-marker-no-media')
  assert.equal((await h.rpc('recording.status')).state, 'idle', 'No fake native capture')
  const report = {
    ownerPaths,
    marks,
    first,
    afterReconnect,
    recordOnly,
    live,
    ended,
    next,
    afterHandoff,
    clip,
    productionQualified: false,
    managed: 'not-run',
    nativeToShowUncertaintyMs: null
  }
  const result = assessMarkers(report)
  writeFileSync(
    join(output, 'markers-evidence.json'),
    JSON.stringify({ ...report, analysis: result }, null, 2) + '\n'
  )
  return result
}

/** Exercises real composer, authenticated remote listener and allowlisted agent tools. */
async function exerciseOwnerPaths(h, showId) {
  await h.command('comments-window-open')
  await waitFor(
    async () => (await h.eval('return window.videorc.getMarkerContext()'))?.cloudShowId === showId,
    'composer show target'
  )
  await waitFor(
    async () => (await h.command('comments-window-reader-state')).composerCount === 1,
    'composer available'
  )
  assert.equal(
    (await h.command('comments-window-submit-message', { text: '/marker S19 UI MARK' })).submitted,
    true
  )
  await waitFor(
    () =>
      h.web.calls.some(
        (c) => c.path.endsWith('/markers') && c.body.label === 'S19 UI MARK' && c.status === 200
      ),
    'composer marker persisted'
  )
  const { connectRemote, remoteRequest, waitForRemoteEvent, waitForRemoteDescribe } =
    await import('./remote-control-client.mjs')
  const { postMcp } = await import('./agent-mcp-client.mjs')
  let deck, agentId
  try {
    const remote = await h.rpc('remote.control.enable'),
      discovery = JSON.parse(readFileSync(remote.discoveryPath, 'utf8'))
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(discovery.host))
    deck = await connectRemote(discovery.host, discovery.port, discovery.token)
    await waitForRemoteDescribe(deck)
    const ack = waitForRemoteEvent(deck, 'remote.ack', () => true, { timeoutMs: 15000 }),
      ticket = await remoteRequest(deck, 'remote.intent', { kind: 'clipMark', seconds: 30 }),
      settled = await ack
    assert.equal(ticket.payload.accepted, true)
    assert.equal(settled.intentId, ticket.payload.intentId)
    assert.equal(settled.ok, true)
    assert.match(settled.message, /no media to extract/)
    const enabled = await h.rpc('agents.enable'),
      created = await h.rpc('agents.create', { name: 'S19 fixture', client: 'other' })
    agentId = created.id ?? created.agent?.id
    const operationId = randomUUID()
    const call = async () => {
      const response = await postMcp({
        port: enabled.port,
        token: created.token,
        body: {
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: { name: 'add_marker', arguments: { title: 'S19 AGENT MARK', operationId } }
        }
      })
      assert.equal(response.status, 200)
      const body = JSON.parse(response.body)
      assert.ok(!body.error && !body.result?.isError)
      return body.result.structuredContent
    }
    const first = await call()
    assert.deepEqual(await call(), first)
    assert.equal(first.showId, showId)
    assert.equal(first.mediaAvailable, false)
    assert.ok(!('sessionId' in first))
    const page = await h.rpc('cloud.markers.list', { showId })
    assert.ok(page.markers.some((m) => m.source === 'remote'))
    assert.equal(page.markers.filter((m) => m.id === operationId).length, 1)
    return { composer: true, remote: true, agent: true, repeatedAgentOperation: true }
  } finally {
    deck?.close()
    if (agentId) await h.rpc('agents.remove', { id: agentId }).catch(() => {})
    await h.rpc('agents.stop').catch(() => {})
    await h.rpc('remote.control.disable').catch(() => {})
    await h.command('comments-window-close').catch(() => {})
  }
}
