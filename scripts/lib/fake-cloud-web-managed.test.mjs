import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  startFakeCloudWebManaged,
  managedWire as w,
  managedPath,
  maskManagedUrls,
  managedVersionAllowed,
  managedHandoffAllowed,
  destinationProblem
} from './fake-cloud-web-managed.mjs'

let certDir, tls
before(() => {
  certDir = mkdtempSync(join(tmpdir(), 'managed-web-unit-'))
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ],
    { encoding: 'utf8' }
  )
  assert.equal(r.status, 0, 'openssl must create the unit-test certificate')
  tls = {
    cert: readFileSync(join(certDir, 'cert.pem')),
    key: readFileSync(join(certDir, 'key.pem'))
  }
})
after(() => rmSync(certDir, { recursive: true, force: true }))
const output = { orientation: 'horizontal', width: 1280, height: 720, fps: 30, videoKbps: 4000 }
async function fixture(t, options = {}) {
  const web = await startFakeCloudWebManaged({
    maxShows: 16,
    waitScale: 0.01,
    tls,
    ingest: [
      {
        orientation: 'horizontal',
        serverUrl: 'rtmps://localhost/live',
        streamKey: randomBytes(16).toString('hex')
      }
    ],
    ...options
  })
  t.after(() => web.close())
  const call = async (name, body, id, headers = {}) => {
    const route = w.routes[name] ?? { method: 'POST' }
    const res = await fetch(`${web.httpOrigin}${managedPath(name, id)}`, {
      method: route.method,
      headers: {
        authorization: `Bearer ${web.sessionToken}`,
        'content-type': 'application/json',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  const create = async (kind = 'solo', extra = {}) => {
    const res = await call('create', {
      kind,
      outputs: [output],
      client: { app: 'videorc', version: '0.26.0' },
      ...extra
    })
    assert.equal(res.status, 201)
    return res.body.show.id
  }
  return { web, call, create }
}
const dest = (id = 'one') => ({
  id,
  platform: 'custom',
  label: 'Local test',
  orientation: 'horizontal',
  url: `rtmps://localhost/live/${randomBytes(16).toString('hex')}`
})

test('version gate is numeric, suffix tolerant and fail closed', () => {
  for (const version of ['0.26.0', '0.26.0-dev', '1.0.0', '0.100.0'])
    assert.ok(managedVersionAllowed(version))
  for (const version of [undefined, '', '0.9.0', '0.25.99', 'v0.26.0'])
    assert.equal(managedVersionAllowed(version), false)
})
test('the build under test is accepted by its exact version only', async () => {
  const web = await startFakeCloudWebManaged({ buildVersion: '0.25.2' })
  try {
    const capabilities = async (version) =>
      (
        await (
          await fetch(`${web.httpOrigin}/api/ai/capabilities`, {
            headers: {
              authorization: `Bearer ${web.sessionToken}`,
              'user-agent': `Videorc-Desktop/${version}`
            }
          })
        ).json()
      ).cloud.enabled
    assert.equal(await capabilities('0.25.2'), true)
    assert.equal(await capabilities('0.25.1'), false)
    assert.equal(await capabilities('0.26.0'), true)
  } finally {
    await web.close()
  }
})
test('URL masker handles nested values, keys, multiple schemes and retains ordinary strings', () => {
  assert.deepEqual(
    maskManagedUrls({
      list: [
        'before https://host/p?q=secret after',
        { 'wss://host/secret': 'rtmps://host/live/key' }
      ],
      ok: 1
    }),
    {
      list: ['before (address withheld) after', { '(address withheld)': '(address withheld)' }],
      ok: 1
    }
  )
})
test('capabilities and allowance refuse old User-Agent; create refuses old solo/talk/test clients', async (t) => {
  const { call } = await fixture(t)
  for (const path of ['/api/ai/capabilities', '/api/cloud/allowance']) {
    const { web } = await fixture(t)
    for (const version of ['0.9.0', '0.26.0']) {
      const res = await fetch(`${web.httpOrigin}${path}`, {
        headers: {
          authorization: `Bearer ${web.sessionToken}`,
          'user-agent': `Videorc-Desktop/${version}`
        }
      })
      const body = await res.json()
      assert.equal((body.cloud ?? body).enabled, version === '0.26.0')
    }
  }
  for (const kind of ['solo', 'talk', 'test'])
    assert.equal(
      (await call('create', { kind, outputs: [output], client: { version: '0.9.0' } })).body.error
        .code,
      w.errors.create[0].code
    )
})
test('create/current carry web control, same ingress; tests never current; quality excludes talk', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create()
  const current = await call('current')
  assert.deepEqual(current.body.control, {
    kind: w.control.kinds[0],
    url: w.control.webUrl,
    token: w.control.webToken
  })
  assert.equal(current.body.show.id, id)
  assert.equal(current.body.ingest[0].serverUrl, 'rtmps://localhost/live')
  assert.equal(current.body.show.nodeId, w.control.managedNodeId)
  assert.equal(
    (
      await call('create', {
        kind: 'solo',
        outputs: [{ ...output, fps: 60 }],
        client: { version: '0.26.0' }
      })
    ).status,
    422
  )
  await call('end', {}, id)
  await create('test')
  assert.equal((await call('current')).body.show, null)
  const talkId = await create('talk', { outputs: [{ ...output, fps: 60 }] })
  assert.deepEqual(web.shows.get(talkId).ingest, [])
})
test('destinations commit destinationsSet at the ack rev; refusals and replace never count a restart', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create()
  const result = await call(
    'destinations',
    { destinations: [dest(), { ...dest('bad'), url: 'https://localhost/live/not-an-ingress' }] },
    id
  )
  assert.equal(result.status, 200)
  assert.equal(result.body.refused[0].code, w.destinationRefusals.codes[1])
  const snap = web.snapshot(id)
  assert.equal(snap.rev, result.body.rev)
  assert.equal(snap.state.destinationsSet, true)
  assert.equal(snap.state.legs[1].state, w.legs.states[3])
  await call('destinations', { destinations: [dest()], replace: true }, id)
  assert.equal(web.snapshot(id).state.restarts, 0)
  assert.equal(
    (await call('destinations', { destinations: [{ ...dest(), url: 'bad' }] }, id)).status,
    422
  )
  assert.equal((await call('destinations', { destinations: [] }, id)).status, 400)
})
test('destination guard follows amended path/query/key and changed-ref rules', () => {
  const c = w.destinationRefusals.codes,
    key = randomBytes(16).toString('hex')
  const cases = [
    ['bad', c[0]],
    ['https://host/live/' + key, c[1]],
    ['rtmp://a:b@host/live/' + key, c[2]],
    ['rtmp://host', c[3]],
    ['rtmp://host/live/', c[4]],
    ['rtmp://host/live/short', c[5]],
    ['rtmp://host/a/b/' + key, c[0]],
    ['rtmp://host/live/' + key + '?x=bad/key', c[0]],
    ['RTMP://host/live/' + key, c[1]],
    ['rtmp://host/live/' + key + '%xx', c[0]]
  ]
  for (const [url, code] of cases) assert.equal(destinationProblem(url), code, url)
  assert.equal(destinationProblem(`rtmps://host/live/${key}`), null)
  assert.equal(destinationProblem(`rtmps://host/live/${key}`, 'different', false), c[6])
  assert.equal(destinationProblem(`rtmps://host/live/${key}`, 'different', true), null)
})
test('long poll: no since, unequal, equal timeout, material wake and ended immediate', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create()
  const poll = async (since) => {
    const at = Date.now(),
      r = await fetch(
        `${web.httpOrigin}${managedPath('state', id)}${since === undefined ? '' : `?since=${since}`}`,
        { headers: { authorization: `Bearer ${web.sessionToken}` } }
      )
    return { elapsed: Date.now() - at, status: r.status, body: await r.json() }
  }
  assert.equal((await poll()).body.rev, 1)
  for (const since of [0, 2]) assert.equal((await poll(since)).body.rev, 1)
  const timed = await poll(1)
  assert.equal(timed.status, 200)
  assert.equal(timed.body.rev, 1)
  assert.ok(timed.elapsed >= 15)
  assert.equal((await poll('1.1')).status, 400)
  const pending = poll(1)
  web.hooks.feed(id, true)
  assert.equal((await pending).body.state.phase, w.phases[1])
  const rev = web.snapshot(id).rev
  web.hooks.end(id)
  assert.equal((await poll(rev)).body.state.phase, w.phases.at(-1))
  assert.deepEqual((await call('state', undefined, id)).body.state.legs, [])
})
test('hold-image validates bytes, limit and side; feed observations drive hold/return', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create()
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeoAAAAASUVORK5CYII=',
    'base64'
  )
  assert.equal(
    (await call('holdImage', { pngBase64: png.toString('base64') }, id)).body.version.length,
    12
  )
  assert.ok(web.snapshot(id).state.holdImageSet)
  assert.equal((await call('holdImage', { pngBase64: '' }, id)).status, 400)
  assert.equal(
    (
      await call(
        'holdImage',
        { pngBase64: Buffer.alloc(w.limits.holdImageBytes + 1).toString('base64') },
        id
      )
    ).status,
    413
  )
  const wide = Buffer.from(png)
  wide.writeUInt32BE(1921, 16)
  assert.equal((await call('holdImage', { pngBase64: wide.toString('base64') }, id)).status, 400)
  web.hooks.feed(id, true)
  web.hooks.feed(id, false)
  assert.equal(web.snapshot(id).state.hold.reason, w.holdReasons[0])
  web.hooks.feed(id, true)
  assert.equal(web.snapshot(id).state.hold, undefined)
})
test('stage/legs/recording talk routes mutate state and preserve room; solo errors', async (t) => {
  const { web, call, create } = await fixture(t)
  const solo = await create(),
    id = await create('talk')
  for (const [route, code] of [
    ['stage', w.errors.stage[0]],
    ['legsEnd', w.errors.legsEnd[0]],
    ['recording', w.errors.recording[0]]
  ])
    assert.equal((await call(route, {}, solo)).body.error.code, code.code)
  assert.equal((await call('holdImage', {}, id)).status, 409)
  assert.equal(
    (await call('stage', { layout: 'solo', onStage: ['unknown'] }, id)).body.error.code,
    w.errors.stage[1].code
  )
  assert.equal((await call('stage', { onStage: [] }, id)).status, 400)
  const stage = { layout: 'solo', onStage: [`host:${id}`] }
  const set = await call('stage', stage, id)
  assert.equal(set.status, 200)
  assert.ok(web.snapshot(id).state.room.stageSet)
  await call('destinations', { destinations: [dest()] }, id)
  await call('recording', { on: true }, id)
  assert.equal((await call('legsEnd', { destinations: [dest()] }, id)).status, 200)
  assert.ok(web.snapshot(id).state.recording.active)
  assert.deepEqual(web.snapshot(id).state.legs, [])
  assert.ok(web.snapshot(id).state.room.connected)
  assert.equal(web.snapshot(id).state.restarts, 0)
  // An egress that died, then End livestream: nothing is left to lose.
  web.hooks.egressDied(id)
  assert.equal((await call('legsEnd', {}, id)).status, 200)
  assert.equal(web.shows.get(id).egressLostAt, undefined)
  assert.equal((await call('legsEnd', { destinations: 'bad' }, id)).status, 400)
  await call('recording', { on: false }, id)
  assert.equal((await call('recordings')).body.recordings.length, 1)
  assert.equal((await call('recording', {}, id)).status, 400)
})
test('a stopped take lists one row that starts with the take, now or after the asked delay', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create('talk')
  await call('recording', { on: true }, id)
  const since = web.snapshot(id).state.recording.since
  await call('recording', { on: false }, id)
  const rows = (await call('recordings')).body.recordings
  assert.equal(rows.length, 1)
  assert.equal(rows[0].startedAt, since)
  // 60 s at this fixture's 0.01 wait scale: 600 ms, long enough to read the
  // list before the row on a loaded machine, then polled for (no fixed sleep).
  web.hooks.delayNextRecordingRow(60000)
  await call('recording', { on: true }, id)
  await call('recording', { on: false }, id)
  assert.equal((await call('recordings')).body.recordings.length, 1)
  const deadline = Date.now() + 5000
  while ((await call('recordings')).body.recordings.length < 2 && Date.now() < deadline)
    await sleep(50)
  assert.equal((await call('recordings')).body.recordings.length, 2)
  assert.throws(() => web.hooks.delayNextRecordingRow(-1))
})
test('recordings list, absolute HTTPS playlist, presigned HTTPS segments, trusted TLS and untrusted refusal', async (t) => {
  const { web, call } = await fixture(t, { segmentBytes: Buffer.from('segment fixture') })
  const row = web.hooks.addRecording(),
    node = web.hooks.addRecording({ format: w.recordings.formats.node })
  assert.equal(row.format, w.recordings.formats.managed)
  assert.equal(row.downloadUrl, '')
  assert.ok(row.playlistUrl.startsWith('https://'))
  const get = (url, ca) =>
    new Promise((resolve, reject) => {
      httpsRequest(url, { ca, headers: { authorization: `Bearer ${web.sessionToken}` } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
            type: res.headers['content-type']
          })
        )
      })
        .on('error', reject)
        .end()
    })
  await assert.rejects(get(row.playlistUrl), /self-signed|certificate/i)
  const playlist = await get(row.playlistUrl, tls.cert)
  assert.equal(playlist.type, w.recordings.playlistContentType)
  const segment = playlist.body.split('\n').find((l) => l.startsWith('https://'))
  assert.ok(segment.includes('?signature='))
  assert.equal((await get(segment, tls.cert)).body, 'segment fixture')
  assert.equal((await call('recordingPlaylist', undefined, node.id)).status, 409)
  assert.equal((await call('recordingPlaylist', undefined, 'missing')).status, 404)
  assert.equal(JSON.stringify(web.calls).includes('signature='), false)
  assert.equal((await call('recordings')).body.recordings.length, 2)
})
test('all fixture route errors can be injected, once or N times; 401/mismatch/end/lost', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create()
  for (const route of [
    'create',
    'destinations',
    'legsEnd',
    'holdImage',
    'stage',
    'recording',
    'recordings'
  ]) {
    for (const error of [...w.errors.common, ...(w.errors[route] ?? [])]) {
      web.hooks.failNext(route, 1, error.status, error.code)
      const r = await call(route, w.routes[route].method === 'GET' ? undefined : {}, id)
      assert.equal(r.status, error.status)
      assert.equal(r.body.error.code, error.code)
    }
  }
  web.hooks.failNext('state', 2, 401)
  assert.equal((await call('state', undefined, id)).status, 401)
  assert.equal((await call('state', undefined, id)).status, 401)
  assert.equal((await call('state', undefined, id)).status, 200)
  const mismatch = w.errors.common.find((e) => e.status === 409 && e.code.endsWith('mismatch'))
  web.hooks.failNext('state', 1, mismatch.status, mismatch.code)
  assert.equal((await call('state', undefined, id)).body.error.code, mismatch.code)
  assert.equal(
    (await call('lost', { feedFailedSeconds: 20, controlLost: true }, id)).body.show.id,
    id
  )
  for (let n = 0; n < 2; n++) assert.equal((await call('end', {}, id)).status, 200)
  assert.equal((await call('stage', {}, id)).status, 409)
  assert.equal((await call('state', undefined, 'unknown')).status, 404)
  assert.equal(
    (await call('current', undefined, undefined, { authorization: 'Bearer wrong' })).status,
    401
  )
})
test('hooks: delay, barrier/release, queued stale answer, dead egress, resend, failed leg, stage, joins, shown, unknown kind', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create('talk')
  const d = dest()
  await call('destinations', { destinations: [d] }, id)
  web.hooks.egressDied(id)
  web.hooks.resend(id, d.id)
  web.hooks.failLeg(id, d.id)
  web.hooks.stageLost(id)
  web.hooks.pageJoin(id)
  web.hooks.shown(id, { layout: 'solo', onStage: [] })
  const state = web.snapshot(id).state
  assert.equal(state.destinationsSet, false)
  assert.equal(state.restarts, 1)
  assert.ok(state.legs[0].resend)
  assert.equal(state.legs[0].state, w.legs.states[3])
  assert.equal(state.room.stageSet, false)
  assert.equal(state.room.pageJoins, 1)
  assert.deepEqual(state.room.shown.onStage, [])
  web.hooks.answerNext('state', { rev: 0, state: {} })
  assert.equal((await call('state', undefined, id)).body.rev, 0)
  web.hooks.delay('current', 20)
  const at = Date.now()
  await call('current')
  assert.ok(Date.now() - at >= 15)
  web.hooks.delay('current', 0)
  const barrier = web.hooks.pause('current'),
    pending = call('current')
  while (!barrier.hits) await sleep(1)
  barrier.release()
  assert.equal((await pending).status, 200)
  web.hooks.controlKind('future-smoke-kind')
  const future = await create()
  assert.equal(web.shows.get(future).controlKind, 'future-smoke-kind')
  assert.ok(web.calls.every((c) => c.method && c.path && c.body))
  assert.equal(JSON.stringify(web.calls).includes(d.url), false)
})

test('smoke helpers import without launching apps or media processes; job names remain bound together', async () => {
  const { MANAGED_DOWNLOAD, OUTPUT } = await import('./cloud-managed-smoke.mjs')
  assert.deepEqual(Object.keys(MANAGED_DOWNLOAD).sort(), ['cancel', 'event', 'start'])
  assert.equal(MANAGED_DOWNLOAD.start, MANAGED_DOWNLOAD.event)
  assert.equal(OUTPUT.fps, w.limits.outputFps)
  const { checkOverlay } = await import('./cloud-managed-room.mjs')
  checkOverlay(
    {
      topic: w.overlay.topics.set,
      sender: 'host:test',
      attributes: {
        v: w.overlay.version,
        slot: 'card',
        o: 'h',
        x: '0.000000',
        y: '0.000000',
        w: '1.000000',
        h: '1.000000',
        ttl: '2'
      },
      mimeType: w.overlay.mimeTypes[0],
      length: 100
    },
    { slot: 'card', ttl: 2, sender: 'host:test' }
  )
})
test('refusal hook, synthetic sign-in, legacy control and playlist/raw answer hooks', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create(),
    d = dest()
  web.hooks.refuseDestination(d.id, w.destinationRefusals.codes[0])
  assert.equal((await call('destinations', { destinations: [d] }, id)).status, 422)
  web.hooks.refuseDestination(d.id, null)
  assert.equal((await call('destinations', { destinations: [d] }, id)).status, 200)
  const res = await fetch(`${web.httpOrigin}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${web.sessionToken}` }
  })
  assert.equal((await res.json()).user.email, 'smoke@example.invalid')
  const control = { url: 'ws://localhost:1', token: randomBytes(12).toString('hex') }
  web.hooks.legacyControl(id, control)
  assert.deepEqual((await call('current')).body.control, control)
  const body = '#EXTM3U\n#EXT-X-ENDLIST\n'
  web.hooks.answerNext('recordingPlaylist', body, 200, w.recordings.playlistContentType)
  const raw = await fetch(`${web.httpOrigin}${managedPath('recordingPlaylist', 'test')}`, {
    headers: { authorization: `Bearer ${web.sessionToken}` }
  })
  assert.equal(raw.headers.get('content-type'), w.recordings.playlistContentType)
  assert.equal(await raw.text(), body)
})

test('lost checks media: room kept, no room ends, active egress kept, two silent attempts end; HTTP failure is not silence', async (t) => {
  for (const mode of ['room', 'gone', 'egress', 'silent', 'http']) {
    let probes = 0
    const { web, call, create } = await fixture(t, {
      probeMedia: async () => {
        probes++
        if (mode === 'silent') throw new Error('network')
        if (mode === 'http') throw Object.assign(new Error('HTTP refused'), { status: 503 })
        return { roomExists: mode === 'room', activeEgress: mode === 'egress' }
      }
    })
    const id = await create()
    const r = await call('lost', { feedFailedSeconds: 20, controlLost: true }, id)
    assert.equal(Boolean(r.body.show.endedAt), ['gone', 'silent'].includes(mode))
    if (r.body.show.endedAt) assert.equal(r.body.show.endReason, w.endReasons[5])
    assert.equal(probes, mode === 'silent' ? 2 : 1)
    assert.equal((await call('lost', { feedFailedSeconds: -1 }, id)).status, 400)
    assert.equal(web.calls.filter((c) => c.route === 'lost').length, 2)
  }
})
test('long poll wakes after a material change while already waiting; calm, trouble and guest waits differ', async (t) => {
  const guest = `g_${randomBytes(11).toString('hex')}`
  const { web, call, create } = await fixture(t)
  const id = await create('talk')
  const poll = (since) =>
    fetch(`${web.httpOrigin}${managedPath('state', id)}?since=${since}`, {
      headers: { authorization: `Bearer ${web.sessionToken}` }
    }).then((r) => r.json())
  web.hooks.patch(id, (s) => {
    s.phase = w.phases[1]
  })
  const calm = Date.now()
  const rev = web.snapshot(id).rev
  const pending = poll(rev)
  while (!web.calls.some((c) => c.route === 'state' && c.status === null)) await sleep(1)
  web.hooks.pageJoin(id)
  assert.ok((await pending).rev > rev)
  assert.ok(Date.now() - calm < 250)
  const start = Date.now()
  await poll(web.snapshot(id).rev)
  assert.ok(Date.now() - start >= 230, 'calm waits scaled 25 s')
  web.hooks.patch(id, (s) => {
    s.room.participants = [{ identity: guest }, { identity: `host:${id}` }]
  })
  const guests = Date.now()
  await poll(web.snapshot(id).rev)
  assert.ok(Date.now() - guests >= 40, 'guest wait is scaled 5 s')
  web.hooks.patch(id, (s) => {
    s.phase = w.phases[0]
  })
  const trouble = Date.now()
  await poll(web.snapshot(id).rev)
  assert.ok(Date.now() - trouble >= 15, 'trouble wait is scaled 2 s')
  assert.equal((await call('end', {}, id)).status, 200)
  const endedRev = web.snapshot(id).rev
  assert.equal((await poll(endedRev)).rev, endedRev)
})

test('program receiver gate distinguishes card/return evidence from a missing or frozen feed', async () => {
  const { managedProgramFrames } = await import('./cloud-managed-program.mjs')
  const size = 160 * 90 * 3,
    frames = []
  for (let i = 0; i < 120; i++) {
    const frame = Buffer.alloc(size, i % 2 ? 100 : 200)
    if (i >= 20 && i < 70) {
      frame.fill(13)
      for (let p = 0; p < 100; p++) frame.fill(240, p * 3, p * 3 + 3)
    }
    frames.push(frame)
  }
  const evidence = managedProgramFrames(Buffer.concat(frames), 0, { holdMs: 1000, liveMs: 7000 })
  assert.ok(evidence.cardFrames > 0)
  assert.ok(evidence.motionAfterReturn)
  assert.ok(evidence.freezes.some((f) => f.duration >= 4))
  const missing = managedProgramFrames(Buffer.alloc(size * 120), 0, { holdMs: 1000, liveMs: 7000 })
  assert.equal(missing.cardFrames, 0)
  assert.equal(missing.motionAfterReturn, false)
})

test('option wrapper preserves the original node fake and its old-client capabilities', async (t) => {
  const { newNodeSecret, newShowSigningKey } = await import('./fake-cloud-web.mjs')
  const sessionToken = randomBytes(32).toString('base64url')
  const web = await startFakeCloudWebManaged({
    managed: false,
    sessionToken,
    node: { id: 'local-smoke', secret: newNodeSecret(), agentUrl: 'http://127.0.0.1:1' },
    signingKey: newShowSigningKey().privateKey
  })
  t.after(() => web.close())
  const headers = { authorization: `Bearer ${sessionToken}`, 'user-agent': 'Videorc-Desktop/0.9.0' }
  const current = await fetch(`${web.httpOrigin}${managedPath('current')}`, { headers })
  assert.deepEqual(await current.json(), { show: null })
  const capabilities = await fetch(`${web.httpOrigin}/api/ai/capabilities`, { headers })
  assert.equal(
    (await capabilities.json()).cloud.enabled,
    true,
    'managed version gate must not alter node mode'
  )
})
test('arbitrary HTTP failure status retains a fixture code and expires after N requests', async (t) => {
  const { web, call, create } = await fixture(t)
  const id = await create()
  web.hooks.failNext('state', 2, 500)
  for (let i = 0; i < 2; i++) {
    const r = await call('state', undefined, id)
    assert.equal(r.status, 500)
    assert.equal(r.body.error.code, w.errors.common[5].code)
  }
  assert.equal((await call('state', undefined, id)).status, 200)
})

test('show limits and timers: capacity, no-feed, hold-limit, max-show, test expiry and no-desktop egress loss', async (t) => {
  for (const reason of [
    w.endReasons[1],
    w.endReasons[2],
    w.endReasons[3],
    w.endReasons[4],
    w.endReasons.at(-1)
  ]) {
    const { web, call, create } = await fixture(t)
    const id = await create(reason === w.endReasons.at(-1) ? 'test' : 'solo'),
      s = web.shows.get(id)
    if (reason === w.endReasons[1]) s.show.createdAt = new Date(Date.now() - 61000).toISOString()
    if (reason === w.endReasons[2]) {
      web.hooks.feed(id, true)
      web.hooks.feed(id, false)
      s.state.hold.since = new Date(Date.now() - s.show.holdMaxSeconds * 1000 - 1000).toISOString()
    }
    if (reason === w.endReasons[3] || reason === w.endReasons.at(-1))
      s.show.expiresAt = new Date(0).toISOString()
    if (reason === w.endReasons[4]) {
      s.firstFrameAt = Date.now()
      s.egressLostAt = Date.now() - 61000
    }
    const r = await call('state', undefined, id)
    assert.equal(r.body.state.phase, w.phases.at(-1))
    assert.equal(r.body.state.endReason, reason)
  }
  const { call, create } = await fixture(t, { maxShows: 1 })
  await create()
  const r = await call('create', { kind: 'solo', outputs: [output], client: { version: '0.26.0' } })
  assert.equal(r.status, w.errors.create.find((e) => e.code.endsWith('full')).status)
})

test('renderer smoke snippets parse without evaluating or launching the app', async () => {
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
  const ts = require('typescript')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  for (const name of [
    'smoke-cloud-solo-managed-app.mjs',
    'smoke-cloud-talk-show-managed-app.mjs',
    'lib/cloud-managed-smoke.mjs',
    'lib/cloud-managed-room.mjs'
  ]) {
    const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    let snippets = 0
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'eval' &&
        node.arguments[0] &&
        (ts.isStringLiteral(node.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(node.arguments[0]) ||
          ts.isTemplateExpression(node.arguments[0]))
      ) {
        const expression = node.arguments[0]
        const code = ts.isTemplateExpression(expression)
          ? expression.head.text +
            expression.templateSpans.map((span) => 'null' + span.literal.text).join('')
          : expression.text
        assert.doesNotThrow(() => new AsyncFunction('params', code), `${name}: renderer snippet`)
        snippets++
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    if (name.includes('talk')) assert.ok(snippets > 4)
  }
})

// Plan 243 C6: route-level fakes; no app, media process or cloud service.
const device = (id, kind = 'computer') => ({
  id: id.repeat(22),
  name: kind === 'phone' ? 'Smoke phone' : 'Smoke computer',
  kind
})
const currentClient = { app: 'desktop', version: '0.29.0' }
test('handoff version gate refuses malformed and pre-0.29 desktop versions', () => {
  for (const version of ['0.29.0', '0.29.0-beta.1', '1.0.0'])
    assert.ok(managedHandoffAllowed(version))
  for (const version of [undefined, 'garbage', '0.28.99', '0.9.0'])
    assert.equal(managedHandoffAllowed(version), false)
})
test('device create/current/state, broadcastId, page viewer and scrub match plan 243', async (t) => {
  const { web, call, create } = await fixture(t)
  const a = device('A')
  const id = await create('solo', { device: a, client: currentClient })
  const current = (await call('current')).body
  assert.equal(current.onAir.deviceId, a.id)
  assert.equal(current.onAir.source, 'feed')
  const old = await call('current', undefined, undefined, {
    'user-agent': 'Videorc-Desktop/0.28.2'
  })
  assert.equal(old.body.ingest, undefined)
  assert.ok(
    (await call('current', undefined, undefined, { 'user-agent': 'Videorc-Desktop/0.29.0' })).body
      .ingest.length
  )
  const s = web.shows.get(id)
  assert.equal(s.lastDesktopSeen, undefined)
  const poll = async (viewer) =>
    (
      await fetch(`${web.httpOrigin}${managedPath('state', id)}${viewer ? '?viewer=page' : ''}`, {
        headers: { authorization: `Bearer ${web.sessionToken}` }
      })
    ).json()
  assert.equal((await poll(true)).state.onAir.deviceId, a.id)
  assert.equal(s.lastDesktopSeen, undefined)
  await poll(false)
  const seen = s.lastDesktopSeen
  await poll(true)
  assert.equal(s.lastDesktopSeen, seen)
  const d = { ...dest(), platform: 'youtube', broadcastId: 'live_123-abc' }
  assert.equal((await call('destinations', { destinations: [d] }, id)).status, 200)
  assert.equal(web.snapshot(id).state.legs[0].broadcastId, d.broadcastId)
  assert.equal(
    (await call('destinations', { destinations: [{ ...d, broadcastId: 'invalid id' }] }, id))
      .status,
    400
  )
  assert.equal(JSON.stringify(web.calls).includes(a.id), false)
  assert.equal(JSON.stringify(web.calls).includes(a.name), false)
  await call('end', {}, id)
  assert.equal(s.state.onAir, undefined)
  assert.equal(s.feedDeviceId, undefined)
  assert.equal(s.creatingDeviceId, undefined)
  assert.deepEqual(s.state.legs, [])
})
test('hand off only marks the current device waiting; errors never end a show', async (t) => {
  const { web, call, create } = await fixture(t)
  const a = device('A'),
    b = device('B')
  const id = await create('solo', { device: a, client: currentClient })
  const before = web.snapshot(id).rev
  assert.equal(
    (await call('handOff', { device: { id: b.id } }, id)).body.error.code,
    'cloud-not-on-air'
  )
  const handed = await call('handOff', { device: { id: a.id } }, id)
  assert.equal(handed.status, 200)
  assert.ok(handed.body.rev > before)
  assert.equal(handed.body.onAir.waiting, true)
  assert.equal(
    JSON.stringify(web.calls).includes(a.id),
    false,
    'minimal hand-off body must mask its device id'
  )
  assert.equal(web.shows.get(id).show.endedAt, null)
  assert.equal(web.calls.filter((c) => c.route === 'end').length, 0)
  web.hooks.failNext('handOff', 1, 503)
  assert.equal((await call('handOff', { device: { id: a.id } }, id)).status, 503)
  assert.equal(web.shows.get(id).show.endedAt, null)
})
test('feed prepare rotates a different computer, retains the same computer and retires the old ingress', async (t) => {
  const rotations = []
  const { web, call, create } = await fixture(t, {
    rotateIngest: async (change) => rotations.push(change)
  })
  const a = device('A'),
    b = device('B')
  const id = await create('solo', { device: a, client: currentClient })
  const initial = structuredClone(web.shows.get(id).ingest)
  const claim = (d, step) => call('onAir', { device: d, source: 'feed', step }, id)
  assert.deepEqual((await claim(a, 'prepare')).body.ingest, initial)
  assert.equal(rotations.length, 0)
  const next = await claim(b, 'prepare')
  assert.equal(next.body.onAir.deviceId, b.id)
  assert.equal(next.body.onAir.waiting, false)
  assert.equal(rotations.length, 1)
  assert.notEqual(next.body.ingest[0].streamKey, initial[0].streamKey)
  assert.deepEqual(rotations[0].previous, initial[0])
  assert.equal(web.snapshot(id).state.feeds[0].connected, false)
  assert.equal((await claim(b, 'go')).status, 200)
  assert.deepEqual((await claim(b, 'prepare')).body.ingest, next.body.ingest)
  assert.equal(rotations.length, 1)
})
test('camera prepare stays off air, go needs camera publication; feed go needs post-claim publishing for every output', async (t) => {
  const { web, call, create } = await fixture(t)
  const a = device('A'),
    b = device('B'),
    phone = device('P', 'phone')
  const id = await create('solo', {
    device: a,
    client: currentClient,
    outputs: [output, { ...output, orientation: 'vertical' }]
  })
  const claim = (d, source, step) => call('onAir', { device: d, source, step }, id)
  const prepared = await claim(phone, 'camera', 'prepare')
  assert.equal(prepared.body.room.identity, `d_${phone.id}`)
  assert.equal(prepared.body.onAir.deviceId, a.id)
  assert.equal((await claim(phone, 'camera', 'go')).body.error.code, 'cloud-source-not-ready')
  web.hooks.camera(id, phone.id, true)
  assert.equal((await claim(phone, 'camera', 'go')).body.onAir.deviceId, phone.id)
  web.hooks.feed(id, true)
  const previousClaim = web.shows.get(id).feedClaim
  const feed = await claim(b, 'feed', 'prepare')
  assert.equal(feed.body.onAir.deviceId, phone.id)
  assert.equal((await claim(b, 'feed', 'go')).status, 409)
  web.hooks.feed(id, true, { claim: previousClaim })
  assert.equal((await claim(b, 'feed', 'go')).status, 409)
  const claimId = web.shows.get(id).feedClaim
  web.hooks.feed(id, true, { claim: claimId, orientation: 'horizontal' })
  assert.equal((await claim(b, 'feed', 'go')).status, 409)
  web.hooks.feed(id, true, { claim: claimId, orientation: 'vertical' })
  assert.equal((await claim(b, 'feed', 'go')).body.onAir.deviceId, b.id)
})
test('D8 refuses another device on old desktop shows, exempts their creator, and refuses test/node/source mismatches', async (t) => {
  const { web, call, create } = await fixture(t)
  const a = device('A'),
    b = device('B')
  const id = await create('solo', { device: a, client: { app: 'desktop', version: '0.28.2' } })
  const claim = (id, d, source = 'feed', step = 'prepare') =>
    call('onAir', { device: d, source, step }, id)
  assert.equal((await claim(id, b)).body.error.code, 'cloud-handoff-update')
  assert.equal((await claim(id, a)).status, 200)
  assert.equal((await claim(id, b, 'host')).body.error.code, 'cloud-handoff-unsupported')
  const testId = await create('test', { client: currentClient, device: a })
  assert.equal((await claim(testId, b)).body.error.code, 'cloud-handoff-unsupported')
  const talkId = await create('talk', { client: currentClient, device: a })
  assert.equal((await claim(talkId, b, 'camera')).body.error.code, 'cloud-handoff-unsupported')
  web.hooks.legacyControl(talkId, { url: 'ws://127.0.0.1:1', token: 'local-fixture' })
  assert.equal((await claim(talkId, b, 'host')).body.error.code, 'cloud-handoff-unsupported')
  await call('end', {}, id)
  assert.equal((await claim(id, b)).body.error.code, 'cloud-show-ended')
})
test('host go returns the host seat token without removing the current host or stage', async (t) => {
  const { web, call, create } = await fixture(t)
  const a = device('A'),
    phone = device('P', 'phone')
  const id = await create('talk', { client: currentClient, device: a })
  web.hooks.patch(id, (s) => {
    s.room.participants = [{ identity: `host:${id}`, role: 'host' }]
  })
  const stage = structuredClone(web.snapshot(id).state.room.stage)
  const oldRev = web.snapshot(id).rev
  const prepare = await call('onAir', { device: phone, source: 'host', step: 'prepare' }, id)
  assert.equal(prepare.body.rev, oldRev)
  assert.equal(prepare.body.onAir.deviceId, a.id)
  const go = await call('onAir', { device: phone, source: 'host', step: 'go' }, id)
  assert.equal(go.body.room.identity, `host:${id}`)
  assert.equal(go.body.onAir.deviceId, phone.id)
  assert.deepEqual(web.snapshot(id).state.room.stage, stage)
  assert.equal(web.snapshot(id).state.room.participants[0].identity, `host:${id}`)
  assert.equal(web.calls.filter((c) => c.route === 'end').length, 0)
})

test('camera tokens carry only camera/microphone publishing grants with a ten-minute TTL', async (t) => {
  const { call, create } = await fixture(t, {
    livekit: {
      url: 'ws://127.0.0.1:1',
      apiKey: randomBytes(12).toString('hex'),
      apiSecret: randomBytes(32).toString('hex')
    }
  })
  const id = await create('solo', { device: device('A'), client: currentClient })
  const result = await call(
    'onAir',
    { device: device('P', 'phone'), source: 'camera', step: 'prepare' },
    id
  )
  const claims = JSON.parse(Buffer.from(result.body.room.token.split('.')[1], 'base64url'))
  // The maintained token helper uses nbf with ten seconds of clock skew,
  // rather than an iat claim; expiry itself stays ten minutes from minting.
  assert.equal(claims.exp - claims.nbf, 610)
  assert.ok(Math.abs(claims.exp - Math.floor(Date.now() / 1000) - 600) <= 1)
  assert.deepEqual(claims.video, {
    room: id,
    roomJoin: true,
    canPublish: true,
    canPublishSources: ['camera', 'microphone'],
    canSubscribe: false,
    canPublishData: false
  })
})

test('configured feature build models its shipping version while other old desktop shows keep D8', async (t) => {
  const { call, create } = await fixture(t, { buildVersion: '0.28.2' })
  const a = device('A'),
    b = device('B')
  const id = await create('solo', { device: a, client: { app: 'desktop', version: '0.28.2' } })
  assert.equal(
    (await call('onAir', { device: b, source: 'feed', step: 'prepare' }, id)).status,
    200
  )
  const old = await create('solo', { device: a, client: { app: 'desktop', version: '0.28.1' } })
  assert.equal(
    (await call('onAir', { device: b, source: 'feed', step: 'prepare' }, old)).body.error.code,
    'cloud-handoff-update'
  )
})
test('competing feed prepares serialize rotation under the show claim', async (t) => {
  let entered, release
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const held = new Promise((resolve) => {
    release = resolve
  })
  let rotations = 0
  const { web, call, create } = await fixture(t, {
    rotateIngest: async () => {
      if (++rotations === 1) {
        entered()
        await held
      }
    }
  })
  const id = await create('solo', { device: device('A'), client: currentClient })
  const b = call('onAir', { device: device('B'), source: 'feed', step: 'prepare' }, id)
  await started
  const c = call('onAir', { device: device('C'), source: 'feed', step: 'prepare' }, id)
  release()
  assert.equal((await b).status, 200)
  assert.equal((await c).status, 200)
  assert.equal(rotations, 2)
  assert.ok(web.snapshot(id).state.onAir.deviceId === device('C').id)
})

test('local sink publish authorization retires the old ingress path after rotation', async (t) => {
  const { managedPublishAllowed } = await import('./cloud-managed-smoke.mjs')
  const { web, call, create } = await fixture(t)
  const id = await create('solo', { device: device('A'), client: currentClient })
  const old = web.shows.get(id).ingest[0]
  const pathFor = (i) => new URL(i.serverUrl).pathname.slice(1) + '/' + i.streamKey
  assert.equal(managedPublishAllowed(web.shows, { action: 'publish', path: pathFor(old) }), true)
  const prepared = await call('onAir', { device: device('B'), source: 'feed', step: 'prepare' }, id)
  assert.equal(managedPublishAllowed(web.shows, { action: 'publish', path: pathFor(old) }), false)
  assert.equal(
    managedPublishAllowed(web.shows, { action: 'publish', path: pathFor(prepared.body.ingest[0]) }),
    true
  )
  await call('end', {}, id)
  assert.equal(
    managedPublishAllowed(web.shows, { action: 'publish', path: pathFor(prepared.body.ingest[0]) }),
    false
  )
})

test('idle viewers never stamp a computer able to restore destinations', async (t) => {
  const { web, create } = await fixture(t)
  const id = await create('solo', { device: device('A'), client: currentClient })
  const show = web.shows.get(id)
  const poll = (viewer) =>
    fetch(`${web.httpOrigin}${managedPath('state', id)}${viewer ? '?viewer=idle' : ''}`, {
      headers: { authorization: `Bearer ${web.sessionToken}` }
    })
  assert.equal((await poll(true)).status, 200)
  assert.equal(show.lastDesktopSeen, undefined)
  await poll(false)
  const seen = show.lastDesktopSeen
  assert.equal(typeof seen, 'number')
  await poll(true)
  assert.equal(show.lastDesktopSeen, seen)
})
