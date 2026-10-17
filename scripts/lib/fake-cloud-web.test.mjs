import assert from 'node:assert/strict'
import { createPrivateKey, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'

import {
  applyHeartbeat,
  capabilitiesWithCloud,
  cloudAllowanceBlock,
  decodeNodeSecret,
  encodeNodeSecret,
  isIngestKey,
  isShowId,
  mintShowToken,
  newIngestKey,
  newShowId,
  newShowSigningKey,
  nodeSignature,
  parseCreateShowBody,
  showPublicKeyBase64Url,
  signNodeRequest,
  startFakeCloudWeb,
  verifyNodeRequest,
  verifyShowToken
} from './fake-cloud-web.mjs'

// The runner repo's own vectors (crates/protocol/src/node_sig.rs): the secret
// is the bytes 00..1f, the timestamp 1760000000000.
const VECTOR_SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const VECTOR_TS = 1_760_000_000_000
const BODY_VECTOR = 'e85f9a39558d8e1f22bf6403701f36ad65a557b3a315ca6977e54858018a0a7d'
const EMPTY_VECTOR = '892eea6739c0b6d49e0bdc242ea78266224268a40b518f8f71e9055c6151f6fc'
// RFC 8032 test vector 1 (crates/protocol/src/show_token.rs).
const RFC8032_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const RFC8032_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const OPENSSL_SIGNATURE_HEX =
  'c6d6351ae7d1668c9f07c023141b3a06b407e97e8956ea08e8cf6575ed63e57d6d612a3a4221825c2361ed7aca63f88ca3ca7c4e7fa5bd6040a430a4e1b5010f'
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function rfc8032Key() {
  return createPrivateKey({
    format: 'der',
    type: 'pkcs8',
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(RFC8032_SEED_HEX, 'hex')])
  })
}

describe('fake cloud web: node signatures', () => {
  it('matches the node agent vectors byte for byte', () => {
    assert.equal(nodeSignature(VECTOR_SECRET, String(VECTOR_TS), '{"ok":true}'), BODY_VECTOR)
    assert.equal(nodeSignature(VECTOR_SECRET, String(VECTOR_TS), ''), EMPTY_VECTOR)
    const headers = signNodeRequest({
      nodeId: 'local-1',
      rawBody: '{"ok":true}',
      secret: VECTOR_SECRET,
      timestampMs: VECTOR_TS
    })
    assert.deepEqual(headers, {
      'x-videorc-node': 'local-1',
      'x-videorc-timestamp': '1760000000000',
      'x-videorc-signature': `v1=${BODY_VECTOR}`
    })
  })

  it('verifies within the skew and refuses everything else', () => {
    const rawBody = '{"ok":true}'
    const signed = signNodeRequest({
      nodeId: 'local-1',
      rawBody,
      secret: VECTOR_SECRET,
      timestampMs: VECTOR_TS
    })
    const headersOf = (overrides = {}) => ({
      get: (name) => ({ ...signed, ...overrides })[name] ?? null
    })
    const secretFor = (nodeId) => (nodeId === 'local-1' ? VECTOR_SECRET : null)
    const verify = (nowMs, overrides, body = rawBody) =>
      verifyNodeRequest({ headers: headersOf(overrides), nowMs, rawBody: body, secretFor })
    assert.deepEqual(verify(VECTOR_TS + 299_999), {
      ok: true,
      nodeId: 'local-1',
      timestampMs: VECTOR_TS
    })
    assert.equal(verify(VECTOR_TS + 300_001).code, 'node-timestamp-stale')
    assert.equal(verify(VECTOR_TS, {}, '{"ok":false}').code, 'node-signature-invalid')
    assert.equal(verify(VECTOR_TS, { 'x-videorc-node': 'eu-hel-1' }).code, 'node-unknown')
    assert.equal(verify(VECTOR_TS, { 'x-videorc-node': 'EU-1' }).code, 'node-unknown')
    assert.equal(
      verify(VECTOR_TS, { 'x-videorc-signature': BODY_VECTOR }).code,
      'node-signature-invalid'
    )
    assert.equal(
      verify(VECTOR_TS, { 'x-videorc-signature': 'v1=abcd' }).code,
      'node-signature-invalid'
    )
    assert.equal(
      verify(VECTOR_TS, { 'x-videorc-timestamp': 'yesterday' }).code,
      'node-timestamp-invalid'
    )
    assert.equal(
      verify(VECTOR_TS, { 'x-videorc-signature': undefined }).code,
      'node-signature-missing'
    )
  })

  it('round-trips a node secret through base64url and standard base64', () => {
    const encoded = encodeNodeSecret(VECTOR_SECRET)
    assert.ok(!encoded.includes('='))
    assert.deepEqual(decodeNodeSecret(encoded), VECTOR_SECRET)
    assert.deepEqual(decodeNodeSecret(VECTOR_SECRET.toString('base64')), VECTOR_SECRET)
    assert.equal(decodeNodeSecret('AAAA'), null)
    assert.equal(decodeNodeSecret('!!'), null)
  })
})

describe('fake cloud web: show tokens', () => {
  it('derives the public key the node holds and signs like openssl', () => {
    const key = rfc8032Key()
    assert.equal(
      showPublicKeyBase64Url(key),
      Buffer.from(RFC8032_PUBLIC_HEX, 'hex').toString('base64url')
    )
    const signature = sign(null, Buffer.from('vcs1.eyJ2IjoxfQ', 'utf8'), key)
    assert.equal(signature.toString('hex'), OPENSSL_SIGNATURE_HEX)
  })

  it('mints vcs1 tokens the node-side check accepts and tampering breaks', () => {
    const key = rfc8032Key()
    const nowMs = VECTOR_TS
    const token = mintShowToken({
      key,
      showId: 'sh_0123456789abcdefghijKL',
      nodeId: 'local-1',
      userId: 'user_1',
      nowMs,
      expiresAtMs: nowMs + 3600_000
    })
    assert.ok(token.startsWith('vcs1.'))
    assert.equal(token.split('.').length, 3)
    const publicKey = showPublicKeyBase64Url(key)
    const payload = verifyShowToken({ token, publicKey, nowMs: nowMs + 1000 })
    assert.deepEqual(payload, {
      v: 1,
      sub: 'user_1',
      show: 'sh_0123456789abcdefghijKL',
      node: 'local-1',
      role: 'host',
      iat: nowMs / 1000,
      exp: nowMs / 1000 + 3600
    })
    assert.equal(verifyShowToken({ token, publicKey, nowMs: nowMs + 3600_000 }), null, 'expired')
    const { publicKeyBase64Url: otherKey } = newShowSigningKey()
    assert.equal(verifyShowToken({ token, publicKey: otherKey, nowMs }), null, 'other key')
    const [version, body, signature] = token.split('.')
    const tampered = Buffer.from(JSON.stringify({ ...payload, role: 'producer' })).toString(
      'base64url'
    )
    assert.equal(
      verifyShowToken({ token: `${version}.${tampered}.${signature}`, publicKey, nowMs }),
      null
    )
    assert.equal(verifyShowToken({ token: `v1.${body}.${signature}`, publicKey, nowMs }), null)
  })
})

describe('fake cloud web: bodies', () => {
  it('mints ids in the wire shape', () => {
    const showId = newShowId()
    assert.ok(isShowId(showId), showId)
    assert.ok(!isShowId('sh_short'))
    const ingestKey = newIngestKey()
    assert.ok(isIngestKey(ingestKey), ingestKey)
    assert.ok(!isIngestKey('with-dash-and_underscore_padding00'))
  })

  it('parses the create body as the web does', () => {
    const output = {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 60,
      videoKbps: 6000,
      audioKbps: 160
    }
    assert.deepEqual(
      parseCreateShowBody({
        kind: 'solo',
        outputs: [output],
        holdMaxSeconds: 1800,
        client: { app: 'desktop', version: '0.9.144' }
      }),
      {
        kind: 'solo',
        outputs: [output],
        holdMaxSeconds: 1800,
        client: { app: 'desktop', version: '0.9.144' }
      }
    )
    assert.equal(parseCreateShowBody({ kind: 'solo', outputs: [output] }).holdMaxSeconds, 1800)
    assert.ok('message' in parseCreateShowBody({ kind: 'duo', outputs: [output] }))
    assert.ok('message' in parseCreateShowBody({ kind: 'solo', outputs: [] }))
    assert.ok('message' in parseCreateShowBody({ kind: 'solo', outputs: [output, output] }))
    assert.ok(
      'message' in parseCreateShowBody({ kind: 'solo', outputs: [output], holdMaxSeconds: 10 })
    )
    assert.ok('message' in parseCreateShowBody({ kind: 'solo', outputs: [{ ...output, fps: 61 }] }))
  })

  it('serves the Premium capabilities with the plan and cloud blocks', () => {
    const cloud = cloudAllowanceBlock({ nowMs: Date.UTC(2026, 9, 17, 12) })
    assert.equal(cloud.enabled, true)
    assert.equal(cloud.resetAt, '2026-11-01T00:00:00.000Z')
    const document = capabilitiesWithCloud({ cloud })
    assert.equal(document.entitlement.isPremium, true)
    assert.equal(document.entitlementToken, undefined, 'the unsigned path')
    assert.deepEqual(document.plan, { id: 'max', name: 'Max' })
    assert.equal(document.cloud, cloud)
  })

  it('applies a heartbeat: phases, ended, unknown and forgotten shows', () => {
    const createdAt = new Date('2026-10-17T12:00:00.000Z')
    const show = (id, overrides = {}) => ({
      id,
      nodeId: 'local-1',
      status: 'ready',
      createdAt,
      startedAt: null,
      phaseSinceAt: null,
      lastSeenAt: null,
      endedAt: null,
      endReason: null,
      ...overrides
    })
    const shows = new Map([
      ['sh_AAAAAAAAAAAAAAAAAAAAAA', show('sh_AAAAAAAAAAAAAAAAAAAAAA')],
      ['sh_BBBBBBBBBBBBBBBBBBBBBB', show('sh_BBBBBBBBBBBBBBBBBBBBBB')],
      ['sh_CCCCCCCCCCCCCCCCCCCCCC', show('sh_CCCCCCCCCCCCCCCCCCCCCC')],
      ['sh_DDDDDDDDDDDDDDDDDDDDDD', show('sh_DDDDDDDDDDDDDDDDDDDDDD', { nodeId: 'eu-hel-1' })]
    ])
    const soon = new Date(createdAt.getTime() + 10_000)
    const early = applyHeartbeat(
      shows,
      [
        { showId: 'sh_AAAAAAAAAAAAAAAAAAAAAA', phase: 'live', startedAt: soon },
        { showId: 'sh_ZZZZZZZZZZZZZZZZZZZZZZ', phase: 'live', startedAt: null }
      ],
      { nodeId: 'local-1', now: soon }
    )
    assert.deepEqual(early, {
      endShows: ['sh_ZZZZZZZZZZZZZZZZZZZZZZ'],
      ended: [],
      forgotten: []
    })
    const a = shows.get('sh_AAAAAAAAAAAAAAAAAAAAAA')
    assert.equal(a.status, 'live')
    assert.equal(a.phaseSinceAt, soon)
    assert.equal(a.startedAt, soon)
    assert.equal(shows.get('sh_BBBBBBBBBBBBBBBBBBBBBB').endedAt, null, 'inside the grace')

    const later = new Date(createdAt.getTime() + 60_000)
    const outcome = applyHeartbeat(
      shows,
      [
        { showId: 'sh_AAAAAAAAAAAAAAAAAAAAAA', phase: 'ended', startedAt: null },
        { showId: 'sh_CCCCCCCCCCCCCCCCCCCCCC', phase: 'hold', startedAt: null }
      ],
      { nodeId: 'local-1', now: later }
    )
    assert.deepEqual(outcome, {
      endShows: [],
      ended: ['sh_AAAAAAAAAAAAAAAAAAAAAA'],
      forgotten: ['sh_BBBBBBBBBBBBBBBBBBBBBB']
    })
    assert.equal(shows.get('sh_AAAAAAAAAAAAAAAAAAAAAA').endReason, 'runner-ended')
    assert.equal(shows.get('sh_BBBBBBBBBBBBBBBBBBBBBB').endReason, 'node-forgot')
    assert.equal(shows.get('sh_CCCCCCCCCCCCCCCCCCCCCC').status, 'hold')
    assert.equal(shows.get('sh_DDDDDDDDDDDDDDDDDDDDDD').endedAt, null, "another node's show")
    // An ended show reported again is one the node must stop running.
    const again = applyHeartbeat(
      shows,
      [{ showId: 'sh_AAAAAAAAAAAAAAAAAAAAAA', phase: 'live', startedAt: null }],
      { nodeId: 'local-1', now: later }
    )
    assert.deepEqual(again.endShows, ['sh_AAAAAAAAAAAAAAAAAAAAAA'])
  })
})

describe('fake cloud web: the server against a fake agent', () => {
  it('creates, resumes and ends a show with node-signed agent calls', async () => {
    const secret = Buffer.alloc(32, 7)
    const { privateKey, publicKeyBase64Url } = newShowSigningKey()
    const agentSeen = []
    const agent = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const verification = verifyNodeRequest({
        headers: { get: (name) => req.headers[name] ?? null },
        nowMs: Date.now(),
        rawBody,
        secretFor: (nodeId) => (nodeId === 'local-1' ? secret : null)
      })
      agentSeen.push({
        path: req.url,
        verified: verification.ok,
        bodyKeys: Object.keys(JSON.parse(rawBody))
      })
      if (!verification.ok) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }))
        return
      }
      if (req.url === '/v1/shows') {
        const body = JSON.parse(rawBody)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ingest: [
              {
                orientation: 'horizontal',
                serverUrl: 'rtmps://127.0.0.1:19360/live',
                streamKey: `${body.showId}-h.${body.ingestKey}`
              }
            ],
            controlUrl: `ws://127.0.0.1:9443/v1/shows/${body.showId}/control`
          })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((resolveListen) => agent.listen(0, '127.0.0.1', resolveListen))
    const agentUrl = `http://127.0.0.1:${agent.address().port}`
    const web = await startFakeCloudWeb({
      sessionToken: 'session-token',
      node: { id: 'local-1', secret, agentUrl },
      signingKey: privateKey
    })
    const bearer = { authorization: 'Bearer session-token', 'content-type': 'application/json' }
    try {
      const unauthorized = await fetch(`${web.httpOrigin}/api/cloud/shows/current`)
      assert.equal(unauthorized.status, 401)

      const capabilities = await (
        await fetch(`${web.httpOrigin}/api/ai/capabilities`, { headers: bearer })
      ).json()
      assert.equal(capabilities.cloud.enabled, true)
      assert.equal(capabilities.plan.id, 'max')

      const none = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/current`, { headers: bearer })
      ).json()
      assert.deepEqual(none, { show: null })

      const createBody = JSON.stringify({
        kind: 'solo',
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
        client: { app: 'desktop', version: '0.9.144' }
      })
      const createResponse = await fetch(`${web.httpOrigin}/api/cloud/shows`, {
        method: 'POST',
        headers: bearer,
        body: createBody
      })
      assert.equal(createResponse.status, 201)
      const created = await createResponse.json()
      assert.ok(isShowId(created.show.id))
      assert.equal(created.show.status, 'ready')
      assert.equal(created.show.nodeId, 'local-1')
      assert.equal(created.show.holdMaxSeconds, 900)
      assert.equal(created.ingest[0].serverUrl, 'rtmps://127.0.0.1:19360/live')
      assert.ok(created.ingest[0].streamKey.startsWith(`${created.show.id}-h.`))
      assert.equal(created.control.url, `ws://127.0.0.1:9443/v1/shows/${created.show.id}/control`)
      const payload = verifyShowToken({
        token: created.control.token,
        publicKey: publicKeyBase64Url,
        nowMs: Date.now()
      })
      assert.equal(payload.show, created.show.id)
      assert.equal(payload.node, 'local-1')
      assert.equal(payload.exp, Math.floor(new Date(created.show.expiresAt).getTime() / 1000))
      assert.equal(created.allowance.enabled, true)
      assert.deepEqual(agentSeen.at(-1), {
        path: '/v1/shows',
        verified: true,
        bodyKeys: [
          'showId',
          'userId',
          'kind',
          'outputs',
          'holdMaxSeconds',
          'maxShowSeconds',
          'ingestKey'
        ]
      })

      const conflict = await fetch(`${web.httpOrigin}/api/cloud/shows`, {
        method: 'POST',
        headers: bearer,
        body: createBody
      })
      assert.equal(conflict.status, 409)
      const conflictBody = await conflict.json()
      assert.equal(conflictBody.error.code, 'cloud-show-live')
      assert.equal(conflictBody.show.id, created.show.id)

      const current = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/current`, { headers: bearer })
      ).json()
      assert.equal(current.show.id, created.show.id)
      assert.ok(current.control.token.startsWith('vcs1.'))
      assert.equal(current.control.url, created.control.url)

      // The node reports: a heartbeat with the right signature, then a wrong one.
      const heartbeat = JSON.stringify({
        nodeId: 'local-1',
        version: '0.1.0',
        capacity: { slots: 4, used: 1 },
        shows: [{ showId: created.show.id, phase: 'live', startedAt: new Date().toISOString() }],
        at: new Date().toISOString()
      })
      const heartbeatResponse = await fetch(`${web.httpOrigin}/api/cloud/nodes/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signNodeRequest({
            nodeId: 'local-1',
            rawBody: heartbeat,
            secret,
            timestampMs: Date.now()
          })
        },
        body: heartbeat
      })
      assert.equal(heartbeatResponse.status, 200)
      assert.deepEqual(await heartbeatResponse.json(), { ok: true, endShows: [], drain: false })
      assert.equal(web.currentShow().status, 'live')
      const forged = await fetch(`${web.httpOrigin}/api/cloud/nodes/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signNodeRequest({
            nodeId: 'local-1',
            rawBody: heartbeat,
            secret: Buffer.alloc(32, 9),
            timestampMs: Date.now()
          })
        },
        body: heartbeat
      })
      assert.equal(forged.status, 401)
      assert.equal(web.state.signatureFailures, 1)

      const usage = JSON.stringify({
        nodeId: 'local-1',
        reports: [
          {
            showId: created.show.id,
            seq: 1,
            liveSeconds: 55,
            holdSeconds: 5,
            at: new Date().toISOString()
          },
          {
            showId: 'sh_ZZZZZZZZZZZZZZZZZZZZZZ',
            seq: 1,
            liveSeconds: 1,
            holdSeconds: 0,
            at: new Date().toISOString()
          }
        ]
      })
      const usageResponse = await fetch(`${web.httpOrigin}/api/cloud/usage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signNodeRequest({ nodeId: 'local-1', rawBody: usage, secret, timestampMs: Date.now() })
        },
        body: usage
      })
      assert.deepEqual(await usageResponse.json(), {
        ok: true,
        accepted: [{ showId: created.show.id, seq: 1 }]
      })
      assert.equal(web.state.usageRejected, 1)

      const ended = await fetch(`${web.httpOrigin}/api/cloud/shows/${created.show.id}/end`, {
        method: 'POST',
        headers: bearer
      })
      assert.deepEqual(await ended.json(), { ok: true })
      assert.equal(agentSeen.at(-1).path, `/v1/shows/${created.show.id}/end`)
      assert.equal(web.currentShow(), null)
      const after = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/current`, { headers: bearer })
      ).json()
      assert.deepEqual(after, { show: null })
      const missing = await fetch(
        `${web.httpOrigin}/api/cloud/shows/sh_ZZZZZZZZZZZZZZZZZZZZZZ/end`,
        {
          method: 'POST',
          headers: bearer
        }
      )
      assert.equal(missing.status, 404)

      // The call log names routes and statuses only.
      const logged = JSON.stringify(web.state.calls)
      assert.ok(!logged.includes('session-token'))
      assert.ok(!logged.includes(created.control.token))
      assert.ok(!logged.includes(created.ingest[0].streamKey))
      assert.ok(
        web.state.calls.some((call) => call.path === '/api/cloud/shows' && call.status === 201)
      )
    } finally {
      await web.close()
      await new Promise((resolveClose) => agent.close(resolveClose))
    }
  })
})
