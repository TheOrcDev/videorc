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
  evaluateTestShowLimit,
  isIngestKey,
  isShowId,
  mintShowToken,
  newIngestKey,
  newShowId,
  createFailure,
  isLoopbackHttpAgent,
  newShowSigningKey,
  newSrtPassphrase,
  NODE_DIRECTION_NODE_TO_WEB,
  NODE_DIRECTION_WEB_TO_NODE,
  nodeCanonicalString,
  nodeSignature,
  parseAgentCreateResponse,
  parseCreateShowBody,
  parseSrtBlock,
  showPublicKeyBase64Url,
  signNodeRequest,
  startFakeCloudWeb,
  verifyNodeRequest,
  verifyShowToken
} from './fake-cloud-web.mjs'

// The v2 vectors both other sides pin (the web and the node agent): the
// secret is the bytes 00..1f, the timestamp 1760000000000.
const VECTOR_SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const VECTOR_TS = 1_760_000_000_000
const END_VECTOR = 'df450ce6019ed5e62568ea73ec4ae3ad5e80f17f846d0f48cb9d3739520611bb'
const HEARTBEAT_VECTOR = 'f79136421193a07e2c2666f08c53087d75cf3cfa48a049ede606dc0c359e97e1'
const HEARTBEAT_OK_VECTOR = 'd45deadad44429798f6fbbddec8e5bb2564c4fc59e0c0bb4219d70150379b609'
const HEALTH_VECTOR = '7a9b7d2802fdf4addab24db89aaae13fc730cfdc50cacdf90b2b33bee2a6537c'
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

/**
 * What the real node agent answers `POST /v1/shows` since C1b (the runner
 * repo's crates/node-agent/src/http.rs and docs/wire-notes.md): 400
 * `bad-request` without an SRT passphrase of 10 to 79 base62 or with a
 * latency outside 120 to 8000 ms; else the stream key
 * `<showId>-h?key=<ingestKey>` and an `srt` block with the show's passphrase.
 */
function nodeCreateAnswer(body, { serverUrl = 'rtmps://127.0.0.1:19360/live' } = {}) {
  const latencyMs = body.srtLatencyMs ?? 1000
  if (
    typeof body.srtPassphrase !== 'string' ||
    !/^[0-9A-Za-z]{10,79}$/.test(body.srtPassphrase) ||
    !Number.isInteger(latencyMs) ||
    latencyMs < 120 ||
    latencyMs > 8000
  ) {
    return {
      status: 400,
      json: { error: { code: 'bad-request', message: 'srtPassphrase must be 10 to 79 base62' } }
    }
  }
  return {
    status: 200,
    json: {
      ingest: [
        {
          orientation: 'horizontal',
          serverUrl,
          streamKey: `${body.showId}-h?key=${body.ingestKey}`,
          srt: {
            url: 'srt://localhost:8890',
            streamId: `publish:live/${body.showId}-h`,
            passphrase: body.srtPassphrase,
            latencyMs
          }
        }
      ],
      controlUrl: `ws://127.0.0.1:9443/v1/shows/${body.showId}/control`
    }
  }
}

describe('fake cloud web: node signatures', () => {
  it('matches the web and node agent v2 vectors byte for byte', () => {
    const vector = (direction, method, path, rawBody) =>
      nodeSignature(VECTOR_SECRET, {
        direction,
        method,
        path,
        timestamp: String(VECTOR_TS),
        rawBody
      })
    assert.equal(
      vector(NODE_DIRECTION_WEB_TO_NODE, 'POST', '/v1/shows/sh_test/end', '{}'),
      END_VECTOR
    )
    assert.equal(
      vector(
        NODE_DIRECTION_NODE_TO_WEB,
        'POST',
        '/api/cloud/nodes/heartbeat',
        '{"nodeId":"eu-hel-1"}'
      ),
      HEARTBEAT_VECTOR
    )
    assert.equal(
      vector(NODE_DIRECTION_NODE_TO_WEB, 'POST', '/api/cloud/nodes/heartbeat', '{"ok":true}'),
      HEARTBEAT_OK_VECTOR
    )
    assert.equal(vector(NODE_DIRECTION_WEB_TO_NODE, 'get', '/v1/health', ''), HEALTH_VECTOR)
    assert.equal(
      nodeCanonicalString({
        direction: NODE_DIRECTION_WEB_TO_NODE,
        method: 'post',
        path: '/v1/shows/sh_test/end',
        timestamp: '1760000000000',
        rawBody: '{}'
      }),
      'v2\nweb-to-node\nPOST\n/v1/shows/sh_test/end\n1760000000000\n{}'
    )
    const headers = signNodeRequest({
      nodeId: 'local-1',
      path: '/v1/shows/sh_test/end',
      rawBody: '{}',
      secret: VECTOR_SECRET,
      timestampMs: VECTOR_TS
    })
    assert.deepEqual(headers, {
      'x-videorc-node': 'local-1',
      'x-videorc-timestamp': '1760000000000',
      'x-videorc-signature': `v2=${END_VECTOR}`
    })
  })

  it('verifies within the skew and refuses everything else', () => {
    const rawBody = '{"ok":true}'
    const path = '/api/cloud/nodes/heartbeat'
    const signed = signNodeRequest({
      direction: NODE_DIRECTION_NODE_TO_WEB,
      nodeId: 'local-1',
      path,
      rawBody,
      secret: VECTOR_SECRET,
      timestampMs: VECTOR_TS
    })
    const headersOf = (overrides = {}) => ({
      get: (name) => ({ ...signed, ...overrides })[name] ?? null
    })
    const secretFor = (nodeId) => (nodeId === 'local-1' ? VECTOR_SECRET : null)
    const verify = (nowMs, overrides, body = rawBody, routed = {}) =>
      verifyNodeRequest({
        headers: headersOf(overrides),
        method: 'POST',
        nowMs,
        path,
        rawBody: body,
        secretFor,
        ...routed
      })
    assert.deepEqual(verify(VECTOR_TS + 299_999), {
      ok: true,
      nodeId: 'local-1',
      timestampMs: VECTOR_TS,
      signature: HEARTBEAT_OK_VECTOR
    })
    assert.equal(verify(VECTOR_TS + 300_001).code, 'node-timestamp-stale')
    assert.equal(verify(VECTOR_TS, {}, '{"ok":false}').code, 'node-signature-invalid')
    // Lane 5 S1: the signature binds the path, the method and the direction.
    assert.equal(
      verify(VECTOR_TS, {}, rawBody, { path: '/api/cloud/usage' }).code,
      'node-signature-invalid'
    )
    assert.equal(verify(VECTOR_TS, {}, rawBody, { method: 'GET' }).code, 'node-signature-invalid')
    assert.equal(
      verify(VECTOR_TS, {}, rawBody, { direction: NODE_DIRECTION_WEB_TO_NODE }).code,
      'node-signature-invalid'
    )
    // A v1 signature is refused outright.
    assert.equal(
      verify(VECTOR_TS, { 'x-videorc-signature': `v1=${HEARTBEAT_OK_VECTOR}` }).code,
      'node-signature-invalid'
    )
    assert.equal(verify(VECTOR_TS, { 'x-videorc-node': 'eu-hel-1' }).code, 'node-unknown')
    assert.equal(verify(VECTOR_TS, { 'x-videorc-node': 'EU-1' }).code, 'node-unknown')
    assert.equal(
      verify(VECTOR_TS, { 'x-videorc-signature': HEARTBEAT_OK_VECTOR }).code,
      'node-signature-invalid'
    )
    assert.equal(
      verify(VECTOR_TS, { 'x-videorc-signature': 'v2=abcd' }).code,
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
    assert.match(newSrtPassphrase(), /^[0-9A-Za-z]{32}$/)
  })

  // C1b, as videorc-web/lib/cloud/agent-client.ts reads the node's answer.
  it('passes the node’s srt blocks through and drops a malformed one by field name', () => {
    const showId = newShowId()
    const passphrase = newSrtPassphrase()
    const srt = {
      url: 'srt://eu-hel-1.live.videorc.com:8890',
      streamId: `publish:live/${showId}-h`,
      passphrase,
      latencyMs: 1000
    }
    const pair = (extra) => ({
      orientation: 'horizontal',
      serverUrl: 'rtmps://eu-hel-1.live.videorc.com:1936/live',
      streamKey: `${showId}-h?key=${newIngestKey()}`,
      ...extra
    })
    const answer = (ingest) => ({ ingest, controlUrl: `wss://n/v1/shows/${showId}/control` })

    const parsed = parseAgentCreateResponse(answer([pair({ srt })]))
    assert.deepEqual(parsed.ingest[0].srt, srt)
    assert.deepEqual(parsed.droppedSrt, [])
    // No block, or null: the feed is RTMPS only.
    for (const none of [{}, { srt: null }]) {
      const rtmpsOnly = parseAgentCreateResponse(answer([pair(none)]))
      assert.equal('srt' in rtmpsOnly.ingest[0], false)
      assert.deepEqual(rtmpsOnly.droppedSrt, [])
    }
    for (const [bad, problem] of [
      ['not a block', 'not-an-object'],
      [{ ...srt, url: 'srt://host:8890?passphrase=x' }, 'url'],
      [{ ...srt, url: 'srt://host' }, 'url'],
      [{ ...srt, streamId: 'has space' }, 'streamId'],
      [{ ...srt, passphrase: 'short' }, 'passphrase'],
      [{ ...srt, passphrase: 'not:base62:at:all' }, 'passphrase'],
      [{ ...srt, latencyMs: 119 }, 'latencyMs'],
      [{ ...srt, latencyMs: 8001 }, 'latencyMs']
    ]) {
      assert.equal(parseSrtBlock(bad), problem)
      const dropped = parseAgentCreateResponse(answer([pair({ srt: bad })]))
      assert.equal('srt' in dropped.ingest[0], false, problem)
      assert.deepEqual(dropped.droppedSrt, [{ orientation: 'horizontal', problem }])
      // The record names the field, never the passphrase.
      assert.ok(!JSON.stringify(dropped.droppedSrt).includes(passphrase))
    }
    // A broken pair still fails the whole answer, as before.
    assert.equal(parseAgentCreateResponse(answer([pair({ streamKey: '' })])), null)
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
    // C6b: a test show parses like a solo show.
    assert.equal(parseCreateShowBody({ kind: 'test', outputs: [output] }).kind, 'test')
    assert.equal(
      parseCreateShowBody({ kind: 'duo', outputs: [output] }).message,
      'kind must be solo, talk or test.'
    )
    assert.ok('message' in parseCreateShowBody({ kind: 'solo', outputs: [] }))
    assert.ok('message' in parseCreateShowBody({ kind: 'solo', outputs: [output, output] }))
    assert.ok(
      'message' in parseCreateShowBody({ kind: 'solo', outputs: [output], holdMaxSeconds: 10 })
    )
    assert.ok('message' in parseCreateShowBody({ kind: 'solo', outputs: [{ ...output, fps: 61 }] }))
  })

  it('mirrors the web rate limit on test shows: six an hour, on the window edge', () => {
    const now = new Date('2026-10-17T12:00:00.000Z')
    const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60_000)
    assert.deepEqual(
      evaluateTestShowLimit({
        now,
        recentCreatedAt: [minutesAgo(60), ...[50, 40, 30, 20, 10].map(minutesAgo)]
      }),
      { ok: true }
    )
    assert.deepEqual(
      evaluateTestShowLimit({ now, recentCreatedAt: [55, 50, 40, 30, 20, 10].map(minutesAgo) }),
      { ok: false, resetAt: '2026-10-17T12:05:00.000Z' }
    )
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
      // The agent's own check: web-to-node, on the path it routed.
      const verification = verifyNodeRequest({
        direction: NODE_DIRECTION_WEB_TO_NODE,
        headers: { get: (name) => req.headers[name] ?? null },
        method: req.method,
        nowMs: Date.now(),
        path: req.url,
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
        agentCreates.push(body)
        const { status, json } = nodeCreateAnswer(body)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const agentCreates = []
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
      // C1b: the key rides in the stream key's query, and the node's srt
      // block reaches the desktop as it is, with the show's passphrase.
      const sent = agentCreates.at(-1)
      assert.equal(created.ingest[0].streamKey, `${created.show.id}-h?key=${sent.ingestKey}`)
      assert.match(sent.srtPassphrase, /^[0-9A-Za-z]{32}$/)
      assert.equal(sent.srtLatencyMs, 1000)
      assert.deepEqual(created.ingest[0].srt, {
        url: 'srt://localhost:8890',
        streamId: `publish:live/${created.show.id}-h`,
        passphrase: sent.srtPassphrase,
        latencyMs: 1000
      })
      assert.equal(web.srtPassphraseFor(created.show.id), sent.srtPassphrase)
      assert.deepEqual(web.state.droppedSrt, [])
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
          'ingestKey',
          'srtPassphrase',
          'srtLatencyMs'
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
      const heartbeatSignedAt = Date.now()
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
            direction: NODE_DIRECTION_NODE_TO_WEB,
            nodeId: 'local-1',
            path: '/api/cloud/nodes/heartbeat',
            rawBody: heartbeat,
            secret,
            timestampMs: heartbeatSignedAt
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
            direction: NODE_DIRECTION_NODE_TO_WEB,
            nodeId: 'local-1',
            path: '/api/cloud/nodes/heartbeat',
            rawBody: heartbeat,
            secret: Buffer.alloc(32, 9),
            timestampMs: Date.now()
          })
        },
        body: heartbeat
      })
      assert.equal(forged.status, 401)
      assert.equal(web.state.signatureFailures, 1)
      // The same signed heartbeat again is a replay; a newer one signed no
      // later than the applied one is stale and changes nothing (lane 5 S2).
      const resend = (timestampMs) =>
        fetch(`${web.httpOrigin}/api/cloud/nodes/heartbeat`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...signNodeRequest({
              direction: NODE_DIRECTION_NODE_TO_WEB,
              nodeId: 'local-1',
              path: '/api/cloud/nodes/heartbeat',
              rawBody: heartbeat,
              secret,
              timestampMs
            })
          },
          body: heartbeat
        })
      const replayed = await resend(heartbeatSignedAt)
      assert.equal(replayed.status, 401)
      assert.equal((await replayed.json()).error.code, 'node-request-replayed')
      const older = await resend(heartbeatSignedAt - 1_000)
      assert.equal(older.status, 409)
      assert.equal((await older.json()).error.code, 'node-heartbeat-stale')
      assert.equal(web.state.heartbeats, 1)
      // A heartbeat signed for the usage route never counts as usage.
      const moved = await fetch(`${web.httpOrigin}/api/cloud/usage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signNodeRequest({
            direction: NODE_DIRECTION_NODE_TO_WEB,
            nodeId: 'local-1',
            path: '/api/cloud/nodes/heartbeat',
            rawBody: heartbeat,
            secret,
            timestampMs: Date.now()
          })
        },
        body: heartbeat
      })
      assert.equal(moved.status, 401)

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
          ...signNodeRequest({
            direction: NODE_DIRECTION_NODE_TO_WEB,
            nodeId: 'local-1',
            path: '/api/cloud/usage',
            rawBody: usage,
            secret,
            timestampMs: Date.now()
          })
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
      for (const record of [logged, JSON.stringify(web.state.agentCalls)]) {
        assert.ok(!record.includes(created.ingest[0].srt.passphrase))
      }
      assert.ok(
        web.state.calls.some((call) => call.path === '/api/cloud/shows' && call.status === 201)
      )
    } finally {
      await web.close()
      await new Promise((resolveClose) => agent.close(resolveClose))
    }
  })

  // C6b: a test show, as videorc-web/lib/cloud/shows-route.ts handles it.
  it('runs a test show: a 30 s solo show to the node, never current, never metered, six an hour', async () => {
    const secret = Buffer.alloc(32, 3)
    const { privateKey } = newShowSigningKey()
    const agentBodies = []
    const agent = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url === '/v1/shows') {
        agentBodies.push(body)
        const { status, json } = nodeCreateAnswer(body, {
          serverUrl: 'rtmps://localhost:19360/live'
        })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((resolveListen) => agent.listen(0, '127.0.0.1', resolveListen))
    const web = await startFakeCloudWeb({
      sessionToken: 'session-token',
      node: { id: 'local-1', secret, agentUrl: `http://127.0.0.1:${agent.address().port}` },
      signingKey: privateKey
    })
    const bearer = { authorization: 'Bearer session-token', 'content-type': 'application/json' }
    const body = (kind) =>
      JSON.stringify({
        kind,
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
        client: { app: 'desktop', version: '0.9.144' }
      })
    const create = (kind) =>
      fetch(`${web.httpOrigin}/api/cloud/shows`, {
        method: 'POST',
        headers: bearer,
        body: body(kind)
      })
    const current = async () =>
      (await fetch(`${web.httpOrigin}/api/cloud/shows/current`, { headers: bearer })).json()
    const end = (id) =>
      fetch(`${web.httpOrigin}/api/cloud/shows/${id}/end`, { method: 'POST', headers: bearer })
    try {
      const createResponse = await create('test')
      assert.equal(createResponse.status, 201)
      const created = await createResponse.json()
      assert.equal(created.show.kind, 'test')
      assert.equal(
        new Date(created.show.expiresAt).getTime() - new Date(created.show.createdAt).getTime(),
        120_000
      )
      // The node needs no protocol change: a solo show with the short cap.
      assert.equal(agentBodies.at(-1).kind, 'solo')
      assert.equal(agentBodies.at(-1).maxShowSeconds, 30)
      // The smokes read what was asked from the call log, never the key.
      const asked = web.state.agentCalls.find((call) => call.showId === created.show.id)
      assert.deepEqual(
        { kind: asked.kind, maxShowSeconds: asked.maxShowSeconds, status: asked.status },
        { kind: 'solo', maxShowSeconds: 30, status: 200 }
      )
      assert.ok(!JSON.stringify(web.state.agentCalls).includes(agentBodies.at(-1).ingestKey))
      // A test gets a passphrase like a show (C1b): the desktop picks the transport.
      assert.match(agentBodies.at(-1).srtPassphrase, /^[0-9A-Za-z]{32}$/)
      assert.equal(created.ingest[0].srt.passphrase, agentBodies.at(-1).srtPassphrase)
      assert.ok(!JSON.stringify(web.state.agentCalls).includes(agentBodies.at(-1).srtPassphrase))
      // Open on the web, so a show cannot start beside it, but never current.
      assert.equal((await create('solo')).status, 409)
      assert.deepEqual(await current(), { show: null })
      assert.equal(web.currentShow(), null)
      assert.equal(web.showsOfKind('test').length, 1)

      const usage = JSON.stringify({
        nodeId: 'local-1',
        reports: [
          {
            showId: created.show.id,
            seq: 1,
            liveSeconds: 10,
            holdSeconds: 0,
            at: new Date().toISOString()
          }
        ]
      })
      const usageResponse = await fetch(`${web.httpOrigin}/api/cloud/usage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signNodeRequest({
            direction: NODE_DIRECTION_NODE_TO_WEB,
            nodeId: 'local-1',
            path: '/api/cloud/usage',
            rawBody: usage,
            secret,
            timestampMs: Date.now()
          })
        },
        body: usage
      })
      assert.deepEqual(await usageResponse.json(), {
        ok: true,
        accepted: [{ showId: created.show.id, seq: 1 }]
      })
      assert.deepEqual(web.state.usageReports, [])
      assert.deepEqual(web.state.testUsageIgnored, [{ showId: created.show.id, seq: 1 }])

      assert.equal((await end(created.show.id)).status, 200)
      // Five more tests this hour pass; the seventh is refused with its reset.
      for (let index = 0; index < 5; index += 1) {
        const next = await create('test')
        assert.equal(next.status, 201)
        assert.equal((await end((await next.json()).show.id)).status, 200)
      }
      const seventh = await create('test')
      assert.equal(seventh.status, 429)
      const refused = await seventh.json()
      assert.equal(refused.error.code, 'cloud-test-limit')
      assert.ok(Date.parse(refused.resetAt) > Date.now())
      // A show is not rate limited by the tests.
      assert.equal((await create('solo')).status, 201)
    } finally {
      await web.close()
      await new Promise((resolveClose) => agent.close(resolveClose))
    }
  })
})

describe('fake cloud web: what the web changed after the cloud test (plan 184)', () => {
  const output = (overrides = {}) => ({
    orientation: 'horizontal',
    width: 1280,
    height: 720,
    fps: 30,
    videoKbps: 4000,
    audioKbps: 160,
    ...overrides
  })

  it('refuses odd frame sizes before any node is asked (lane 3 R2)', () => {
    const parse = (overrides) => parseCreateShowBody({ kind: 'solo', outputs: [output(overrides)] })
    assert.ok('kind' in parse({}))
    assert.match(parse({ width: 1281 }).message, /even/)
    assert.match(parse({ height: 719 }).message, /even/)
  })

  it('names a node that refused the show apart from one that could not be reached', () => {
    assert.equal(createFailure({ status: null, json: null }).code, 'cloud-node-unreachable')
    assert.equal(createFailure({ status: null, json: null }).status, 503)
    assert.equal(
      createFailure({ status: 503, json: { error: { code: 'node-full' } } }).code,
      'cloud-full'
    )
    for (const status of [400, 409, 500, 200]) {
      const failure = createFailure({ status, json: { error: { code: 'bad-request' } } })
      assert.equal(failure.code, 'cloud-node-rejected', String(status))
      // Still 5xx: a desktop that doesn't know the code streams directly.
      assert.equal(failure.status, 502)
    }
  })

  it('takes plaintext control and ingest only from a loopback dev agent (lane 5 S5)', () => {
    const answer = (controlUrl, serverUrl) => ({
      controlUrl,
      ingest: [{ orientation: 'horizontal', serverUrl, streamKey: 'sh_x-h.key' }]
    })
    assert.ok(isLoopbackHttpAgent('http://127.0.0.1:9443'))
    assert.ok(isLoopbackHttpAgent('http://localhost:9443'))
    assert.ok(!isLoopbackHttpAgent('https://127.0.0.1:9443'))
    assert.ok(!isLoopbackHttpAgent('http://eu-hel-1.live.videorc.com:9443'))
    const tls = answer('wss://n.example/v1/shows/x/control', 'rtmps://n.example:1936/live')
    const plain = answer('ws://127.0.0.1:9443/v1/shows/x/control', 'rtmp://127.0.0.1:1935/live')
    assert.ok(parseAgentCreateResponse(tls))
    assert.equal(parseAgentCreateResponse(plain), null)
    assert.equal(
      parseAgentCreateResponse(answer('ws://n.example/c', 'rtmps://n.example:1936/live')),
      null
    )
    assert.equal(
      parseAgentCreateResponse(answer('wss://n.example/c', 'rtmp://n.example:1935/live')),
      null
    )
    assert.ok(parseAgentCreateResponse(plain, { plaintextAllowed: true }))
  })

  it('answers current during a rollback but creates nothing (lane 3 R1)', async () => {
    const secret = Buffer.alloc(32, 7)
    const { privateKey } = newShowSigningKey()
    const agent = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          req.url === '/v1/shows'
            ? {
                ingest: [
                  {
                    orientation: 'horizontal',
                    serverUrl: 'rtmps://localhost:19360/live',
                    streamKey: `${body.showId}-h.${body.ingestKey}`
                  }
                ],
                controlUrl: `ws://127.0.0.1:9443/v1/shows/${body.showId}/control`
              }
            : { ok: true }
        )
      )
    })
    await new Promise((resolveListen) => agent.listen(0, '127.0.0.1', resolveListen))
    const web = await startFakeCloudWeb({
      sessionToken: 'session-token',
      node: { id: 'local-1', secret, agentUrl: `http://127.0.0.1:${agent.address().port}` },
      signingKey: privateKey
    })
    const bearer = { authorization: 'Bearer session-token', 'content-type': 'application/json' }
    const create = () =>
      fetch(`${web.httpOrigin}/api/cloud/shows`, {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ kind: 'solo', outputs: [output()] })
      })
    try {
      const created = await (await create()).json()
      web.setDisabled(true)
      const refused = await create()
      assert.equal(refused.status, 503)
      assert.equal((await refused.json()).error.code, 'cloud-disabled')
      const current = await (
        await fetch(`${web.httpOrigin}/api/cloud/shows/current`, { headers: bearer })
      ).json()
      assert.equal(current.show.id, created.show.id)
      assert.ok(current.control.token.startsWith('vcs1.'))
      const capabilities = await (
        await fetch(`${web.httpOrigin}/api/ai/capabilities`, { headers: bearer })
      ).json()
      assert.equal(capabilities.cloud.enabled, false)
      const ended = await fetch(`${web.httpOrigin}/api/cloud/shows/${created.show.id}/end`, {
        method: 'POST',
        headers: bearer
      })
      assert.equal(ended.status, 200)
      web.setDisabled(false)
      assert.equal((await create()).status, 201)
    } finally {
      await web.close()
      await new Promise((resolveClose) => agent.close(resolveClose))
    }
  })
})

describe('fake cloud web: the create rate limit (C-W6)', () => {
  it('refuses the 13th show an hour, failed creates included, after the open-show check', async () => {
    const secret = Buffer.alloc(32, 7)
    const { privateKey } = newShowSigningKey()
    let refuse = true
    const agent = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      // Every create fails on the node, so no show stays open.
      res.writeHead(refuse && req.url === '/v1/shows' ? 400 : 200, {
        'content-type': 'application/json'
      })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((resolveListen) => agent.listen(0, '127.0.0.1', resolveListen))
    const web = await startFakeCloudWeb({
      sessionToken: 'session-token',
      node: { id: 'local-1', secret, agentUrl: `http://127.0.0.1:${agent.address().port}` },
      signingKey: privateKey
    })
    const create = (kind = 'solo') =>
      fetch(`${web.httpOrigin}/api/cloud/shows`, {
        method: 'POST',
        headers: { authorization: 'Bearer session-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
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
      })
    try {
      for (let index = 0; index < 12; index += 1) {
        const failed = await create()
        assert.equal(failed.status, 502)
        assert.equal((await failed.json()).error.code, 'cloud-node-rejected')
      }
      const thirteenth = await create()
      assert.equal(thirteenth.status, 429)
      const body = await thirteenth.json()
      assert.equal(body.error.code, 'cloud-show-limit')
      assert.ok(Date.parse(body.resetAt) > Date.now())
      // A test keeps its own limit and still runs.
      refuse = false
      assert.notEqual((await create('test')).status, 429)
    } finally {
      await web.close()
      await new Promise((resolveClose) => agent.close(resolveClose))
    }
  })
})
