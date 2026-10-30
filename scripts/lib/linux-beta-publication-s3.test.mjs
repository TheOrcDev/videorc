import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Readable } from 'node:stream'
import { createLinuxBetaPublicationS3Storage } from './linux-beta-publication-s3.mjs'
import { finalizeVerifiedLinuxBetaPlan } from './linux-beta-publication.mjs'
import { linuxCandidateIdentity } from './linux-release-candidate.mjs'
import { buildLinuxReleaseManifest, buildLinuxUpdateFeedYml } from './linux-release.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const feedKey = 'updates/linux-beta/latest-linux.yml'
const manifestKey = 'releases/linux-beta/latest/release.json'
// Artificial bytes and in-memory HTTP endpoints; no candidate/release evidence.
function fixture(version = '0.16.2') {
  const image = Buffer.from('artificial AppImage')
  const manifest = buildLinuxReleaseManifest({
    artifactPath: `Videorc-${version}-linux-x64.AppImage`,
    packageVersion: version,
    sha256: hash(image),
    sizeBytes: image.length,
    sourceCommit: 'b'.repeat(40),
    releasedAt: '2026-10-01T00:00:00.000Z',
    env: {
      VIDEORC_RELEASE_ID: `${version}-beta.1`,
      VIDEORC_LINUX_RELEASE_STAGE: 'public',
      VIDEORC_LINUX_ACCEPTANCE_STATUS: 'pass',
      VIDEORC_LINUX_ACCEPTANCE_RECORD_URL: `https://github.com/TheOrcDev/videorc/blob/${'c'.repeat(40)}/docs/acceptance/linux-beta/${version}-beta.1.json`
    }
  })
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const feed = Buffer.from(
    buildLinuxUpdateFeedYml({
      filename: manifest.filename,
      version,
      releaseDate: manifest.releasedAt,
      sha512: createHash('sha512').update(image).digest('base64'),
      sizeBytes: image.length
    })
  )
  const prefix = `releases/linux-beta/${manifest.releaseId}`
  const candidate = `candidates/linux-beta/${manifest.releaseId}/${manifest.sourceCommit}`
  const bodies = new Map()
  const immutable = [
    ['appimage', manifest.filename, image],
    ['sha256', `${manifest.filename}.sha256`, Buffer.from('artificial sidecar')],
    ['update-feed', 'latest-linux.yml', feed],
    ['ffmpeg-license', 'FFMPEG-LICENSE.txt', Buffer.from('artificial license')],
    ['ffmpeg-source', 'FFMPEG-SOURCE.txt', Buffer.from('artificial source')],
    ['manifest', 'release.json', manifestBody]
  ].map(([label, name, body]) => {
    bodies.set(`${candidate}/${name}`, body)
    return {
      label,
      objectKey: `${prefix}/${name}`,
      sha256: hash(body),
      sizeBytes: body.length,
      ...(label === 'manifest'
        ? { bodyBase64: body.toString('base64') }
        : { sourceObjectKey: `${candidate}/${name}` })
    }
  })
  immutable.push({ ...immutable[0], objectKey: `updates/linux-beta/${manifest.filename}` })
  const plan = {
    mode: 'read-only',
    requiresProtectedFinalizer: true,
    candidateIdentity: linuxCandidateIdentity({
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
      appImageSha256: manifest.sha256
    }),
    manifest,
    immutable,
    pointers: [
      { ...immutable[2], objectKey: feedKey },
      { ...immutable[5], objectKey: manifestKey }
    ]
  }
  return { plan, bodies, feed, manifestBody, image }
}

const config = (bucket) => ({
  accessKeyId: `${bucket}-key`,
  secretAccessKey: 'test-secret',
  bucket,
  region: 'test-1',
  endpointUrl: 'https://storage.example.invalid',
  forcePathStyle: true
})
const response = (body = '', status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: { 'content-length': String(Buffer.byteLength(body)), ...headers }
  })
function setup() {
  const data = fixture(),
    calls = [],
    objects = new Map()
  let serial = 0,
    intercept,
    closes = 0
  const put = (bucket, key, body) =>
    objects.set(`/${bucket}/${key}`, { body: Buffer.from(body), etag: `"e${++serial}"` })
  for (const [key, body] of data.bodies) put('candidate', key, body)
  for (const origin of ['primary', 'mirror']) {
    for (const item of data.plan.immutable)
      put(
        origin,
        item.objectKey,
        item.bodyBase64
          ? Buffer.from(item.bodyBase64, 'base64')
          : data.bodies.get(item.sourceObjectKey)
      )
  }
  const transport = {
    close() {
      closes++
    },
    async request(url, options) {
      const path = new URL(url).pathname,
        headers = new Headers(options.headers)
      const call = { path, ...options, headers }
      calls.push(call)
      if (intercept) {
        const result = await intercept(call)
        if (result) return result
      }
      const previous = objects.get(path)
      if (options.method === 'PUT') {
        if (
          (headers.get('if-none-match') === '*' && previous) ||
          (headers.has('if-match') && headers.get('if-match') !== previous?.etag)
        )
          return response('', 412)
        const value = { body: Buffer.from(options.body), etag: `"e${++serial}"` }
        objects.set(path, value)
        return response('', 200, { etag: value.etag })
      }
      return previous ? response(previous.body, 200, { etag: previous.etag }) : response('', 404)
    }
  }
  const settings = {
    plan: data.plan,
    candidate: { config: config('candidate'), transport },
    origins: ['primary', 'mirror'].map((name) => ({ name, config: config(name), transport }))
  }
  return {
    ...data,
    calls,
    objects,
    put,
    settings,
    store: createLinuxBetaPublicationS3Storage(settings),
    intercept(fn) {
      intercept = fn
    },
    get closes() {
      return closes
    }
  }
}

test('candidate read uses its own credentials and exact source/hash/size', async () => {
  const f = setup(),
    item = f.plan.pointers[0]
  assert.deepEqual(
    await f.store.readCandidate(item.sourceObjectKey, { maxBytes: item.sizeBytes }),
    f.feed
  )
  assert.equal(f.calls.length, 1)
  const call = f.calls[0]
  assert.match(call.headers.get('authorization'), /Credential=candidate-key\//)
  assert.equal(call.headers.get('accept-encoding'), 'identity')
  assert.equal(call.headers.get('cache-control'), 'no-store')
  f.put('candidate', item.sourceObjectKey, Buffer.alloc(item.sizeBytes, 120))
  await assert.rejects(f.store.readCandidate(item.sourceObjectKey, { maxBytes: item.sizeBytes }), {
    code: 'beta-storage-identity'
  })
})

test('immutable proof hashes GET bytes, including Node streams; metadata is not proof', async () => {
  const f = setup(),
    item = f.plan.immutable[0],
    actual = Buffer.from('changed bytes')
  f.intercept(() => ({
    status: 200,
    headers: new Headers({
      'content-length': String(actual.length),
      'x-amz-meta-sha256': item.sha256
    }),
    body: Readable.from([actual.subarray(0, 3), actual.subarray(3)])
  }))
  const value = await f.store.inspectImmutable('primary', item.objectKey, {
    maxBytes: item.sizeBytes
  })
  assert.deepEqual(value, { sha256: hash(actual), sizeBytes: actual.length })
  assert.notEqual(value.sha256, item.sha256)
  assert.equal(f.calls[0].method, 'GET')
})

test('pointer writes sign exact bytes and explicit create/CAS conditions; stale writes fail once', async () => {
  const f = setup()
  assert.equal(await f.store.readPointer('primary', feedKey), null)
  await f.store.putPointer('primary', feedKey, f.feed, { ifMatch: null, ifNoneMatch: '*' })
  const readback = await f.store.readPointer('primary', feedKey)
  assert.deepEqual(readback.body, f.feed)
  await f.store.putPointer('primary', feedKey, f.feed, {
    ifMatch: readback.etag,
    ifNoneMatch: null
  })
  await assert.rejects(
    f.store.putPointer('primary', feedKey, f.feed, { ifMatch: readback.etag, ifNoneMatch: null }),
    { code: 'beta-storage-conflict' }
  )
  const writes = f.calls.filter((c) => c.method === 'PUT')
  assert.equal(writes.length, 3)
  assert.equal(writes[0].headers.get('if-none-match'), '*')
  assert.equal(writes[1].headers.get('if-match'), readback.etag)
  for (const call of writes) {
    assert.equal(call.headers.get('x-amz-content-sha256'), hash(f.feed))
    assert.equal(
      call.headers.get('x-amz-checksum-sha256'),
      Buffer.from(hash(f.feed), 'hex').toString('base64')
    )
    assert.match(call.headers.get('authorization'), /Credential=primary-key\//)
    assert.match(call.headers.get('authorization'), /SignedHeaders=.*if-(none-)?match/)
  }
})

test('no foreign origins, keys, candidate limits, bodies or unconditioned writes reach transport', async () => {
  const f = setup(),
    item = f.plan.pointers[0]
  const rejected = [
    () => f.store.readPointer('unknown', feedKey),
    () => f.store.readPointer('primary', 'updates/linux-alpha/latest-linux.yml'),
    () => f.store.readPointer('primary', '../latest-linux.yml'),
    () => f.store.inspectImmutable('primary', feedKey, { maxBytes: item.sizeBytes }),
    () =>
      f.store.readCandidate(item.sourceObjectKey.replace('beta', 'alpha'), {
        maxBytes: item.sizeBytes
      }),
    () => f.store.readCandidate(item.sourceObjectKey, { maxBytes: item.sizeBytes + 1 }),
    () =>
      f.store.putPointer('primary', feedKey, Buffer.from('changed'), {
        ifMatch: null,
        ifNoneMatch: '*'
      }),
    ...[
      undefined,
      {},
      { ifMatch: null, ifNoneMatch: null },
      { ifMatch: 'W/"weak"', ifNoneMatch: null },
      { ifMatch: '"strong"', ifNoneMatch: '*' }
    ].map((condition) => () => f.store.putPointer('primary', feedKey, f.feed, condition))
  ]
  for (const action of rejected) await assert.rejects(action)
  assert.equal(f.calls.length, 0)
})

for (const [label, status, headers, body] of [
  ['redirect', 302, {}, 'x'],
  ['partial status', 206, {}, 'x'],
  ['range', 200, { 'content-range': 'bytes 0-0/5' }, 'x'],
  ['encoded', 200, { 'content-encoding': 'gzip' }, 'x'],
  ['missing length', 200, { 'content-length': '' }, 'x'],
  ['invalid length', 200, { 'content-length': '1e1' }, 'x'],
  ['truncated', 200, { 'content-length': '5' }, 'x'],
  ['overflow', 200, { 'content-length': '1' }, 'xx'],
  ['oversized', 200, { 'content-length': '3000000' }, 'x'],
  ['weak etag', 200, { etag: 'W/"x"' }, 'x']
]) {
  test(`pointer refuses ${label}`, async () => {
    const f = setup()
    f.intercept(() => response(body, status, { etag: '"x"', ...headers }))
    await assert.rejects(f.store.readPointer('primary', feedKey))
    assert.equal(f.calls.length, 1)
  })
}

test('stalled Web body is cancelled within its bound without waiting for cancellation', async () => {
  const f = setup()
  let cancelled = false
  const stalled = new ReadableStream({
    cancel() {
      cancelled = true
      return new Promise(() => {})
    }
  })
  f.intercept(() => ({
    status: 200,
    headers: new Headers({ etag: '"x"', 'content-length': '1' }),
    body: stalled
  }))
  const store = createLinuxBetaPublicationS3Storage({ ...f.settings, bodyTimeoutMs: 20 })
  await assert.rejects(store.readPointer('primary', feedKey), { code: 'beta-storage-timeout' })
  assert.equal(cancelled, true)
})

test('non-byte streamed objects are refused and the iterator is closed', async () => {
  const f = setup()
  let returned = false
  f.intercept(() => ({
    status: 200,
    headers: new Headers({ etag: '"x"', 'content-length': '1' }),
    body: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: 'x' }
          },
          async return() {
            returned = true
            return { done: true }
          }
        }
      }
    }
  }))
  await assert.rejects(f.store.readPointer('primary', feedKey), { code: 'beta-storage-body' })
  assert.equal(returned, true)
})

test('stream read failures discard transport details and close the owned body', async () => {
  const f = setup()
  let destroyed = false
  f.intercept(() => ({
    status: 200,
    headers: new Headers({ etag: '"x"', 'content-length': '1' }),
    body: {
      destroy() {
        destroyed = true
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error('test-secret transport details')
          }
        }
      }
    }
  }))
  await assert.rejects(f.store.readPointer('primary', feedKey), (error) => {
    assert.equal(error.code, 'beta-storage-read')
    assert.ok(!error.message.includes('test-secret'))
    return true
  })
  assert.equal(destroyed, true)
})

test('request timeout closes sockets, preserves uncertain write and disposes a late response', async () => {
  const f = setup()
  let resolveRequest,
    disposed = false
  f.intercept(
    () =>
      new Promise((resolve) => {
        resolveRequest = resolve
      })
  )
  const store = createLinuxBetaPublicationS3Storage({ ...f.settings, requestTimeoutMs: 20 })
  await assert.rejects(
    store.putPointer('primary', feedKey, f.feed, { ifMatch: null, ifNoneMatch: '*' }),
    { code: 'beta-storage-write-unknown' }
  )
  assert.equal(f.closes, 1)
  assert.equal(f.calls.length, 1)
  const late = {
    status: 200,
    headers: new Headers({ etag: '"late"' }),
    body: {
      destroy() {
        disposed = true
      }
    }
  }
  resolveRequest(late)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(disposed, true)
  await assert.rejects(store.readPointer('primary', feedKey), { code: 'beta-storage-closed' })
  assert.equal(f.calls.length, 1)
})

for (const mode of ['lost response', '503', 'missing etag']) {
  test(`ambiguous ${mode} write is never retried or adopted`, async () => {
    const f = setup()
    f.intercept((call) => {
      assert.equal(call.method, 'PUT')
      if (mode === 'lost response') throw new Error('test-secret must never leak')
      return response('', mode === '503' ? 503 : 200)
    })
    await assert.rejects(
      f.store.putPointer('primary', feedKey, f.feed, { ifMatch: null, ifNoneMatch: '*' }),
      (error) => {
        assert.equal(error.code, 'beta-storage-write-unknown')
        assert.ok(!error.message.includes('test-secret'))
        return true
      }
    )
    assert.equal(f.calls.length, 1)
  })
}

test('adapter snapshots config/plan and closes each shared transport once', async () => {
  const f = setup()
  f.settings.origins[0].config.bucket = 'foreign'
  f.plan.pointers[0].sha256 = '0'.repeat(64)
  await f.store.putPointer('primary', feedKey, f.feed, { ifMatch: null, ifNoneMatch: '*' })
  assert.equal(f.calls[0].path, `/primary/${feedKey}`)
  f.store.close()
  f.store.close()
  assert.equal(f.closes, 1)
  await assert.rejects(f.store.readPointer('primary', feedKey), { code: 'beta-storage-closed' })
})

function transaction(f) {
  const events = []
  const journal = {
    async claim(identity) {
      events.push('claim')
      return { generation: 1, identity }
    },
    ...Object.fromEntries(
      ['intent', 'verified', 'complete', 'unknown', 'abandon'].map((name) => [
        name,
        async () => {
          events.push(name)
        }
      ])
    )
  }
  return {
    events,
    run: () =>
      finalizeVerifiedLinuxBetaPlan({
        plan: f.plan,
        origins: ['primary', 'mirror'],
        primaryName: 'primary',
        publishedReleaseIds: [],
        storage: f.store,
        journal
      })
  }
}

test('transaction verifies actual immutable bytes on both origins before mirror-first pointer publication', async () => {
  const f = setup(),
    tx = transaction(f)
  await tx.run()
  assert.equal(tx.events.at(-1), 'complete')
  const firstPut = f.calls.findIndex((c) => c.method === 'PUT')
  assert.equal(
    f.calls
      .slice(0, firstPut)
      .filter((c) => f.plan.immutable.some((item) => c.path.endsWith(`/${item.objectKey}`))).length,
    14
  )
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'PUT').map((c) => c.path),
    [
      `/mirror/${feedKey}`,
      `/mirror/${manifestKey}`,
      `/primary/${feedKey}`,
      `/primary/${manifestKey}`
    ]
  )
})

test('changed immutable bytes prevent every pointer write', async () => {
  const f = setup(),
    tx = transaction(f),
    item = f.plan.immutable[0]
  f.put('mirror', item.objectKey, Buffer.alloc(item.sizeBytes, 120))
  await assert.rejects(tx.run, /immutable Beta bytes/)
  assert.equal(tx.events.at(-1), 'abandon')
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0)
})

test('changed readback retains unknown journal state and stops before the primary', async () => {
  const f = setup(),
    tx = transaction(f)
  let written = false
  f.intercept((call) => {
    if (call.method === 'PUT') written = true
    else if (written && call.path === `/mirror/${feedKey}`)
      return response('changed', 200, { etag: '"different"' })
  })
  await assert.rejects(tx.run, /readback differs/)
  assert.equal(tx.events.at(-1), 'unknown')
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1)
})
