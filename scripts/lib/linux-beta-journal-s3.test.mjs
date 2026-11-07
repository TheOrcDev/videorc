import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  createLinuxBetaJournalS3Store,
  linuxBetaJournalS3Config
} from './linux-beta-journal-s3.mjs'
import {
  createLinuxBetaPublicationJournal,
  LINUX_BETA_PUBLICATION_JOURNAL_KEY as key
} from './linux-beta-publication-journal.mjs'

const config = {
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  bucket: 'private-journal',
  region: 'test-1',
  endpointUrl: 'https://journal.example.invalid',
  forcePathStyle: true
}
const sha = (body) => createHash('sha256').update(body).digest('hex')
function response(body = '', status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-length': String(Buffer.byteLength(body)), ...headers }
  })
}
function fake({
  ignoreConditions = false,
  losePut = false,
  wrongReadback = false,
  putStatus = 200,
  putEtag = true
} = {}) {
  const objects = new Map(),
    calls = []
  let closes = 0
  return {
    objects,
    calls,
    get closes() {
      return closes
    },
    close() {
      closes++
    },
    async request(url, options) {
      const path = new URL(url).pathname
      const headers = new Headers(options.headers)
      calls.push({ url, ...options, headers })
      const old = objects.get(path)
      if (options.method === 'PUT') {
        if (
          !ignoreConditions &&
          ((headers.get('if-none-match') === '*' && old) ||
            (headers.has('if-match') && headers.get('if-match') !== old?.etag))
        )
          return response('', 412)
        const body = Buffer.from(options.body).toString('utf8')
        const etag = `"${sha(body)}"`
        objects.set(path, { body, etag })
        if (losePut) throw new Error('secret must never appear in the error')
        return response('', putStatus, putEtag ? { etag } : {})
      }
      return old
        ? response(wrongReadback ? '{"changed":true}' : old.body, 200, { etag: old.etag })
        : response('', 404)
    }
  }
}
const make = (transport, options = {}) =>
  createLinuxBetaJournalS3Store({ config, transport, ...options })

test('journal uses signed bounded conditional S3 writes and exact readback', async () => {
  const transport = fake(),
    store = make(transport)
  assert.equal(await store.read(key), null)
  const first = await store.write(key, { generation: 0, active: null }, null)
  const second = await store.write(key, { active: { owner: 'next' }, generation: 1 }, first.etag)
  assert.deepEqual(await store.read(key), second)
  const puts = transport.calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 2)
  assert.equal(puts[0].headers.get('if-none-match'), '*')
  assert.equal(puts[1].headers.get('if-match'), first.etag)
  for (const put of puts) {
    assert.equal(put.headers.get('x-amz-content-sha256'), sha(put.body))
    assert.equal(
      put.headers.get('x-amz-checksum-sha256'),
      Buffer.from(sha(put.body), 'hex').toString('base64')
    )
    assert.match(put.headers.get('authorization'), /SignedHeaders=.*if-(none-)?match/)
    assert.equal(put.headers.get('cache-control'), 'no-store')
    assert.equal(
      new URL(put.url).pathname,
      `/private-journal/videorc-linux-beta-publication/v1/${key}`
    )
  }
  store.close()
  store.close()
  assert.equal(transport.closes, 1)
  await assert.rejects(store.read(key), { code: 'journal-closed' })
})

test('separate journal instances cannot both claim one remote generation', async () => {
  const transport = fake()
  const a = createLinuxBetaPublicationJournal({ store: make(transport) })
  const b = createLinuxBetaPublicationJournal({ store: make(transport) })
  await a.initialize()
  const identity = {
    candidateIdentity: `linux:0.16.1-beta.1:${'a'.repeat(40)}:sha256:${'b'.repeat(64)}`,
    planSha256: 'c'.repeat(64),
    origins: ['primary'],
    primaryName: 'primary'
  }
  const results = await Promise.allSettled([a.claim(identity), b.claim(identity)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
  assert.equal((await a.inspect()).active.generation, 1)
})

test('conflicts never adopt the desired value or retry', async () => {
  const transport = fake(),
    store = make(transport)
  const first = await store.write(key, { n: 1 }, null)
  await assert.rejects(store.write(key, { n: 1 }, null), { code: 'journal-conflict' })
  await store.write(key, { n: 2 }, first.etag)
  await assert.rejects(store.write(key, { n: 2 }, first.etag), { code: 'journal-conflict' })
  assert.equal(transport.calls.filter((c) => c.method === 'PUT').length, 4)
})

for (const options of [
  { losePut: true },
  { wrongReadback: true },
  { putStatus: 503 },
  { putEtag: false }
]) {
  test(`uncertain write remains unknown: ${JSON.stringify(options)}`, async () => {
    const transport = fake(options),
      store = make(transport)
    await assert.rejects(store.write(key, { n: 1 }, null), (error) => {
      assert.equal(error.code, 'journal-write-unknown')
      assert.ok(!error.message.includes('secret'))
      return true
    })
    assert.equal(transport.calls.filter((c) => c.method === 'PUT').length, 1)
    if (options.losePut) assert.equal(transport.calls.length, 1)
  })
}

test('capability probe verifies create, stale-update and concurrent CAS without touching the journal', async () => {
  const transport = fake(),
    store = make(transport)
  const proof = await store.probe()
  assert.equal(proof.concurrentWrite, true)
  assert.equal(transport.objects.size, 1)
  assert.ok(
    [...transport.objects.keys()].every((path) => path.includes('/probes/') && !path.endsWith(key))
  )
  assert.equal(await store.read(key), null)
  await assert.rejects(make(fake({ ignoreConditions: true })).probe(), {
    code: 'journal-condition-unsupported'
  })
})

test('only explicit journal credentials and a reserved private key/prefix are accepted', async () => {
  assert.throws(() =>
    linuxBetaJournalS3Config({ VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'public' })
  )
  const env = Object.fromEntries(
    Object.entries({
      ACCESS_KEY_ID: 'private',
      SECRET_ACCESS_KEY: 'private-secret',
      BUCKET: 'private',
      REGION: 'test-1',
      ENDPOINT_URL: config.endpointUrl,
      TLS_ALLOWED_ISSUER_ORGANIZATIONS: 'Test CA'
    }).map(([k, v]) => [`VIDEORC_LINUX_BETA_JOURNAL_S3_${k}`, v])
  )
  assert.equal(linuxBetaJournalS3Config(env).accessKeyId, 'private')
  const transport = fake(),
    store = make(transport)
  for (const bad of [
    'state.json',
    '../state.json',
    'updates/linux-beta/latest-linux.yml',
    `${key}/extra`
  ]) {
    await assert.rejects(store.read(bad), { code: 'journal-key' })
    assert.throws(() => store.write(bad, {}, null), { code: 'journal-key' })
  }
  for (const prefix of [
    'releases/linux-beta',
    'videorc-linux-beta-publication/v1/..',
    'videorc-release-control/v1'
  ])
    assert.throws(() => make(transport, { prefix }), { code: 'journal-prefix' })
  for (const etag of [undefined, '', '*', 'W/"weak"', 'unquoted', '"a\nb"'])
    await assert.rejects(store.write(key, {}, etag), { code: 'journal-etag' })
  assert.equal(transport.calls.length, 0)
})

test('GET refuses partial, encoded, oversized, truncated, malformed and weak-ETag responses', async () => {
  for (const result of [
    () => response('{}', 206, { etag: '"e"' }),
    () => response('{}', 200, { etag: 'W/"e"' }),
    () => response('{}', 200, { etag: '"e"', 'content-range': 'bytes 0-1/4' }),
    () => response('{}', 200, { etag: '"e"', 'content-encoding': 'gzip' }),
    () => response('{}', 200, { etag: '"e"', 'content-length': String(9 * 1024 * 1024) }),
    () => response('{}', 200, { etag: '"e"', 'content-length': '3' }),
    () => response('{}', 200, { etag: '"e"', 'content-length': '1' }),
    () => response('{', 200, { etag: '"e"' }),
    () => response('[]', 200, { etag: '"e"' })
  ])
    await assert.rejects(make({ request: async () => result(), close() {} }).read(key))
})

test('slow response is bounded and cancels its owned Web stream reader', async () => {
  let cancelled = false
  const body = new ReadableStream({
    cancel() {
      cancelled = true
    }
  })
  const store = make(
    {
      request: async () => new Response(body, { headers: { etag: '"e"', 'content-length': '2' } }),
      close() {}
    },
    { bodyTimeoutMs: 10 }
  )
  await assert.rejects(store.read(key), { code: 'journal-timeout' })
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})

test('the production Node response stream is destroyed after a bounded read', async () => {
  const body = Readable.from([Buffer.from('{}')])
  const store = make({
    request: async () => ({
      status: 200,
      headers: new Headers({ etag: '"e"', 'content-length': '2' }),
      body
    }),
    close() {}
  })
  assert.deepEqual(await store.read(key), { value: {}, etag: '"e"' })
  assert.equal(body.destroyed, true)
})

test('a stalled Node response stream is destroyed when its body deadline expires', async () => {
  const body = new Readable({ read() {} })
  const store = make(
    {
      request: async () => ({
        status: 200,
        headers: new Headers({ etag: '"e"', 'content-length': '2' }),
        body
      }),
      close() {}
    },
    { bodyTimeoutMs: 10 }
  )
  await assert.rejects(store.read(key), { code: 'journal-timeout' })
  assert.equal(body.destroyed, true)
})

for (const kind of ['equivalent-json', 'different-etag', 'lost-readback']) {
  test(`PUT cannot pass with ${kind} readback`, async () => {
    const transport = fake()
    const realRequest = transport.request.bind(transport)
    transport.request = async (url, options) => {
      const result = await realRequest(url, options)
      if (options.method !== 'GET') return result
      if (kind === 'lost-readback') throw new Error('network failed')
      const body = await result.text()
      return response(kind === 'equivalent-json' ? `${body}\n` : body, 200, {
        etag: kind === 'different-etag' ? '"another-generation"' : result.headers.get('etag')
      })
    }
    await assert.rejects(make(transport).write(key, { n: 1 }, null), {
      code: 'journal-write-unknown'
    })
    assert.equal(transport.calls.filter((c) => c.method === 'PUT').length, 1)
  })
}
