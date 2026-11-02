import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { linuxCandidateIdentity } from './linux-release-candidate.mjs'
import { parseLinuxReleaseId } from './linux-release.mjs'
import { canonicalJson } from './release-state.mjs'

export const LINUX_BETA_PUBLICATION_JOURNAL_KEY = 'linux-beta-publication/state.json'
const feedKey = 'updates/linux-beta/latest-linux.yml'
const manifestKey = 'releases/linux-beta/latest/release.json'
const digest = (value) => createHash('sha256').update(value).digest('hex')
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const strongEtag = (value) => typeof value === 'string' && /^"[\x21\x23-\x7e]+"$/.test(value)
const requireState = (ok, message) => {
  if (!ok) throw new Error(message)
}
const identityOf = ({ candidateIdentity, planSha256, origins, primaryName }) => ({
  candidateIdentity,
  planSha256,
  origins,
  primaryName
})

function releaseId(identity) {
  const [platform, id, sourceCommit, algorithm, appImageSha256, extra] = String(
    identity?.candidateIdentity
  ).split(':')
  requireState(
    platform === 'linux' && algorithm === 'sha256' && extra === undefined,
    'Invalid journal candidate identity.'
  )
  requireState(parseLinuxReleaseId(id).channel === 'beta', 'The journal accepts only Linux Beta.')
  requireState(
    linuxCandidateIdentity({ releaseId: id, sourceCommit, appImageSha256 }) ===
      identity.candidateIdentity,
    'Invalid journal candidate coordinates.'
  )
  return id
}

function assertIdentity(identity) {
  releaseId(identity)
  requireState(
    sha(identity.planSha256) &&
      Array.isArray(identity.origins) &&
      identity.origins.length > 0 &&
      identity.origins.length <= 8 &&
      identity.origins.every(
        (origin) => typeof origin === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(origin)
      ) &&
      new Set(identity.origins).size === identity.origins.length &&
      isDeepStrictEqual([...identity.origins].sort(), identity.origins) &&
      identity.origins.includes(identity.primaryName) &&
      isDeepStrictEqual(identity, identityOf(identity)),
    'Invalid publication journal identity or origins.'
  )
}

function assertOwner(entry, active) {
  requireState(
    active &&
      entry.generation === active.generation &&
      isDeepStrictEqual(identityOf(entry), active.identity),
    'The publication journal generation belongs to another operation.'
  )
}

function assertPointer(entry, active, { receipt = false, compact = false } = {}) {
  assertOwner(entry, active)
  requireState(
    active.identity.origins.includes(entry.origin) &&
      [feedKey, manifestKey].includes(entry.objectKey) &&
      sha(entry.nextSha256) &&
      (entry.previousSha256 === null
        ? entry.previousEtag === null
        : sha(entry.previousSha256) && strongEtag(entry.previousEtag)) &&
      (!receipt || strongEtag(entry.etag)),
    'Invalid journal pointer identity or ETag.'
  )
  if (!compact) {
    requireState(
      typeof entry.nextBodyBase64 === 'string' && entry.nextBodyBase64.length <= 3 * 1024 * 1024,
      'Invalid journal pointer bytes.'
    )
    const bytes = Buffer.from(entry.nextBodyBase64, 'base64')
    requireState(
      bytes.length > 0 &&
        bytes.length <= 2 * 1024 * 1024 &&
        bytes.toString('base64') === entry.nextBodyBase64 &&
        digest(bytes) === entry.nextSha256,
      'Journal pointer bytes changed.'
    )
  }
}

const slot = (entry) => `${entry.origin}:${entry.objectKey}`
function compactReceipt(entry) {
  const { nextBodyBase64, ...receipt } = entry
  return receipt
}

function assertState(state) {
  requireState(
    Buffer.byteLength(JSON.stringify(state)) <= 8 * 1024 * 1024 &&
      state.schemaVersion === 1 &&
      state.channel === 'linux-beta' &&
      Number.isSafeInteger(state.generation) &&
      state.generation >= 0 &&
      Array.isArray(state.history) &&
      state.history.length <= 1024,
    'Invalid or oversized Linux Beta journal state.'
  )
  let previous = 0
  for (const record of state.history) {
    assertIdentity(record.identity)
    requireState(
      Number.isSafeInteger(record.generation) &&
        record.generation > previous &&
        record.generation <= state.generation &&
        sha(record.receiptsSha256),
      'Invalid publication journal history.'
    )
    previous = record.generation
  }
  const active = state.active
  if (active === null) return
  assertIdentity(active?.identity)
  requireState(
    active.generation === state.generation &&
      active.generation > previous &&
      ['claimed', 'writing', 'unknown', 'complete-awaiting-ack'].includes(active.status) &&
      Array.isArray(active.intents) &&
      Array.isArray(active.receipts) &&
      active.intents.length <= active.identity.origins.length * 2 &&
      active.receipts.length <= active.identity.origins.length * 2 &&
      new Set(active.intents.map(slot)).size === active.intents.length &&
      new Set(active.receipts.map(slot)).size === active.receipts.length,
    'Invalid active publication journal generation.'
  )
  for (const intent of active.intents) assertPointer(intent, active)
  for (const [index, receipt] of active.receipts.entries()) {
    assertPointer(receipt, active, { receipt: true, compact: true })
    assertOrder(
      { ...active, status: 'writing', receipts: active.receipts.slice(0, index) },
      receipt
    )
    const intent = active.intents.find((entry) => slot(entry) === slot(receipt))
    const { etag, ...observed } = receipt
    requireState(
      intent
        ? isDeepStrictEqual(compactReceipt(intent), observed)
        : receipt.previousSha256 === receipt.nextSha256,
      'A stored receipt disagrees with its write intent or unchanged observation.'
    )
  }
  const pending = active.intents.filter(
    (intent) => !active.receipts.some((receipt) => slot(receipt) === slot(intent))
  )
  requireState(pending.length <= 1, 'Multiple unresolved journal pointer writes.')
  for (const intent of pending) assertOrder({ ...active, status: 'writing' }, intent)
  requireState(
    active.status !== 'claimed' || active.intents.length === 0,
    'A claimed generation cannot conceal public write intents.'
  )
  requireState(
    active.status !== 'complete-awaiting-ack' ||
      active.receipts.length === active.identity.origins.length * 2,
    'A completed generation must retain every verified pointer.'
  )
}

function assertOrder(active, entry) {
  requireState(
    active.status === 'claimed' || active.status === 'writing',
    'Unresolved or completed publication requires explicit recovery or acknowledgement.'
  )
  requireState(
    entry.objectKey !== manifestKey ||
      active.receipts.some(
        (receipt) => receipt.origin === entry.origin && receipt.objectKey === feedKey
      ),
    'The feed must be verified before its manifest.'
  )
  requireState(
    entry.origin !== active.identity.primaryName ||
      active.receipts.filter((receipt) => receipt.origin !== entry.origin).length ===
        (active.identity.origins.length - 1) * 2,
    'All mirror pointers must be verified before the primary.'
  )
}

// The store must be private durable storage with strongly consistent reads and
// atomic create-only / exact-ETag compare-and-swap writes. A local file or an
// unconditional S3 PUT is not an implementation of this interface. Writes must
// return their verified { value, etag }; an ambiguous response is an error.
// Initialization is a separate provisioning operation: the protected operator
// must establish that no prior Beta publication exists before calling it. A
// missing journal during ordinary operation is an error, never generation one.
// No credentials, networking, controller activation or CLI live in this module.
export function createLinuxBetaPublicationJournal({ store }) {
  requireState(
    typeof store?.read === 'function' && typeof store?.write === 'function',
    'A durable conditional journal store is required.'
  )
  async function read() {
    const result = await store.read(LINUX_BETA_PUBLICATION_JOURNAL_KEY)
    requireState(
      result !== null,
      'Publication journal is missing; explicit provisioning or recovery is required.'
    )
    requireState(strongEtag(result?.etag), 'The journal store must return a strong ETag.')
    const value = structuredClone(result.value)
    assertState(value)
    return { value, etag: result.etag }
  }
  async function persist(before, value) {
    assertState(value)
    const result = await store.write(
      LINUX_BETA_PUBLICATION_JOURNAL_KEY,
      structuredClone(value),
      before.etag
    )
    requireState(
      strongEtag(result?.etag) && isDeepStrictEqual(result.value, value),
      'Journal write lacks exact durable readback; keep this generation blocked.'
    )
  }
  async function mutate(input, action) {
    const entry = structuredClone(input)
    const before = await read()
    const state = structuredClone(before.value)
    assertOwner(entry, state.active)
    action(state, entry)
    await persist(before, state)
  }
  const journal = {
    async initialize() {
      requireState(
        (await store.read(LINUX_BETA_PUBLICATION_JOURNAL_KEY)) === null,
        'An existing publication journal cannot be initialized again.'
      )
      await persist(
        { etag: null },
        { schemaVersion: 1, channel: 'linux-beta', generation: 0, active: null, history: [] }
      )
    },
    async claim(input) {
      const identity = structuredClone(input)
      assertIdentity(identity)
      const before = await read()
      requireState(
        before.value.active === null,
        'An unresolved publication generation remains locked.'
      )
      requireState(
        before.value.history.length < 1024,
        'Archive journal history before another release.'
      )
      const generation = before.value.generation + 1
      const active = { generation, identity, status: 'claimed', intents: [], receipts: [] }
      await persist(before, { ...before.value, generation, active })
      return structuredClone({ generation, identity })
    },
    async intent(input) {
      await mutate(input, ({ active }, entry) => {
        assertPointer(entry, active)
        assertOrder(active, entry)
        requireState(
          !active.intents.some((intent) => slot(intent) === slot(entry)) &&
            !active.receipts.some((receipt) => slot(receipt) === slot(entry)) &&
            active.intents.every((intent) =>
              active.receipts.some((receipt) => slot(receipt) === slot(intent))
            ),
          'A journal intent cannot overwrite or overtake an unresolved pointer.'
        )
        active.status = 'writing'
        active.intents.push(entry)
      })
    },
    async verified(input) {
      await mutate(input, ({ active }, entry) => {
        assertPointer(entry, active, { receipt: true })
        assertOrder(active, entry)
        const { etag, ...intent } = entry
        const planned = active.intents.find((value) => slot(value) === slot(entry))
        requireState(
          !active.receipts.some((receipt) => slot(receipt) === slot(entry)) &&
            (planned
              ? isDeepStrictEqual(planned, intent)
              : entry.previousSha256 === entry.nextSha256),
          'The receipt lacks its exact write intent or unchanged-pointer observation.'
        )
        active.receipts.push(compactReceipt(entry))
      })
    },
    async complete(input) {
      await mutate(input, ({ active }, entry) => {
        requireState(
          ['claimed', 'writing'].includes(active.status) &&
            active.receipts.length === active.identity.origins.length * 2 &&
            isDeepStrictEqual(entry.receipts?.map(compactReceipt), active.receipts),
          'Publication completion requires every exact verified receipt.'
        )
        // Completion does not release the lock: its response can be lost too.
        // Only the protected caller that received the finalizer's result may
        // separately acknowledge it. Unknown generations cannot acknowledge.
        active.status = 'complete-awaiting-ack'
      })
    },
    async unknown(input) {
      await mutate(input, ({ active }) => {
        active.status = 'unknown'
      })
    },
    async abandon(input) {
      await mutate(input, (state) => {
        requireState(
          state.active.status === 'claimed' && state.active.intents.length === 0,
          'A publication with write intents cannot be abandoned.'
        )
        state.active = null
      })
    },
    async acknowledge(input) {
      await mutate(input, (state, entry) => {
        const active = state.active
        requireState(
          active.status === 'complete-awaiting-ack' &&
            isDeepStrictEqual(entry.receipts?.map(compactReceipt), active.receipts),
          'Acknowledgement requires the exact successful finalizer result.'
        )
        state.history.push({
          generation: active.generation,
          identity: active.identity,
          receiptsSha256: digest(canonicalJson(active.receipts))
        })
        state.active = null
      })
    },
    async inspect() {
      return (await read()).value
    },
    async publishedReleaseIds() {
      return [...new Set((await read()).value.history.map((record) => releaseId(record.identity)))]
    }
  }
  return journal
}
