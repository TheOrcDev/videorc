import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import {
  startFakeCloudWebManaged,
  managedWire as w,
  managedPath
} from './fake-cloud-web-managed.mjs'
import { assertNothingReplayable } from './cloud-parity-handoff.mjs'

// Plan 249 S24: the fake web's controller and kept presentation follow the
// web's rules, so the `handoff` case judges the desktop against them. Local
// HTTP only; no LiveKit, provider or real page.

const A = 'A'.repeat(22)
const B = 'B'.repeat(22)
const output = { orientation: 'horizontal', width: 1280, height: 720, fps: 30, videoKbps: 4000 }

async function fixture(t) {
  const web = await startFakeCloudWebManaged({
    maxShows: 4,
    waitScale: 0.01,
    ingest: [
      {
        orientation: 'horizontal',
        serverUrl: 'rtmps://localhost/live',
        streamKey: randomBytes(16).toString('hex')
      }
    ]
  })
  t.after(() => web.close())
  const fetchJson = async (method, path, body, headers = {}) => {
    const res = await fetch(`${web.httpOrigin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${web.sessionToken}`,
        'content-type': 'application/json',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const type = res.headers.get('content-type') ?? ''
    return {
      status: res.status,
      body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
    }
  }
  const created = await fetchJson('POST', managedPath('create'), {
    kind: 'talk',
    outputs: [output],
    client: { app: 'videorc', version: '0.26.0' }
  })
  assert.equal(created.status, 201)
  const id = created.body.show.id
  const base = `${managedPath('create')}/${id}`
  const controller = (body) => fetchJson('POST', `${base}/controller`, body)
  const epochHeader = (epoch) => ({ 'videorc-controller-epoch': String(epoch) })
  const named = (name, body, epoch) =>
    fetchJson(w.routes[name].method, managedPath(name, id), body, epochHeader(epoch))
  return { web, id, base, fetchJson, controller, epochHeader, named }
}

function png(width, height) {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  const bytes = Buffer.concat([
    header,
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  ])
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    png: bytes.toString('base64'),
    width,
    height
  }
}

test('a takeover moves the epoch once; the old controller is refused, End included', async (t) => {
  const f = await fixture(t)
  const first = await f.controller({ device: { id: A }, intent: 'claim' })
  assert.equal(first.body.controller.controllerEpoch, 1)
  const held = await f.controller({ device: { id: B }, intent: 'claim' })
  assert.equal(held.status, 409)
  assert.equal(held.body.error.code, 'cloud-controller-held')
  const taken = await f.controller({ device: { id: B }, intent: 'takeover', epoch: 1 })
  assert.equal(taken.body.controller.controllerEpoch, 2)
  assert.equal(taken.body.controller.takenOverFrom, 'another-device')
  const renew = await f.controller({ device: { id: A }, intent: 'renew', epoch: 1 })
  assert.equal(renew.body.error.code, 'cloud-controller-stale')
  for (const [name, body] of [
    ['stage', { layout: 'solo', onStage: [] }],
    ['end', {}]
  ]) {
    const answer = await f.named(name, body, 1)
    assert.equal(answer.status, 409, name)
    assert.equal(answer.body.error.code, 'cloud-controller-stale')
  }
  // Leaving the header out is no way around it, End included.
  const unnamed = await f.fetchJson('PUT', managedPath('stage', f.id), {
    layout: 'solo',
    onStage: []
  })
  assert.equal(unnamed.body.error.code, 'cloud-controller-required')
  const unnamedEnd = await f.fetchJson(w.routes.end.method, managedPath('end', f.id), {})
  assert.equal(unnamedEnd.body.error.code, 'cloud-controller-required')
  assert.equal(f.web.shows.get(f.id).show.endedAt ?? null, null)
  assert.deepEqual(
    f.web.hooks.controllerRefusals().map((r) => `${r.route}:${r.code}`),
    [
      'stage:cloud-controller-stale',
      'end:cloud-controller-stale',
      'stage:cloud-controller-required',
      'end:cloud-controller-required'
    ]
  )
  assert.deepEqual(
    f.web.hooks.controllerLog().map((entry) => entry.epoch),
    [1, 2]
  )
})

test('the enabled list reaches only the new controller, as needsEnable', async (t) => {
  const f = await fixture(t)
  await f.controller({ device: { id: A }, intent: 'claim' })
  await f.fetchJson(
    'PUT',
    `${f.base}/controller`,
    { enabled: { camera: true, microphone: true } },
    f.epochHeader(1)
  )
  const taken = await f.controller({ device: { id: B }, intent: 'takeover', epoch: 1 })
  assert.deepEqual(taken.body.controller.needsEnable, ['camera', 'microphone'])
  assert.deepEqual(f.web.hooks.controller(f.id).enabled, {})
})

test('kept presentation: the avatar stays, its bubble never; read back by the current epoch only', async (t) => {
  const f = await fixture(t)
  await f.controller({ device: { id: A }, intent: 'claim' })
  const avatar = png(64, 64)
  const put = (epoch, layers, revision = 1) =>
    f.fetchJson('PUT', `${f.base}/presentation`, {
      controllerEpoch: epoch,
      topic: 'avatar',
      output: 'stream',
      orientation: 'h',
      publisherSid: 'PA_host',
      revision,
      layers
    })
  const rect = { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }
  const stored = await put(1, [
    { kind: 'avatar', rect, asset: avatar, expiresAt: null },
    { kind: 'bubble', rect, asset: png(96, 32), expiresAt: Date.now() + 9000 }
  ])
  assert.deepEqual(
    { kept: stored.body.kept, dropped: stored.body.dropped },
    { kept: 1, dropped: 1 }
  )
  assertNothingReplayable(f.web.hooks.presentation(f.id))
  const { png: _png, ...ref } = png(80, 80)
  const missing = await put(1, [{ kind: 'avatar', rect, asset: ref, expiresAt: null }], 2)
  assert.equal(missing.status, 422)
  await f.controller({ device: { id: B }, intent: 'takeover', epoch: 1 })
  assert.equal((await put(1, [], 3)).status, 409, 'the old controller cannot write')
  const stale = await f.fetchJson('GET', `${f.base}/presentation`, undefined, f.epochHeader(1))
  assert.equal(stale.status, 409)
  const restore = await f.fetchJson('GET', `${f.base}/presentation`, undefined, f.epochHeader(2))
  assert.equal(restore.body.controllerEpoch, 2)
  assert.equal(restore.body.continuity.programDuringHostLoss, 'cleared-after-transport-lease')
  assert.deepEqual(
    restore.body.views.map((v) => [v.topic, v.applied, v.layers.map((l) => l.kind)]),
    [['avatar', false, ['avatar']]]
  )
  const pixels = await f.fetchJson(
    'GET',
    `${f.base}/presentation?asset=${avatar.hash}`,
    undefined,
    f.epochHeader(2)
  )
  assert.equal(createHash('sha256').update(pixels.body).digest('hex'), avatar.hash)
})

test('a kept bubble or card fails the D9 check', () => {
  assert.throws(() =>
    assertNothingReplayable([
      { topic: 'avatar', output: 'stream', orientation: 'h', kept: [{ kind: 'bubble' }] }
    ])
  )
  assert.doesNotThrow(() =>
    assertNothingReplayable([
      { topic: 'avatar', output: 'stream', orientation: 'h', kept: [{ kind: 'avatar' }] }
    ])
  )
})
