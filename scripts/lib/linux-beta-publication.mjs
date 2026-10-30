import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { linuxCandidateIdentity } from './linux-release-candidate.mjs'
import {
  assertLinuxReleaseManifest,
  parseLinuxReleaseId,
  updateFeedArtifactNameFromYml,
  updateFeedFileMetadataFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml
} from './linux-release.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const feedKey = 'updates/linux-beta/latest-linux.yml'
const manifestKey = 'releases/linux-beta/latest/release.json'
const sameBytes = (left, right) => left !== null && Buffer.from(left).equals(Buffer.from(right))
const requireState = (ok, message) => {
  if (!ok) throw new Error(message)
}

function compareVersion(left, right) {
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

function assertFeedManifest(feed, manifest) {
  assertLinuxReleaseManifest(manifest, { requireAccepted: true })
  requireState(manifest.channel === 'beta' && manifest.stage === 'public', 'Expected public Beta.')
  const text = Buffer.from(feed).toString('utf8')
  const file = updateFeedFileMetadataFromYml(text, manifest.filename)
  requireState(
    updateFeedVersionFromYml(text) === manifest.bundleVersion &&
      updateFeedArtifactNameFromYml(text) === manifest.filename &&
      file?.size === manifest.sizeBytes &&
      /^[A-Za-z0-9+/]{86}==$/.test(file?.sha512 ?? '') &&
      updateFeedSha512FromYml(text) === file.sha512,
    'Published Beta feed and manifest disagree.'
  )
}

export function assertLinuxBetaPointerTransition({ current, next, publishedReleaseIds }) {
  requireState(Array.isArray(publishedReleaseIds), 'Verified publication history is required.')
  const manifest = JSON.parse(next.manifest.toString('utf8'))
  assertFeedManifest(next.feed, manifest)
  for (const id of publishedReleaseIds) {
    const parsed = parseLinuxReleaseId(id)
    requireState(parsed.channel === 'beta', 'Publication history must contain only Linux Beta.')
    requireState(
      compareVersion(manifest.bundleVersion, parsed.bundleVersion) >= 0,
      'Beta promotion would regress below publication history.'
    )
  }
  requireState(
    (current.feed === null) === (current.manifest === null),
    'Incomplete Beta pointers require explicit publication recovery.'
  )
  if (current.feed === null) {
    requireState(publishedReleaseIds.length === 0, 'Published Beta pointers disappeared.')
    return 'first-release'
  }
  const previous = JSON.parse(Buffer.from(current.manifest).toString('utf8'))
  assertFeedManifest(current.feed, previous)
  const comparison = compareVersion(manifest.bundleVersion, previous.bundleVersion)
  requireState(comparison >= 0, 'Beta pointers cannot move backward.')
  requireState(
    comparison !== 0 ||
      (sameBytes(current.feed, next.feed) && sameBytes(current.manifest, next.manifest)),
    'Same-version Beta pointers must retain their exact bytes.'
  )
  return comparison === 0 ? 'idempotent' : 'advance'
}

function assertPlan(plan) {
  const manifest = plan.manifest
  assertLinuxReleaseManifest(manifest, { requireAccepted: true })
  requireState(
    plan.mode === 'read-only' &&
      plan.requiresProtectedFinalizer === true &&
      plan.candidateIdentity ===
        linuxCandidateIdentity({
          releaseId: manifest.releaseId,
          sourceCommit: manifest.sourceCommit,
          appImageSha256: manifest.sha256
        }) &&
      manifest.channel === 'beta' &&
      manifest.stage === 'public',
    'Finalization requires a freshly verified Beta promotion plan.'
  )
  const prefix = `releases/linux-beta/${manifest.releaseId}`
  const names = [
    manifest.filename,
    `${manifest.filename}.sha256`,
    'latest-linux.yml',
    'FFMPEG-LICENSE.txt',
    'FFMPEG-SOURCE.txt',
    'release.json'
  ]
  const expected = new Set([
    ...names.map((name) => `${prefix}/${name}`),
    `updates/linux-beta/${manifest.filename}`
  ])
  requireState(plan.immutable?.length === expected.size, 'Incomplete immutable Beta plan.')
  for (const artifact of plan.immutable) {
    requireState(expected.delete(artifact.objectKey), 'Foreign or duplicate Beta destination.')
    requireState(
      /^[a-f0-9]{64}$/.test(artifact.sha256) &&
        Number.isSafeInteger(artifact.sizeBytes) &&
        artifact.sizeBytes > 0,
      'Invalid immutable Beta identity.'
    )
  }
  requireState(
    plan.pointers?.length === 2 &&
      plan.pointers[0].objectKey === feedKey &&
      plan.pointers[1].objectKey === manifestKey,
    'Beta pointer order or destinations changed.'
  )
  for (const pointer of plan.pointers) {
    requireState(pointer.sizeBytes <= 2 * 1024 * 1024, 'Oversized Beta pointer plan.')
    if (pointer.bodyBase64 !== undefined)
      requireState(
        typeof pointer.bodyBase64 === 'string' && pointer.bodyBase64.length <= 3 * 1024 * 1024,
        'Oversized inline Beta pointer.'
      )
    const immutable = plan.immutable.find(
      (artifact) => artifact.objectKey === `${prefix}/${pointer.objectKey.split('/').at(-1)}`
    )
    requireState(
      immutable?.sha256 === pointer.sha256 && immutable.sizeBytes === pointer.sizeBytes,
      'Beta pointer identity differs from its immutable release object.'
    )
    requireState(
      pointer.objectKey !== feedKey ||
        pointer.sourceObjectKey ===
          `candidates/linux-beta/${manifest.releaseId}/${manifest.sourceCommit}/latest-linux.yml`,
      'Beta feed source must be the exact verified private candidate.'
    )
  }
  for (const key of [`${prefix}/${manifest.filename}`, `updates/linux-beta/${manifest.filename}`]) {
    const artifact = plan.immutable.find((item) => item.objectKey === key)
    requireState(
      artifact.sha256 === manifest.sha256 && artifact.sizeBytes === manifest.sizeBytes,
      'Beta AppImage descriptors differ from the accepted manifest.'
    )
  }
}

function verifiedBytes(artifact, bytes) {
  const result = Buffer.from(bytes)
  requireState(
    result.length === artifact.sizeBytes && sha256(result) === artifact.sha256,
    'Beta pointer source bytes differ from the verified plan.'
  )
  return result
}

function snapshot(value) {
  if (value === null) return { body: null, etag: null }
  requireState(
    Buffer.isBuffer(value?.body) &&
      value.body.length <= 2 * 1024 * 1024 &&
      typeof value.etag === 'string' &&
      /^"[\x21\x23-\x7e]+"$/.test(value.etag),
    'A bounded pointer body and strong ETag are required.'
  )
  return { body: Buffer.from(value.body), etag: value.etag }
}

// Transaction core only. The protected coordinator must freshly verify source,
// workflow provenance, payload and acceptance before calling this with its plan.
// It must provide a durable single-writer journal and a storage adapter whose
// reads hash actual immutable bytes and whose PUT enforces the given condition.
// This module has no CLI, credentials, network transport or authority bypass.
export async function finalizeVerifiedLinuxBetaPlan({
  plan: input,
  origins,
  primaryName,
  publishedReleaseIds,
  storage,
  journal
}) {
  const plan = structuredClone(input)
  assertPlan(plan)
  requireState(Array.isArray(publishedReleaseIds), 'Verified publication history is required.')
  origins = [...origins]
  publishedReleaseIds = [...publishedReleaseIds]
  for (const [adapter, methods] of [
    [storage, ['readCandidate', 'inspectImmutable', 'readPointer', 'putPointer']],
    [journal, ['claim', 'intent', 'verified', 'complete', 'unknown', 'abandon']]
  ])
    requireState(
      methods.every((method) => typeof adapter?.[method] === 'function'),
      'Complete storage and durable journal adapters are required.'
    )
  requireState(
    origins.length > 0 &&
      origins.every((origin) => typeof origin === 'string' && origin.length > 0) &&
      new Set(origins).size === origins.length &&
      origins.includes(primaryName),
    'All configured origins and the primary must be present exactly once.'
  )
  const identity = {
    candidateIdentity: plan.candidateIdentity,
    planSha256: sha256(JSON.stringify(plan)),
    origins: [...origins].sort(),
    primaryName
  }
  const claim = await journal.claim(structuredClone(identity))
  requireState(
    Number.isSafeInteger(claim?.generation) &&
      claim.generation > 0 &&
      isDeepStrictEqual(claim.identity, identity),
    'The durable publication claim does not bind this exact plan and origins.'
  )
  const generation = claim.generation
  let intentStarted = false
  try {
    const pointers = []
    for (const artifact of plan.pointers) {
      const bytes = artifact.bodyBase64
        ? Buffer.from(artifact.bodyBase64, 'base64')
        : await storage.readCandidate(artifact.sourceObjectKey, { maxBytes: artifact.sizeBytes })
      pointers.push({ ...artifact, body: verifiedBytes(artifact, bytes) })
    }
    requireState(
      isDeepStrictEqual(JSON.parse(pointers[1].body.toString('utf8')), plan.manifest),
      'The public manifest pointer differs from the verified plan.'
    )
    const next = { feed: pointers[0].body, manifest: pointers[1].body }
    const observed = new Map()
    // Inspect every origin before the first public write, including mirrors.
    for (const origin of origins) {
      for (const artifact of plan.immutable) {
        const actual = await storage.inspectImmutable(origin, artifact.objectKey, {
          maxBytes: artifact.sizeBytes
        })
        requireState(
          actual?.sha256 === artifact.sha256 && actual.sizeBytes === artifact.sizeBytes,
          `Missing or changed immutable Beta bytes on ${origin}.`
        )
      }
      const current = []
      for (const artifact of pointers)
        current.push(snapshot(await storage.readPointer(origin, artifact.objectKey)))
      assertLinuxBetaPointerTransition({
        current: { feed: current[0].body, manifest: current[1].body },
        next,
        publishedReleaseIds
      })
      observed.set(origin, current)
    }
    const receipts = []
    const ordered = [...origins.filter((origin) => origin !== primaryName), primaryName]
    for (const origin of ordered) {
      for (const [index, artifact] of pointers.entries()) {
        const previous = observed.get(origin)[index]
        const intent = {
          ...identity,
          generation,
          origin,
          objectKey: artifact.objectKey,
          previousSha256: previous.body === null ? null : sha256(previous.body),
          previousEtag: previous.etag,
          nextSha256: artifact.sha256,
          nextBodyBase64: artifact.body.toString('base64')
        }
        if (!sameBytes(previous.body, artifact.body)) {
          // A journal write can itself succeed while its response is lost.
          // Preserve this generation on every ambiguous outcome after intent.
          intentStarted = true
          await journal.intent(structuredClone(intent))
          await storage.putPointer(origin, artifact.objectKey, Buffer.from(artifact.body), {
            ifMatch: previous.etag,
            ifNoneMatch: previous.etag === null ? '*' : null
          })
        }
        const verified = snapshot(await storage.readPointer(origin, artifact.objectKey))
        requireState(
          verified.body !== null &&
            verified.body.length === artifact.sizeBytes &&
            sha256(verified.body) === artifact.sha256,
          'Beta pointer readback differs.'
        )
        const receipt = { ...intent, etag: verified.etag }
        await journal.verified(structuredClone(receipt))
        receipts.push(receipt)
      }
    }
    intentStarted = true
    await journal.complete(structuredClone({ ...identity, generation, receipts }))
    return { ...identity, generation, receipts }
  } catch (error) {
    // No automatic PUT retry, unlock, new generation or optimistic completion
    // after an intent. Recovery must inspect both previous and intended bytes.
    if (intentStarted) await journal.unknown({ ...identity, generation })
    else await journal.abandon({ ...identity, generation })
    throw error
  }
}

// Read-only recovery inspection. It neither clears a claim nor repeats a write.
export async function inspectLinuxBetaPointerRecovery({ intent, claim, readPointer }) {
  intent = structuredClone(intent)
  claim = structuredClone(claim)
  requireState(
    [feedKey, manifestKey].includes(intent.objectKey) &&
      Number.isSafeInteger(intent.generation) &&
      intent.generation > 0 &&
      /^[a-f0-9]{64}$/.test(intent.planSha256) &&
      (intent.previousSha256 === null || /^[a-f0-9]{64}$/.test(intent.previousSha256)) &&
      claim?.generation === intent.generation &&
      claim.identity?.candidateIdentity === intent.candidateIdentity &&
      claim.identity?.planSha256 === intent.planSha256 &&
      claim.identity?.origins?.includes(intent.origin) &&
      isDeepStrictEqual(claim.identity.origins, intent.origins) &&
      claim.identity.primaryName === intent.primaryName &&
      typeof intent.nextBodyBase64 === 'string' &&
      intent.nextBodyBase64.length <= 3 * 1024 * 1024,
    'Invalid Beta publication recovery intent.'
  )
  const next = Buffer.from(intent.nextBodyBase64, 'base64')
  requireState(
    next.length <= 2 * 1024 * 1024 && sha256(next) === intent.nextSha256,
    'Recovery intent bytes changed.'
  )
  const current = snapshot(await readPointer(intent.origin, intent.objectKey))
  if (sameBytes(current.body, next)) return { state: 'applied', etag: current.etag }
  if (
    (current.body === null && intent.previousSha256 === null) ||
    (current.body !== null && sha256(current.body) === intent.previousSha256)
  )
    return { state: 'not-applied', etag: current.etag }
  throw new Error(
    'Beta pointer matches neither prior nor intended bytes; keep publication blocked.'
  )
}
