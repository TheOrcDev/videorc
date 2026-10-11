import assert from 'node:assert/strict'
import { get, request } from 'node:http'
import test from 'node:test'

import { startCardServer } from './card-server.mjs'

const RUN = {
  runId: '20261012-dry-a1b2',
  scenario: 'dry',
  appVersion: '0.9.142',
  startedAt: '2026-10-12T10:00:00.000Z'
}

function httpGet(url, headers = {}) {
  return new Promise((resolveGet, rejectGet) => {
    get(url, { headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () =>
        resolveGet({ status: response.statusCode, headers: response.headers, body })
      )
    }).on('error', rejectGet)
  })
}

function httpPost(url, body) {
  return new Promise((resolvePost, rejectPost) => {
    const req = request(url, { method: 'POST' }, (response) => {
      response.resume()
      response.on('end', () => resolvePost(response.statusCode))
    })
    req.on('error', rejectPost)
    req.end(body)
  })
}

// Minimal SSE reader: resolves `next()` with each `state` event's data.
function openEvents(url) {
  const queue = []
  const waiters = []
  let buffer = ''
  let req
  const ready = new Promise((resolveOpen, rejectOpen) => {
    req = get(`${url}events`, (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        buffer += chunk
        let split
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const event = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (event !== 'state' || !data) continue
          const parsed = JSON.parse(data)
          const waiter = waiters.shift()
          if (waiter) waiter(parsed)
          else queue.push(parsed)
        }
      })
      resolveOpen(response)
    })
    req.on('error', rejectOpen)
  })
  return {
    ready,
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((resolveNext) => waiters.push(resolveNext)),
    close: () => req.destroy()
  }
}

test('serves the card on 127.0.0.1 with a no-network CSP', async (t) => {
  const card = await startCardServer({ runInfo: RUN })
  t.after(() => card.close())
  assert.match(card.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  const page = await httpGet(card.url)
  assert.equal(page.status, 200)
  assert.match(page.body, /<canvas id="markers"/)
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
  assert.doesNotMatch(page.headers['content-security-policy'], /https?:/)
  for (const path of ['card.js', 'card.css', 'card-view.mjs', 'marker-codec.mjs', 'markers.json']) {
    const response = await httpGet(`${card.url}${path}`)
    assert.equal(response.status, 200, path)
  }
  assert.equal((await httpGet(`${card.url}../config.json`)).status, 404)
  assert.equal((await httpGet(`${card.url}lib/card-server.mjs`)).status, 404)
})

test('the static card references no external network assets', async (t) => {
  const card = await startCardServer({ runInfo: RUN })
  t.after(() => card.close())
  for (const path of ['', 'card.js', 'card.css', 'card-view.mjs', 'marker-codec.mjs']) {
    const { body } = await httpGet(`${card.url}${path}`)
    assert.doesNotMatch(body, /(?:src|href)=["']?(?:https?:)?\/\//, path)
    assert.doesNotMatch(body, /url\(\s*["']?(?:https?:)?\/\//, path)
    assert.doesNotMatch(body, /@import/, path)
    assert.doesNotMatch(body, /fetch\(\s*['"`]https?:/, path)
  }
})

test('refuses requests for another Host (DNS rebinding)', async (t) => {
  const card = await startCardServer({ runInfo: RUN })
  t.after(() => card.close())
  const response = await httpGet(card.url, { host: 'evil.example:80' })
  assert.equal(response.status, 403)
})

test('SSE sends the state on connect and on every push and step', async (t) => {
  const card = await startCardServer({ runInfo: RUN, now: () => 1_760_263_200_000 })
  t.after(() => card.close())
  const events = openEvents(card.url)
  t.after(() => events.close())
  await events.ready

  const first = await events.next()
  assert.equal(first.run.runId, RUN.runId)
  assert.equal(first.run.startedAt, Date.parse(RUN.startedAt))
  assert.equal(first.history.length, 0)
  assert.equal(card.clientCount(), 1)

  card.push({
    bitrateKbps: 6000,
    memoryMb: { backend: 410, renderer: 380 },
    healthEventCodes: ['stream:reconnected']
  })
  const pushed = await events.next()
  assert.equal(pushed.history.length, 1)
  assert.equal(pushed.history[0].bitrateKbps, 6000)
  assert.deepEqual(pushed.history[0].memoryMb, { backend: 410, renderer: 380 })
  assert.deepEqual(pushed.healthEvents, [{ code: 'stream:reconnected', ts: 1_760_263_200_000 }])

  card.setStep({ index: 4, total: 9, name: 'Scene applied', sceneId: 3 })
  const stepped = await events.next()
  assert.deepEqual(stepped.step, { index: 4, total: 9, name: 'Scene applied', sceneId: 3 })
})

test('push drops non-allowlisted and secret-shaped fields', async (t) => {
  const dropped = []
  const card = await startCardServer({
    runInfo: RUN,
    onDropped: (fields) => dropped.push(...fields)
  })
  t.after(() => card.close())
  const result = card.push({
    bitrateKbps: 4500,
    streamKey: 'abcd-efgh-ijkl-mnop-qrst',
    rtmpUrl: 'rtmps://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst',
    chatAuthor: 'someone',
    memoryMb: { backend: 300, '/Users/someone': 12 },
    healthEventCodes: ['ok-code', 'person@example.com', '/Users/someone/Library'],
    appVersion: 'ya29.a0AfH6SMBexampletoken'
  })
  assert.deepEqual(
    result.dropped.sort(),
    [
      'appVersion',
      'chatAuthor',
      'healthEventCodes[]',
      'healthEventCodes[]',
      'memoryMb.(unknown role)',
      'rtmpUrl',
      'streamKey'
    ].sort()
  )
  assert.deepEqual(dropped.sort(), result.dropped.sort())
  const serialized = JSON.stringify(card.state())
  assert.doesNotMatch(serialized, /abcd-efgh|rtmps|someone|example\.com|ya29/)
  assert.equal(card.state().history[0].bitrateKbps, 4500)
  assert.deepEqual(
    card.state().healthEvents.map((event) => event.code),
    ['ok-code']
  )
  assert.equal(card.state().run.appVersion, RUN.appVersion)
})

test('runInfo that fails its shape is not shown', async (t) => {
  const card = await startCardServer({
    runInfo: {
      runId: 'run with /Users/me',
      scenario: 'Dry Run!',
      appVersion: 'latest',
      startedAt: 'nope'
    }
  })
  t.after(() => card.close())
  assert.deepEqual(card.state().run, {
    runId: null,
    scenario: null,
    appVersion: null,
    startedAt: null
  })
})

test('history and health events are bounded', async (t) => {
  const card = await startCardServer({ runInfo: RUN })
  t.after(() => card.close())
  for (let index = 0; index < 130; index += 1) {
    card.push({
      ts: 1_000_000 + index * 5000,
      bitrateKbps: index,
      healthEventCodes: [`code-${index}`]
    })
  }
  assert.equal(card.state().history.length, 120)
  assert.equal(card.state().history[0].bitrateKbps, 10)
  assert.deepEqual(
    card.state().healthEvents.map((event) => event.code),
    ['code-125', 'code-126', 'code-127', 'code-128', 'code-129']
  )
})

test('records the page sync pulse, sanitized', async (t) => {
  const card = await startCardServer({ runInfo: RUN, now: () => 42 })
  t.after(() => card.close())
  assert.equal(card.lastPulse(), null)
  const status = await httpPost(
    `${card.url}pulse`,
    JSON.stringify({
      count: 3,
      audioState: 'running',
      visible: 'visible',
      focused: true,
      at: 40,
      extra: 'x'
    })
  )
  assert.equal(status, 204)
  assert.deepEqual(card.lastPulse(), {
    count: 3,
    audioState: 'running',
    visible: 'visible',
    focused: true,
    at: 40,
    receivedAt: 42
  })
  assert.equal(await httpPost(`${card.url}pulse`, 'not json'), 400)
})

test('close ends open SSE streams', async () => {
  const card = await startCardServer({ runInfo: RUN })
  const events = openEvents(card.url)
  const response = await events.ready
  await events.next()
  const ended = new Promise((resolveEnd) => response.on('close', resolveEnd))
  await card.close()
  await ended
})
