import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'

import {
  NODE_DIRECTION_WEB_TO_NODE,
  buildHostGuestsView,
  guestPublishSources,
  isGuestId,
  isGuestRequestId,
  isInviteSlug,
  mintLiveKitToken,
  newGuestId,
  newInviteSlug,
  newShowSigningKey,
  parseCreateShowBody,
  parseRecordingReport,
  parseTalkRoom,
  readLiveKitToken,
  roomGrantFor,
  signNodeRequest,
  startFakeCloudWeb,
  verifyNodeRequest
} from './fake-cloud-web.mjs'

// Plan 224 S-G1: the fake web's talk-show side, pure pieces first, then
// the routes against a fake node agent (no LiveKit server: the server API
// calls are refused and the routes answer as the web does on a 502).

describe('fake cloud web: LiveKit tokens and grants (plan 224)', () => {
  it('mints the web’s grants per role and the token reads back', () => {
    const host = roomGrantFor({ role: 'host', room: 'sh_1' })
    assert.equal(host.roomJoin, true)
    assert.equal(host.canPublishData, true)
    assert.deepEqual(host.canPublishSources, [
      'camera',
      'microphone',
      'screen_share',
      'screen_share_audio'
    ])
    const runner = roomGrantFor({ role: 'runner', room: 'sh_1' })
    assert.equal(runner.hidden, false, 'the runner is visible (plan 221 U3)')
    assert.deepEqual(runner.canPublishSources, ['camera', 'microphone'])
    const guest = roomGrantFor({ role: 'guest', room: 'sh_1' })
    assert.deepEqual(guest.canPublishSources, ['camera', 'microphone'])
    assert.equal(guest.canPublishData, false)
    assert.deepEqual(guestPublishSources(true, false), [
      'camera',
      'screen_share',
      'screen_share_audio'
    ])
    const token = mintLiveKitToken({
      apiKey: 'devkey',
      apiSecret: 'secret',
      identity: 'g_0123456789abcdefghijkl',
      name: 'Ada',
      grant: guest,
      ttlSeconds: 600,
      nowMs: Date.UTC(2026, 10, 9, 12, 0, 0)
    })
    const claims = readLiveKitToken(token, 'secret')
    assert.equal(claims.iss, 'devkey')
    assert.equal(claims.sub, 'g_0123456789abcdefghijkl')
    assert.equal(claims.name, 'Ada')
    assert.equal(claims.exp, Math.floor(Date.UTC(2026, 10, 9, 12, 10, 0) / 1000))
    assert.equal(claims.video.room, 'sh_1')
    assert.equal(readLiveKitToken(token, 'other'), null, 'a wrong secret reads nothing')
    assert.throws(() =>
      mintLiveKitToken({ apiKey: 'k', apiSecret: 's', identity: '', grant: guest, ttlSeconds: 1 })
    )
  })

  it('shapes ids, slugs, the room block, a recording report and the guests view', () => {
    assert.ok(isInviteSlug(newInviteSlug()))
    assert.ok(isGuestId(newGuestId()))
    assert.ok(!isGuestId('runner:sh_1'))
    assert.ok(isGuestRequestId('gr_0123456789abcdefghijkl'))
    assert.deepEqual(
      parseTalkRoom({
        returnWidth: 1280,
        returnHeight: 720,
        title: ' Tuesday ',
        platforms: ['youtube', 7]
      }),
      {
        returnWidth: 1280,
        returnHeight: 720,
        title: 'Tuesday',
        platforms: ['youtube']
      }
    )
    assert.ok('message' in parseTalkRoom({ returnWidth: 1281, returnHeight: 720 }))
    assert.ok('message' in parseTalkRoom(null))
    const create = parseCreateShowBody({
      kind: 'talk',
      outputs: [
        {
          orientation: 'horizontal',
          width: 1280,
          height: 720,
          fps: 30,
          videoKbps: 4000,
          audioKbps: 160
        }
      ],
      room: { returnWidth: 1280, returnHeight: 720 }
    })
    assert.equal(create.kind, 'talk')
    assert.deepEqual(create.room, {
      returnWidth: 1280,
      returnHeight: 720,
      title: '',
      platforms: []
    })
    assert.ok(
      'message' in
        parseCreateShowBody({
          kind: 'talk',
          outputs: [
            {
              orientation: 'horizontal',
              width: 1280,
              height: 720,
              fps: 30,
              videoKbps: 4000,
              audioKbps: 160
            }
          ]
        })
    )
    const report = parseRecordingReport({
      showId: 'sh_0123456789abcdefghijkl',
      orientation: 'h',
      state: 'complete',
      seconds: 61,
      bytes: 1234,
      startedAt: '2026-11-09T12:00:00.000Z',
      objectKey: 'talk/u/sh_0123456789abcdefghijkl/2026-11-09T12-00-00Z-h.mp4'
    })
    assert.equal(report.seconds, 61)
    assert.ok('message' in parseRecordingReport({ ...report, orientation: 'x' }))
    assert.ok('message' in parseRecordingReport({ ...report, objectKey: '../x' }))
    const view = buildHostGuestsView(
      [
        {
          id: 'gr_a',
          name: 'Ada',
          device: 'phone',
          state: 'waiting',
          askedAt: 't1',
          hidden: false
        },
        {
          id: 'gr_b',
          name: 'Bo',
          device: 'computer',
          state: 'let-in',
          guestId: 'g_b',
          askedAt: 't0',
          decidedAt: 't2',
          muted: true
        },
        {
          id: 'gr_c',
          name: 'Cy',
          device: 'computer',
          state: 'declined',
          askedAt: 't0',
          hidden: true
        }
      ],
      'now'
    )
    assert.deepEqual(view, {
      cursor: 'now',
      declinedCount: 1,
      guests: [
        { guestId: 'g_b', name: 'Bo', joinedAt: 't2', muted: true, screenShareAllowed: false }
      ],
      requests: [{ requestId: 'gr_a', name: 'Ada', askedAt: 't1', device: 'phone' }]
    })
  })
})

describe('fake cloud web: the talk-show routes against a fake agent', () => {
  it('opens a room, lets a guest through the door, rotates the link and takes the node’s recording', async () => {
    const secret = Buffer.alloc(32, 9)
    const { privateKey, publicKeyBase64Url } = newShowSigningKey()
    const agentCreates = []
    const agent = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const verification = verifyNodeRequest({
        direction: NODE_DIRECTION_WEB_TO_NODE,
        headers: { get: (name) => req.headers[name] ?? null },
        method: req.method,
        nowMs: Date.now(),
        path: req.url,
        rawBody,
        secretFor: (nodeId) => (nodeId === 'local-1' ? secret : null)
      })
      assert.equal(verification.ok, true)
      if (req.url === '/v1/shows') {
        const body = JSON.parse(rawBody)
        agentCreates.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ingest: [
              {
                orientation: 'horizontal',
                serverUrl: 'rtmps://localhost:1936/live',
                streamKey: `${body.showId}-h?key=${body.ingestKey}`
              }
            ],
            controlUrl: `ws://127.0.0.1:20100/v1/shows/${body.showId}/control`
          })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((resolveListen) => agent.listen(0, '127.0.0.1', resolveListen))
    const agentUrl = `http://127.0.0.1:${agent.address().port}`
    void publicKeyBase64Url
    const web = await startFakeCloudWeb({
      sessionToken: 'session-token',
      node: { id: 'local-1', secret, agentUrl },
      signingKey: privateKey,
      talk: {
        // No LiveKit server listens on port 1: its server API calls are
        // refused, which is the 502 path the routes must survive.
        livekit: {
          url: 'ws://127.0.0.1:7880',
          httpUrl: 'http://127.0.0.1:1',
          apiKey: 'devkey',
          apiSecret: 'secret'
        },
        recording: {
          bucket: 'videorc-cloud-recordings',
          endpoint: 'http://127.0.0.1:19461',
          credentials: {
            accessKeyId: 'AK',
            secretAccessKey: 'SK',
            sessionToken: 'TOKEN',
            expiresAt: '2030-01-01T00:00:00.000Z'
          }
        }
      }
    })
    const bearer = { authorization: 'Bearer session-token', 'content-type': 'application/json' }
    try {
      const created = await fetch(`${web.httpOrigin}/api/cloud/shows`, {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({
          kind: 'talk',
          outputs: [
            {
              orientation: 'horizontal',
              width: 1280,
              height: 720,
              fps: 30,
              videoKbps: 4000,
              audioKbps: 160
            }
          ],
          holdMaxSeconds: 900,
          room: {
            returnWidth: 1280,
            returnHeight: 720,
            title: 'Tuesday talk',
            platforms: ['youtube']
          }
        })
      })
      assert.equal(created.status, 201)
      const answer = await created.json()
      const showId = answer.show.id
      assert.equal(answer.show.kind, 'talk')
      assert.equal(answer.room.url, 'ws://127.0.0.1:7880')
      assert.equal(answer.room.name, showId)
      assert.equal(readLiveKitToken(answer.room.hostToken, 'secret').sub, `host:${showId}`)
      assert.ok(isInviteSlug(answer.invite.slug))
      assert.equal(answer.invite.url, `${web.httpOrigin}/guest/${answer.invite.slug}`)
      assert.deepEqual(answer.limits, {
        guestsOnStage: 5,
        roomSize: 10,
        recordingRetentionDays: 30
      })
      // The node got the room (with the runner's visible token) and the
      // recording target under the show's own prefix.
      const create = agentCreates[0]
      assert.equal(create.kind, 'talk')
      assert.equal(create.room.name, showId)
      assert.equal(readLiveKitToken(create.room.runnerToken, 'secret').video.hidden, false)
      assert.equal(create.recording.prefix, `talk/user_cloud_smoke/${showId}/`)
      assert.equal(create.recording.credentials.sessionToken, 'TOKEN')
      assert.equal(web.livekitTokens().length, 2, 'the runner and the host')

      // A fresh host token, the room's settings, the door.
      const token = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/room/token`, {
          method: 'POST',
          headers: bearer
        })
      ).json()
      assert.equal(readLiveKitToken(token.hostToken, 'secret').sub, `host:${showId}`)
      const room = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/room`, { headers: bearer })
      ).json()
      assert.equal(room.room.title, 'Tuesday talk')
      assert.equal(room.room.openDoor, false)
      assert.equal(room.invite.slug, answer.invite.slug)
      const patched = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/room`, {
          method: 'PATCH',
          headers: bearer,
          body: JSON.stringify({ platforms: ['youtube', 'twitch'] })
        })
      ).json()
      assert.deepEqual(patched.room.platforms, ['youtube', 'twitch'])

      // The guest page and the public routes.
      const page = await fetch(`${web.httpOrigin}/guest/${answer.invite.slug}`)
      assert.equal(page.status, 200)
      assert.match(await page.text(), /Tuesday talk/)
      const show = await (await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}`)).json()
      assert.equal(show.state, 'open')
      assert.equal(show.show.title, 'Tuesday talk')
      assert.equal(show.show.recording, true)
      const invalid = await (await fetch(`${web.httpOrigin}/api/guest/0000000000000000`)).json()
      assert.equal(invalid.state, 'invalid')
      const joined = await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', device: 'phone' })
      })
      assert.equal(joined.status, 201)
      const { requestId } = await joined.json()
      assert.ok(isGuestRequestId(requestId))
      const cookie = joined.headers.get('set-cookie')
      assert.match(cookie, /^vrc_guest=/)
      const cookieHeader = cookie.split(';')[0]
      const noCookie = await fetch(
        `${web.httpOrigin}/api/guest/${answer.invite.slug}/join/${requestId}`
      )
      assert.equal(noCookie.status, 404, 'the poll needs the request’s cookie')
      const waiting = await (
        await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}/join/${requestId}`, {
          headers: { cookie: cookieHeader }
        })
      ).json()
      assert.equal(waiting.state, 'waiting')
      // The host sees the request and lets Ada in.
      const guests = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/guests`, { headers: bearer })
      ).json()
      assert.deepEqual(
        guests.requests.map((request) => request.name),
        ['Ada']
      )
      assert.equal(guests.requests[0].device, 'phone')
      const decided = await fetch(
        `${web.httpOrigin}/api/cloud/shows/${showId}/guests/requests/${requestId}`,
        { method: 'POST', headers: bearer, body: JSON.stringify({ decision: 'let-in' }) }
      )
      assert.equal(decided.status, 200)
      const letIn = await (
        await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}/join/${requestId}`, {
          headers: { cookie: cookieHeader }
        })
      ).json()
      assert.equal(letIn.state, 'let-in')
      assert.ok(isGuestId(letIn.guestId))
      assert.equal(letIn.hostIdentity, `host:${showId}`)
      const guestClaims = readLiveKitToken(letIn.room.token, 'secret')
      assert.equal(guestClaims.sub, letIn.guestId)
      assert.equal(guestClaims.name, 'Ada')
      assert.deepEqual(guestClaims.video.canPublishSources, ['camera', 'microphone'])
      const after = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/guests`, { headers: bearer })
      ).json()
      assert.deepEqual(after.requests, [])
      assert.equal(after.guests[0].guestId, letIn.guestId)
      // A mute takes the mic out of the next token.
      await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/guests/${letIn.guestId}`, {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ action: 'mute' })
      })
      const muted = await (
        await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}/join/${requestId}`, {
          headers: { cookie: cookieHeader }
        })
      ).json()
      assert.deepEqual(readLiveKitToken(muted.room.token, 'secret').video.canPublishSources, [
        'camera'
      ])
      // Without a LiveKit server a remove is a 502 and the guest stays listed.
      const removed = await fetch(
        `${web.httpOrigin}/api/cloud/shows/${showId}/guests/${letIn.guestId}`,
        { method: 'POST', headers: bearer, body: JSON.stringify({ action: 'remove' }) }
      )
      assert.equal(removed.status, 502)
      assert.equal(web.guestRequestsFor(showId)[0].state, 'let-in')

      // New link: the old slug is invalid on its next request.
      const rotated = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/invite/rotate`, {
          method: 'POST',
          headers: bearer
        })
      ).json()
      assert.notEqual(rotated.invite.slug, answer.invite.slug)
      const dead = await (await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}`)).json()
      assert.equal(dead.state, 'invalid')
      const deadJoin = await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo', device: 'computer' })
      })
      assert.equal(deadJoin.status, 404)
      // A let-in guest keeps their place behind the dead slug.
      const stillIn = await (
        await fetch(`${web.httpOrigin}/api/guest/${answer.invite.slug}/join/${requestId}`, {
          headers: { cookie: cookieHeader }
        })
      ).json()
      assert.equal(stillIn.state, 'let-in')

      // The node's recording report, signed, under the show's prefix.
      const report = {
        nodeId: 'local-1',
        showId,
        orientation: 'h',
        state: 'complete',
        seconds: 61,
        bytes: 4096,
        startedAt: '2026-11-09T12:00:00.000Z',
        objectKey: `talk/user_cloud_smoke/${showId}/2026-11-09T12-00-00Z-h.mp4`
      }
      const signedPost = (body, timestampMs) => {
        const rawBody = JSON.stringify(body)
        const headers = signNodeRequest({
          direction: 'node-to-web',
          method: 'POST',
          path: '/api/cloud/recordings',
          nodeId: 'local-1',
          secret,
          rawBody,
          timestampMs
        })
        return fetch(`${web.httpOrigin}/api/cloud/recordings`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: rawBody
        })
      }
      const accepted = await signedPost(report, Date.now())
      assert.equal(accepted.status, 200)
      assert.equal(web.recordingsFor(showId)[0].seconds, 61)
      const outside = await signedPost(
        { ...report, objectKey: 'talk/other/sh_x/file.mp4' },
        Date.now() + 1
      )
      assert.equal(outside.status, 403)
      const listed = await (
        await fetch(`${web.httpOrigin}/api/cloud/recordings`, { headers: bearer })
      ).json()
      assert.equal(listed.recordings.length, 1)

      // Close the room: the show ends, the invite dies, the guest reads ended.
      const ended = await fetch(`${web.httpOrigin}/api/cloud/shows/${showId}/end`, {
        method: 'POST',
        headers: bearer
      })
      assert.equal(ended.status, 200)
      const gone = await (await fetch(`${web.httpOrigin}/api/guest/${rotated.invite.slug}`)).json()
      assert.equal(gone.state, 'ended')
      assert.equal(web.roomFor(showId).closedAt !== null, true)
      assert.equal(
        web.state.livekitCalls.some((call) => call.method === 'DeleteRoom'),
        true
      )
      // Nothing recorded for the report carries a token.
      const recorded = JSON.stringify([
        web.state.calls,
        web.state.agentCalls,
        web.state.livekitCalls,
        web.guestRequestsFor(showId)
      ])
      for (const minted of web.livekitTokens()) assert.ok(!recorded.includes(minted))
    } finally {
      await web.close()
      await new Promise((resolveClose) => agent.close(resolveClose))
    }
  })

  it('refuses a talk create without a LiveKit server', async () => {
    const secret = Buffer.alloc(32, 3)
    const { privateKey } = newShowSigningKey()
    const web = await startFakeCloudWeb({
      sessionToken: 'session-token',
      node: { id: 'local-1', secret, agentUrl: 'http://127.0.0.1:1' },
      signingKey: privateKey
    })
    try {
      const refused = await fetch(`${web.httpOrigin}/api/cloud/shows`, {
        method: 'POST',
        headers: { authorization: 'Bearer session-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'talk',
          outputs: [
            {
              orientation: 'horizontal',
              width: 1280,
              height: 720,
              fps: 30,
              videoKbps: 4000,
              audioKbps: 160
            }
          ],
          room: { returnWidth: 1280, returnHeight: 720 }
        })
      })
      assert.equal(refused.status, 503)
      assert.equal((await refused.json()).error.code, 'cloud-rooms-unavailable')
    } finally {
      await web.close()
    }
  })
})
