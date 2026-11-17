import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import {
  startFakeCloudWebManaged,
  managedWire as w,
  managedPath
} from './fake-cloud-web-managed.mjs'

// Plan 249 S25: the fake web keeps live intervals, reports, usage events and
// interval effects by the web's rules, so the `reporting` case judges the
// desktop against them. Local HTTP only; no provider, Discord or real page.

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
    return { status: res.status, body: type.includes('json') ? await res.json() : null }
  }
  const created = await fetchJson('POST', managedPath('create'), {
    kind: 'talk',
    outputs: [output],
    client: { app: 'videorc', version: '0.26.0' }
  })
  assert.equal(created.status, 201)
  const id = created.body.show.id
  const base = `${managedPath('create')}/${id}`
  const state = async () => (await fetchJson('GET', managedPath('state', id))).body.state
  const key = randomBytes(16).toString('hex')
  const goLive = (epoch) =>
    fetchJson(
      w.routes.destinations.method,
      managedPath('destinations', id),
      {
        destinations: [
          {
            id: 'yt',
            platform: 'youtube',
            label: 'Main',
            orientation: 'horizontal',
            url: `rtmps://localhost/live/${key}`
          }
        ]
      },
      epoch === undefined ? {} : { 'videorc-controller-epoch': String(epoch) }
    )
  const claim = (intervalId, epoch) =>
    fetchJson(
      'POST',
      `${base}/effects`,
      { intervalId, effect: 'discord-announce' },
      epoch === undefined ? {} : { 'videorc-controller-epoch': String(epoch) }
    )
  return { web, id, base, fetchJson, state, goLive, claim }
}

test('an interval opens with a live leg, ends with End livestream, and the next is another', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.goLive()).status, 200)
  const first = (await f.state()).liveInterval
  assert.ok(first?.id && first.liveSince && !first.endedAt, JSON.stringify(first))
  assert.equal((await f.state()).liveInterval.id, first.id, 'polling never opens another')
  const ended = await f.fetchJson(w.routes.legsEnd.method, managedPath('legsEnd', f.id), {})
  assert.equal(ended.status, 200)
  assert.ok((await f.state()).liveInterval.endedAt)
  await f.goLive()
  const second = await f.state()
  assert.notEqual(second.liveInterval.id, first.id)
  assert.deepEqual(
    second.pastIntervals.map((past) => past.id),
    [first.id]
  )
})

test('an interval effect is claimed once and only by the current controller', async (t) => {
  const f = await fixture(t)
  await f.goLive()
  const { id: interval } = (await f.state()).liveInterval
  assert.equal((await f.claim('nope')).status, 404)
  assert.equal((await f.claim(interval)).body.claimed, true)
  assert.equal((await f.claim(interval)).body.claimed, false)
  await f.fetchJson('POST', `${f.base}/controller`, { device: { id: A }, intent: 'claim' })
  await f.fetchJson('POST', `${f.base}/controller`, {
    device: { id: B },
    intent: 'takeover',
    epoch: 1
  })
  assert.equal((await f.claim(interval, 1)).body.error.code, 'cloud-controller-stale')
  assert.equal((await f.claim(interval)).body.error.code, 'cloud-controller-required')
  assert.equal((await f.claim(interval, 2)).body.claimed, false)
  assert.equal(f.web.hooks.reporting().effects.length, 1)
})

test('reports and usage events are kept once per id; an opted-out account gets none', async (t) => {
  const f = await fixture(t)
  const report = { version: 1, reportId: '0b6f6b1c-3a0e-8a1b-9c2d-1e2f3a4b5c6d' }
  assert.equal(
    (await f.fetchJson('POST', '/api/desktop/stream-report', report)).body.status,
    'sent'
  )
  assert.equal(
    (await f.fetchJson('POST', '/api/desktop/stream-report', report)).body.status,
    'already-sent'
  )
  const event = { eventId: '1b6f6b1c-3a0e-8a1b-9c2d-1e2f3a4b5c6d', event: 'stream_start' }
  for (let i = 0; i < 2; i += 1)
    assert.equal((await f.fetchJson('POST', '/api/desktop/stream-events', event)).status, 202)
  f.web.hooks.setReportPreference({ enabled: false, history: false })
  const other = { version: 1, reportId: '2b6f6b1c-3a0e-8a1b-9c2d-1e2f3a4b5c6d' }
  assert.equal(
    (await f.fetchJson('POST', '/api/desktop/stream-report', other)).body.status,
    'disabled'
  )
  const kept = f.web.hooks.reporting()
  assert.equal(kept.reports.length, 1)
  assert.equal(kept.events.length, 1)
  assert.equal(kept.eventPosts.length, 2)
})

test('the Discord sink answers posts and edits without a bearer and keeps them', async (t) => {
  const f = await fixture(t)
  const hook = `${f.web.httpOrigin}/api/v10/webhooks/123/token-abc`
  const posted = await (
    await fetch(`${hook}?wait=true&with_components=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'live' })
    })
  ).json()
  assert.ok(posted.id)
  const edited = await fetch(`${hook}/messages/${posted.id}?with_components=true`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'was live' })
  })
  assert.equal(edited.status, 200)
  assert.deepEqual(
    f.web.hooks.reporting().discord.map((entry) => [entry.kind, entry.payload.content]),
    [
      ['post', 'live'],
      ['edit', 'was live']
    ]
  )
})
