import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  assertLinuxBetaPointerTransition,
  finalizeVerifiedLinuxBetaPlan,
  inspectLinuxBetaPointerRecovery
} from './linux-beta-publication.mjs'
import { linuxCandidateIdentity } from './linux-release-candidate.mjs'
import { buildLinuxReleaseManifest, buildLinuxUpdateFeedYml } from './linux-release.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const feedKey = 'updates/linux-beta/latest-linux.yml'
const manifestKey = 'releases/linux-beta/latest/release.json'

// Artificial preverified-plan/remote-store fixture. No actual acceptance,
// executable AppImage, network, credentials or production journal is involved.
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
  const events = []
  const remote = new Map()
  let serial = 0
  let heldClaim
  const read = (origin, key) => remote.get(`${origin}:${key}`) ?? null
  const set = (origin, key, body) =>
    remote.set(`${origin}:${key}`, { body: Buffer.from(body), etag: `"etag-${++serial}"` })
  const storage = {
    readCandidate: async (key) => bodies.get(key),
    inspectImmutable: async (origin, key) => {
      events.push(['inspect', origin, key])
      const item = immutable.find((artifact) => artifact.objectKey === key)
      return item && { sha256: item.sha256, sizeBytes: item.sizeBytes }
    },
    readPointer: async (origin, key) => read(origin, key),
    putPointer: async (origin, key, body, condition) => {
      const current = read(origin, key)
      assert.deepEqual(condition, {
        ifMatch: current?.etag ?? null,
        ifNoneMatch: current === null ? '*' : null
      })
      events.push(['put', origin, key, condition])
      set(origin, key, body)
    }
  }
  const journal = {
    claim: async (identity) => {
      assert.equal(heldClaim, undefined, 'an unresolved generation cannot be replaced')
      heldClaim = { generation: 7, identity }
      events.push(['claim', heldClaim])
      return heldClaim
    },
    intent: async (entry) => events.push(['intent', entry]),
    verified: async (entry) => events.push(['verified', entry]),
    complete: async (entry) => events.push(['complete', entry]),
    unknown: async (entry) => events.push(['unknown', entry]),
    abandon: async (entry) => events.push(['abandon', entry])
  }
  const options = {
    plan,
    origins: ['primary', 'mirror'],
    primaryName: 'primary',
    publishedReleaseIds: [],
    storage,
    journal
  }
  return {
    plan,
    options,
    events,
    read,
    set,
    storage,
    journal,
    next: { feed, manifest: manifestBody },
    claim: () => heldClaim,
    run: () => finalizeVerifiedLinuxBetaPlan(options)
  }
}

test('publishes only Beta pointers, mirrors before primary, after all immutable checks and durable intents', async () => {
  const f = fixture()
  const receipt = await f.run()
  assert.equal(receipt.generation, 7)
  assert.equal(receipt.receipts.length, 4)
  const puts = f.events.filter(([kind]) => kind === 'put')
  assert.deepEqual(
    puts.map(([, origin, key]) => [origin, key]),
    [
      ['mirror', feedKey],
      ['mirror', manifestKey],
      ['primary', feedKey],
      ['primary', manifestKey]
    ]
  )
  const firstPut = f.events.findIndex(([kind]) => kind === 'put')
  assert.equal(f.events.slice(0, firstPut).filter(([kind]) => kind === 'inspect').length, 14)
  for (const [index, event] of f.events.entries()) {
    if (event[0] !== 'put') continue
    assert.equal(f.events[index - 1][0], 'intent')
    assert.equal(f.events[index + 1][0], 'verified')
  }
  assert.equal(f.events.at(-1)[0], 'complete')
})

test('uses strong ETag conditions when advancing and performs no PUT for exact retries', async () => {
  const old = fixture('0.16.1')
  for (const identical of [false, true]) {
    const f = fixture()
    const previous = identical ? f : old
    f.options.publishedReleaseIds = [previous.plan.manifest.releaseId]
    for (const origin of f.options.origins) {
      f.set(origin, feedKey, previous.next.feed)
      f.set(origin, manifestKey, previous.next.manifest)
    }
    await f.run()
    const puts = f.events.filter(([kind]) => kind === 'put')
    assert.equal(puts.length, identical ? 0 : 4)
    for (const [, , , condition] of puts) {
      assert.match(condition.ifMatch, /^"etag-/)
      assert.equal(condition.ifNoneMatch, null)
    }
  }
})

test('rejects history regression, same-version changes, incomplete pointers and disappeared publications', () => {
  const f = fixture()
  const old = fixture('0.16.1')
  const missing = { feed: null, manifest: null }
  for (const args of [
    { current: f.next, next: old.next, publishedReleaseIds: [] },
    { current: missing, next: old.next, publishedReleaseIds: [f.plan.manifest.releaseId] },
    { current: missing, next: f.next, publishedReleaseIds: [old.plan.manifest.releaseId] },
    { current: { feed: f.next.feed, manifest: null }, next: f.next, publishedReleaseIds: [] },
    {
      current: { feed: old.next.feed, manifest: f.next.manifest },
      next: f.next,
      publishedReleaseIds: []
    },
    {
      current: { ...f.next, feed: Buffer.concat([f.next.feed, Buffer.from('\n')]) },
      next: f.next,
      publishedReleaseIds: []
    },
    { current: missing, next: f.next, publishedReleaseIds: ['0.16.1-alpha.1'] },
    { current: missing, next: f.next }
  ])
    assert.throws(() => assertLinuxBetaPointerTransition(args))
})

test('refuses foreign, duplicate and changed plan descriptors before claiming publication', async () => {
  for (const change of [
    (f) => {
      f.plan.immutable[0].objectKey = 'updates/windows/latest.yml'
    },
    (f) => {
      f.plan.immutable[1].objectKey = f.plan.immutable[0].objectKey
    },
    (f) => {
      f.plan.immutable.pop()
    },
    (f) => {
      f.plan.candidateIdentity = 'other-candidate'
    },
    (f) => {
      f.plan.pointers.reverse()
    },
    (f) => {
      f.plan.pointers[0].sha256 = 'a'.repeat(64)
    },
    (f) => {
      f.options.origins = ['mirror']
    },
    (f) => {
      f.options.origins.push('primary')
    },
    (f) => {
      delete f.storage.putPointer
    }
  ]) {
    const f = fixture()
    change(f)
    await assert.rejects(f.run())
    assert.equal(f.events.length, 0)
  }
})

test('preflight failures on either origin abandon without any public write', async () => {
  for (const change of [
    (f) => {
      f.storage.readCandidate = async () => Buffer.from('changed feed')
    },
    (f) => {
      f.storage.inspectImmutable = async () => ({ sha256: 'a'.repeat(64), sizeBytes: 1 })
    },
    (f) => {
      f.storage.readPointer = async () => {
        throw new Error('unreachable origin')
      }
    },
    (f) => {
      f.storage.readPointer = async () => ({ body: Buffer.from('x'), etag: 'W/"weak"' })
    },
    (f) => {
      f.options.publishedReleaseIds = ['0.17.0-beta.1']
    },
    (f) => {
      f.set('primary', manifestKey, f.next.manifest)
    }
  ]) {
    const f = fixture()
    change(f)
    await assert.rejects(f.run())
    assert.equal(f.events.filter(([kind]) => kind === 'put' || kind === 'intent').length, 0)
    assert.equal(f.events.at(-1)[0], 'abandon')
  }
})

test('a concurrent pointer replacement fails its conditional PUT and retains the generation', async () => {
  const f = fixture()
  const put = f.storage.putPointer
  f.storage.putPointer = async (...args) => {
    f.set(args[0], args[1], Buffer.from('concurrent writer'))
    return put(...args)
  }
  await assert.rejects(f.run())
  assert.equal(f.events.at(-1)[0], 'unknown')
  assert.equal(f.read('primary', feedKey), null)
  assert.equal(
    f.events.some(([kind]) => kind === 'complete' || kind === 'abandon'),
    false
  )
})

test('lost write responses preserve the original generation and recovery only inspects exact bytes', async () => {
  for (const applied of [false, true]) {
    const f = fixture()
    const put = f.storage.putPointer
    f.storage.putPointer = async (...args) => {
      if (applied) await put(...args)
      throw new Error('response lost')
    }
    await assert.rejects(f.run(), /response lost/)
    const intent = f.events.find(([kind]) => kind === 'intent')[1]
    assert.equal(f.events.at(-1)[0], 'unknown')
    const recover = (override = {}) =>
      inspectLinuxBetaPointerRecovery({
        intent,
        claim: f.claim(),
        readPointer: f.storage.readPointer,
        ...override
      })
    assert.equal((await recover()).state, applied ? 'applied' : 'not-applied')
    await assert.rejects(recover({ claim: { ...f.claim(), generation: 8 } }), /Invalid/)
    await assert.rejects(
      recover({ intent: { ...intent, nextBodyBase64: 'dGFtcGVyZWQ=' } }),
      /changed/
    )
    f.set(intent.origin, intent.objectKey, Buffer.from('foreign bytes'))
    await assert.rejects(recover(), /keep publication blocked/)
    assert.equal(f.events.filter(([kind]) => kind === 'put').length, applied ? 1 : 0)
    await assert.rejects(f.run(), /unresolved generation/)
  }
})

test('ambiguous journal writes, failed readback and lost completion never unlock or report success', async () => {
  for (const change of [
    (f) => {
      f.journal.intent = async () => {
        throw new Error('intent response lost')
      }
    },
    (f) => {
      f.storage.putPointer = async (origin, key) => f.set(origin, key, Buffer.from('corrupt'))
    },
    (f) => {
      f.journal.verified = async () => {
        throw new Error('receipt response lost')
      }
    },
    (f) => {
      f.journal.complete = async () => {
        throw new Error('completion response lost')
      }
    }
  ]) {
    const f = fixture()
    change(f)
    await assert.rejects(f.run())
    assert.equal(f.events.at(-1)[0], 'unknown')
    assert.equal(
      f.events.some(([kind]) => kind === 'abandon'),
      false
    )
  }
})

test('a claim for another plan, origin set or generation cannot reach storage', async () => {
  for (const change of [
    (claim) => ({ ...claim, generation: 0 }),
    (claim) => ({ ...claim, identity: { ...claim.identity, planSha256: 'a'.repeat(64) } }),
    (claim) => ({ ...claim, identity: { ...claim.identity, origins: ['primary'] } })
  ]) {
    const f = fixture()
    f.journal.claim = async (identity) => change({ generation: 7, identity })
    await assert.rejects(f.run(), /durable publication claim/)
    assert.equal(f.events.length, 0)
  }
  const f = fixture()
  f.journal.claim = async (identity) => {
    identity.planSha256 = 'a'.repeat(64)
    return { identity, generation: 7 }
  }
  await assert.rejects(f.run(), /durable publication claim/)
  assert.equal(f.events.length, 0)
})

test('a storage adapter cannot mutate the expected pointer bytes into a false readback pass', async () => {
  const f = fixture()
  f.storage.putPointer = async (origin, key, body) => {
    body.fill(0)
    f.set(origin, key, body)
  }
  await assert.rejects(f.run(), /readback differs/)
  assert.equal(f.events.at(-1)[0], 'unknown')
})

test('a changed final origin immutable object prevents every pointer write', async () => {
  const f = fixture()
  const inspect = f.storage.inspectImmutable
  f.storage.inspectImmutable = async (origin, key) => {
    const result = await inspect(origin, key)
    return origin === 'mirror' ? { ...result, sha256: 'a'.repeat(64) } : result
  }
  await assert.rejects(f.run(), /immutable Beta bytes on mirror/)
  assert.equal(
    f.events.some(([kind]) => kind === 'put' || kind === 'intent'),
    false
  )
})

test('caller changes during a claim cannot replace the inspected plan or origin set', async () => {
  const f = fixture()
  const claim = f.journal.claim
  f.journal.claim = async (identity) => {
    f.plan.pointers[0].objectKey = 'updates/windows/latest.yml'
    f.options.origins.push('foreign')
    f.options.publishedReleaseIds.push('999.0.0-beta.1')
    return claim(identity)
  }
  const result = await f.run()
  assert.deepEqual(result.origins, ['mirror', 'primary'])
  assert.equal(
    f.events.some(([kind, origin]) => kind === 'put' && origin === 'foreign'),
    false
  )
})

test('journal-owned objects cannot change the claimed generation or returned verified receipts', async () => {
  const f = fixture()
  const readCandidate = f.storage.readCandidate
  f.storage.readCandidate = async (...args) => {
    f.claim().generation = 99
    return readCandidate(...args)
  }
  f.journal.complete = async (entry) => {
    assert.equal(entry.generation, 7)
    entry.receipts[0].nextSha256 = 'a'.repeat(64)
    entry.origins.push('foreign')
  }
  const result = await f.run()
  assert.equal(result.generation, 7)
  assert.deepEqual(result.origins, ['mirror', 'primary'])
  assert.ok(result.receipts.every((receipt) => receipt.generation === 7))
  assert.equal(result.receipts[0].nextSha256, f.plan.pointers[0].sha256)
})

test('recovery binds its inspection to the original intent despite caller changes during GET', async () => {
  const f = fixture()
  f.storage.putPointer = async () => {
    throw new Error('response lost')
  }
  await assert.rejects(f.run())
  const intent = f.events.find(([kind]) => kind === 'intent')[1]
  await assert.rejects(
    inspectLinuxBetaPointerRecovery({
      intent,
      claim: f.claim(),
      readPointer: async () => {
        const foreign = Buffer.from('foreign pointer')
        intent.previousSha256 = hash(foreign)
        return { body: foreign, etag: '"foreign"' }
      }
    }),
    /neither prior nor intended/
  )
})

test('recovery recognizes unchanged prior bytes and refuses foreign intents', async () => {
  const old = fixture('0.16.1')
  const f = fixture()
  f.options.publishedReleaseIds = [old.plan.manifest.releaseId]
  for (const origin of f.options.origins) {
    f.set(origin, feedKey, old.next.feed)
    f.set(origin, manifestKey, old.next.manifest)
  }
  f.storage.putPointer = async () => {
    throw new Error('response lost')
  }
  await assert.rejects(f.run())
  const intent = f.events.find(([kind]) => kind === 'intent')[1]
  const recover = (value) =>
    inspectLinuxBetaPointerRecovery({
      intent: value,
      claim: f.claim(),
      readPointer: f.storage.readPointer
    })
  assert.equal((await recover(intent)).state, 'not-applied')
  for (const override of [
    { objectKey: 'updates/windows/latest.yml' },
    { origin: 'foreign' },
    { planSha256: 'a'.repeat(64) },
    { candidateIdentity: 'foreign' },
    { primaryName: 'mirror' },
    { previousSha256: undefined }
  ])
    await assert.rejects(recover({ ...intent, ...override }), /Invalid/)
})
