import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  createLinuxBetaPublicationJournal,
  LINUX_BETA_PUBLICATION_JOURNAL_KEY
} from './linux-beta-publication-journal.mjs'
import { canonicalJson } from './release-state.mjs'

const feedKey = 'updates/linux-beta/latest-linux.yml'
const manifestKey = 'releases/linux-beta/latest/release.json'
const hash = (body) => createHash('sha256').update(body).digest('hex')
const identity = () => ({
  candidateIdentity: `linux:0.16.2-beta.1:${'a'.repeat(40)}:sha256:${'b'.repeat(64)}`,
  planSha256: 'c'.repeat(64),
  origins: ['mirror', 'primary'],
  primaryName: 'primary'
})

async function fixture() {
  let remote = null
  let serial = 0
  const f = {
    fault: null,
    writes: 0,
    remote: () => remote,
    store: {
      async read(key) {
        assert.equal(key, LINUX_BETA_PUBLICATION_JOURNAL_KEY)
        return structuredClone(remote)
      },
      async write(key, value, etag) {
        assert.equal(key, LINUX_BETA_PUBLICATION_JOURNAL_KEY)
        assert.equal(etag, remote?.etag ?? null, 'atomic conditional write conflict')
        remote = { value: JSON.parse(canonicalJson(value)), etag: `"generation-${++serial}"` }
        f.writes++
        if (f.fault?.(value)) throw new Error('write response lost')
        return structuredClone(remote)
      }
    },
    journal: () => createLinuxBetaPublicationJournal({ store: f.store })
  }
  await f.journal().initialize()
  f.writes = 0
  return f
}

function intent(claim, origin = 'mirror', objectKey = feedKey) {
  const body = Buffer.from(`Artificial test bytes for ${objectKey}`)
  return {
    ...claim.identity,
    generation: claim.generation,
    origin,
    objectKey,
    previousSha256: null,
    previousEtag: null,
    nextSha256: hash(body),
    nextBodyBase64: body.toString('base64')
  }
}

async function verifiedPublication(journal, claim, { unchanged = false } = {}) {
  const receipts = []
  for (const origin of ['mirror', 'primary']) {
    for (const key of [feedKey, manifestKey]) {
      const entry = intent(claim, origin, key)
      if (unchanged) {
        entry.previousSha256 = entry.nextSha256
        entry.previousEtag = '"prior"'
      } else await journal.intent(entry)
      const receipt = { ...entry, etag: '"readback"' }
      await journal.verified(receipt)
      receipts.push(receipt)
    }
  }
  const result = { ...claim.identity, generation: claim.generation, receipts }
  await journal.complete(result)
  return result
}

test('a fresh process retains the active generation until exact successful completion is acknowledged', async () => {
  const f = await fixture()
  const journal = f.journal()
  const claim = await journal.claim(identity())
  assert.equal(claim.generation, 1)
  await assert.rejects(f.journal().claim(identity()), /unresolved/)
  const result = await verifiedPublication(journal, claim)
  const restarted = f.journal()
  assert.equal((await restarted.inspect()).active.status, 'complete-awaiting-ack')
  await assert.rejects(restarted.claim(identity()), /unresolved/)
  await assert.rejects(restarted.abandon(result), /cannot be abandoned/)
  await assert.rejects(restarted.acknowledge({ ...result, receipts: [] }), /exact successful/)
  await restarted.acknowledge(result)
  assert.deepEqual(await restarted.publishedReleaseIds(), ['0.16.2-beta.1'])
  assert.equal((await restarted.inspect()).active, null)
  assert.equal((await f.journal().claim(identity())).generation, 2)
})

test('independent concurrent coordinators cannot both claim a generation', async () => {
  const f = await fixture()
  const result = await Promise.allSettled([
    f.journal().claim(identity()),
    f.journal().claim(identity())
  ])
  assert.equal(result.filter((entry) => entry.status === 'fulfilled').length, 1)
  assert.equal(result.filter((entry) => entry.status === 'rejected').length, 1)
  assert.equal(f.writes, 1)
})

test('journal claims reject other channels and ambiguous origin identities before any write', async () => {
  for (const override of [
    { candidateIdentity: identity().candidateIdentity.replace('-beta.1:', '-alpha.1:') },
    { candidateIdentity: identity().candidateIdentity.replace('linux:', 'windows:') },
    { origins: [1], primaryName: 1 },
    { origins: ['primary', 'mirror'] },
    { origins: ['primary', 'primary'] },
    { primaryName: 'foreign' },
    { planSha256: 'unverified' }
  ]) {
    const f = await fixture()
    await assert.rejects(f.journal().claim({ ...identity(), ...override }))
    assert.equal(f.writes, 0)
  }
})

test('a lost claim response retains the original claim without retrying or replacing it', async () => {
  const f = await fixture()
  f.fault = () => true
  await assert.rejects(f.journal().claim(identity()), /response lost/)
  assert.equal(f.writes, 1)
  assert.equal((await f.journal().inspect()).active.generation, 1)
  await assert.rejects(f.journal().claim(identity()), /unresolved/)
  assert.equal(f.writes, 1)
})

test('lost intent, verification and completion responses keep an unknown generation locked after restart', async () => {
  for (const phase of ['intent', 'verified', 'complete']) {
    const f = await fixture()
    const journal = f.journal()
    const claim = await journal.claim(identity())
    const entry = intent(claim)
    if (phase === 'intent') {
      f.fault = (value) => value.active.intents.length === 1
      await assert.rejects(journal.intent(entry), /response lost/)
    } else if (phase === 'verified') {
      await journal.intent(entry)
      f.fault = (value) => value.active.receipts.length === 1
      await assert.rejects(journal.verified({ ...entry, etag: '"readback"' }), /response lost/)
    } else {
      f.fault = (value) => value.active.status === 'complete-awaiting-ack'
      await assert.rejects(verifiedPublication(journal, claim), /response lost/)
    }
    f.fault = null
    await journal.unknown({ ...claim.identity, generation: claim.generation })
    const restarted = f.journal()
    assert.equal((await restarted.inspect()).active.status, 'unknown')
    await assert.rejects(restarted.claim(identity()), /unresolved/)
    await assert.rejects(restarted.abandon(entry), /cannot be abandoned/)
    await assert.rejects(restarted.acknowledge(entry), /exact successful/)
  }
})

test('preflight can abandon an untouched claim; a pointer intent cannot abandon or be overwritten', async () => {
  const f = await fixture()
  const journal = f.journal()
  const first = await journal.claim(identity())
  await journal.abandon({ ...first.identity, generation: first.generation })
  const second = await journal.claim(identity())
  assert.equal(second.generation, 2)
  const entry = intent(second)
  await journal.intent(entry)
  await assert.rejects(journal.intent(entry), /overwrite or overtake/)
  await assert.rejects(journal.abandon(entry), /cannot be abandoned/)
  assert.deepEqual((await journal.inspect()).active.intents, [entry])
})

test('foreign owners, pointer destinations, order and bytes never reach a journal write', async () => {
  const f = await fixture()
  const journal = f.journal()
  const claim = await journal.claim(identity())
  const entry = intent(claim)
  for (const override of [
    { generation: 2 },
    { planSha256: 'd'.repeat(64) },
    { origins: ['primary'] },
    { origin: 'foreign' },
    { objectKey: 'updates/linux-alpha/latest-linux.yml' },
    { objectKey: manifestKey },
    { origin: 'primary' },
    { previousSha256: 'e'.repeat(64), previousEtag: 'W/"weak"' },
    { nextBodyBase64: Buffer.from('changed').toString('base64') }
  ])
    await assert.rejects(journal.intent({ ...entry, ...override }))
  assert.equal(f.writes, 1)
  await assert.rejects(journal.verified({ ...entry, etag: '"readback"' }), /lacks its exact/)
  await journal.intent(entry)
  await assert.rejects(
    journal.verified({ ...entry, previousEtag: '"changed"', etag: '"readback"' })
  )
  await assert.rejects(journal.complete({ ...entry, receipts: [] }), /every exact/)
})

test('unchanged pointer observations still require all origins before completion and acknowledgement', async () => {
  const f = await fixture()
  const journal = f.journal()
  const claim = await journal.claim(identity())
  const result = await verifiedPublication(journal, claim, { unchanged: true })
  assert.equal((await journal.inspect()).active.intents.length, 0)
  await journal.acknowledge(result)
  assert.equal((await journal.inspect()).history.length, 1)
})

test('invalid stored state, weak ETags and changed write readback are refused', async () => {
  for (const corrupt of [
    (value) => {
      value.etag = 'W/"weak"'
    },
    (value) => {
      value.value.channel = 'windows'
    },
    (value) => {
      value.value.active.generation = 2
    },
    (value) => {
      value.value.active.status = 'complete-awaiting-ack'
    }
  ]) {
    const f = await fixture()
    await f.journal().claim(identity())
    corrupt(f.remote())
    await assert.rejects(f.journal().inspect())
    await assert.rejects(f.journal().claim(identity()))
    assert.equal(f.writes, 1)
  }
  const f = await fixture()
  const write = f.store.write
  f.store.write = async (...args) => {
    const result = await write(...args)
    result.value.active.identity.planSha256 = 'e'.repeat(64)
    return result
  }
  await assert.rejects(f.journal().claim(identity()), /exact durable readback/)
  await assert.rejects(f.journal().claim(identity()), /unresolved/)
})

test('a caller cannot mutate the identity while a durable read is pending', async () => {
  const f = await fixture()
  const input = identity()
  const expected = identity()
  const read = f.store.read
  f.store.read = async (...args) => {
    input.origins.push('foreign')
    input.planSha256 = 'e'.repeat(64)
    return read(...args)
  }
  const claim = await f.journal().claim(input)
  assert.deepEqual(claim.identity, expected)
  assert.deepEqual(f.remote().value.active.identity, expected)
})

test('a missing journal cannot silently reset the generation, and initialization cannot overwrite one', async () => {
  const f = await fixture()
  await assert.rejects(f.journal().initialize(), /cannot be initialized again/)
  assert.equal(f.writes, 0)
  f.store.read = async () => null
  await assert.rejects(f.journal().claim(identity()), /journal is missing/)
  await assert.rejects(f.journal().publishedReleaseIds(), /journal is missing/)
  assert.equal(f.writes, 0)
})

test('stored receipts with changed bytes or missing intents cannot authorize completion after restart', async () => {
  for (const corrupt of [
    (active) => {
      active.receipts[0].nextSha256 = 'e'.repeat(64)
    },
    (active) => {
      active.intents.shift()
    },
    (active) => {
      active.receipts.reverse()
    }
  ]) {
    const f = await fixture()
    const journal = f.journal()
    const result = await verifiedPublication(journal, await journal.claim(identity()))
    corrupt(f.remote().value.active)
    const count = f.writes
    await assert.rejects(f.journal().inspect())
    await assert.rejects(f.journal().acknowledge(result))
    assert.equal(f.writes, count)
  }
})

test('an acknowledgement response loss is inspected through durable completed history without a second write', async () => {
  const f = await fixture()
  const journal = f.journal()
  const result = await verifiedPublication(journal, await journal.claim(identity()))
  f.fault = (value) => value.active === null
  await assert.rejects(journal.acknowledge(result), /response lost/)
  const count = f.writes
  const restarted = f.journal()
  const state = await restarted.inspect()
  assert.equal(state.active, null)
  assert.equal(state.history[0].generation, result.generation)
  assert.deepEqual(state.history[0].identity, identity())
  assert.equal(
    state.history[0].receiptsSha256,
    hash(canonicalJson(result.receipts.map(({ nextBodyBase64, ...receipt }) => receipt)))
  )
  assert.deepEqual(await restarted.publishedReleaseIds(), ['0.16.2-beta.1'])
  assert.equal(f.writes, count)
})
