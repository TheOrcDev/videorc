#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertCaptureDecayD3CandidateCheckout,
  assertCaptureDecayD3PublicationTrackedTreeClean,
  captureDecayD3PublicationSourceState,
  captureDecayGitTree
} from './lib/capture-decay-publication-git.mjs'
import {
  CAPTURE_DECAY_D3_DESTINATION_BINDING_ENV,
  verifyCaptureDecayD3PublicationAttestation
} from './lib/capture-decay-publication-attestation.mjs'
import { verifyCaptureDecayD3PublishedReleaseRoutes } from './lib/capture-decay-published-release.mjs'
import {
  assertCaptureDecayD3PublicationReceipt,
  assertCaptureDecayD3PublicationSourceState,
  buildCaptureDecayD3AcceptanceRecord,
  buildSatisfiedCaptureDecayD3Record,
  captureDecayCandidateIdentityFromFiles,
  captureDecayCanonicalJsonSha256,
  captureDecayD3PublicationSubjectDescriptors,
  loadAndValidateCaptureDecayD3Evidence,
  readCaptureDecayD3AcceptanceRecord,
  validateCaptureDecayD3PublicationReceipt,
  writeCaptureDecayD3AcceptanceRecord
} from './lib/capture-decay-release-acceptance.mjs'
import { readCaptureDecayEvidenceArtifact } from './lib/capture-decay-evidence-artifact.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixedRecordPath = join(repoRoot, 'docs', 'acceptance', 'macos-capture-decay-d3.json')

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.satisfyWith) {
    await satisfyAcceptance(options)
    return
  }
  await acceptEvidence(options)
}

async function acceptEvidence(options) {
  if (!options.evidenceManifest) {
    throw new Error('--evidence-manifest is required')
  }
  const sourceCommit = requiredEnv('VIDEORC_CAPTURE_DECAY_SOURCE_COMMIT')
  await assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit })
  const candidate = await captureDecayCandidateIdentityFromFiles({
    sourceCommit,
    sourceTree: await captureDecayGitTree(repoRoot, sourceCommit),
    candidateExecutablePath: requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_EXECUTABLE'),
    candidateDmgPath: requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_DMG')
  })
  const destinationBindingSha256 = requiredSha256Env(CAPTURE_DECAY_D3_DESTINATION_BINDING_ENV)
  const validation = await loadAndValidateCaptureDecayD3Evidence({
    manifestPath: options.evidenceManifest,
    expectedCandidate: candidate,
    expectedPublicationDestinationBindingSha256: destinationBindingSha256
  })
  const record = buildCaptureDecayD3AcceptanceRecord(validation, {
    destinationBindingSha256
  })
  if (options.writeRecord) {
    assertFixedRecordPath(options.writeRecord)
    await assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit })
    await writeCaptureDecayD3AcceptanceRecord(options.writeRecord, record, {
      expectedCurrentStatus: 'pending',
      expectedHeadCommit: sourceCommit,
      repoRoot
    })
  }
  console.log(
    `capture-decay-d3-evidence: PASS (${record.soaks.length} x 240m; camera+screen recovery; candidate ${record.candidate.sourceCommit})`
  )
  if (!options.writeRecord) {
    console.log('capture-decay-d3-evidence: validated only; pass --write-record to accept it')
  }
}

async function satisfyAcceptance(options) {
  if (
    !options.publicationSubjectDir ||
    !options.publishedReleaseDir ||
    !options.publicationAttestation ||
    !options.writeRecord
  ) {
    throw new Error(
      '--satisfy-with requires --publication-subject-dir, --published-release-dir, --publication-attestation, and --write-record'
    )
  }
  assertFixedRecordPath(options.writeRecord)
  await assertCaptureDecayD3PublicationTrackedTreeClean({ repoRoot })
  const acceptedRecord = await readCaptureDecayD3AcceptanceRecord(fixedRecordPath, {
    repoRoot,
    requireHeadMatch: true
  })
  if (acceptedRecord.status !== 'accepted') {
    throw new Error('only a committed accepted D3 record can transition to satisfied')
  }
  const gitState = await captureDecayD3PublicationSourceState({
    record: acceptedRecord,
    repoRoot
  })
  assertCaptureDecayD3PublicationSourceState(acceptedRecord, gitState)

  const receiptPath = resolve(options.satisfyWith)
  const receiptArtifact = await readCaptureDecayEvidenceArtifact({
    label: 'publication receipt',
    path: receiptPath,
    readBytes: false,
    root: dirname(receiptPath)
  })
  if (receiptArtifact.sizeBytes > 8 * 1024 * 1024) {
    throw new Error('publication receipt exceeds its bounded byte size')
  }
  const receiptBytes = await readExactBytes(receiptArtifact.path, receiptArtifact)
  const publicationReceipt = parseJson(receiptBytes.toString('utf8'), 'publication receipt')
  const publicationReceiptSha256 = receiptArtifact.sha256
  if (captureDecayCanonicalJsonSha256(publicationReceipt) !== publicationReceiptSha256) {
    throw new Error('publication receipt is not canonical immutable validator JSON')
  }
  if (publicationReceipt.publicationSourceCommit !== gitState.headCommit) {
    throw new Error('publication receipt was not emitted by this accepted source commit')
  }
  const normalizedReceipt = assertCaptureDecayD3PublicationReceipt(publicationReceipt, {
    acceptedRecord,
    acceptedRecordSha256: captureDecayCanonicalJsonSha256(acceptedRecord)
  })
  const subjectRoot = resolve(options.publicationSubjectDir)
  const subjectArtifacts = await readExactArtifacts({
    descriptors: captureDecayD3PublicationSubjectDescriptors(normalizedReceipt.sealedCandidate),
    root: subjectRoot,
    readBytes: false
  })
  const publicationAttestation = await verifyCaptureDecayD3PublicationAttestation({
    attestationBundlePath: options.publicationAttestation,
    publicationSourceCommit: normalizedReceipt.publicationSourceCommit,
    receiptPath: options.satisfyWith,
    subjectPaths: subjectArtifacts.map((artifact) => artifact.path)
  })
  const publicRouteVerification = await verifyCaptureDecayD3PublishedReleaseRoutes({
    publicationReceipt: normalizedReceipt
  })

  const publishedRoot = resolve(options.publishedReleaseDir)
  const publishedArtifacts = await readExactArtifacts({
    descriptors: captureDecayD3PublicationSubjectDescriptors(
      normalizedReceipt.sealedCandidate
    ).slice(2),
    root: publishedRoot,
    readBytes: new Set(['manifest'])
  })
  const publicByLabel = new Map(
    normalizedReceipt.release.artifacts.map((artifact) => [artifact.label, artifact])
  )
  const publishedManifestArtifact = publishedArtifacts.find(
    (artifact) => artifact.label === 'manifest'
  )
  const publishedManifest = parseJson(
    publishedManifestArtifact.bytes.toString('utf8'),
    'published manifest'
  )
  const validation = validateCaptureDecayD3PublicationReceipt({
    acceptedRecord,
    acceptedRecordSha256: captureDecayCanonicalJsonSha256(acceptedRecord),
    publicRouteVerification,
    publicationAttestation,
    publicationReceipt: normalizedReceipt,
    publicationReceiptSha256,
    publishedManifest,
    publishedArtifacts: publishedArtifacts.map(({ bytes: _bytes, ...artifact }) => ({
      ...artifact,
      objectKey: publicByLabel.get(artifact.label)?.objectKey
    }))
  })
  const record = buildSatisfiedCaptureDecayD3Record(validation)
  await assertCaptureDecayD3PublicationTrackedTreeClean({ repoRoot })
  const boundaryGitState = await captureDecayD3PublicationSourceState({
    record: acceptedRecord,
    repoRoot
  })
  assertCaptureDecayD3PublicationSourceState(acceptedRecord, boundaryGitState)
  if (boundaryGitState.headCommit !== gitState.headCommit) {
    throw new Error('publication source HEAD changed during D3 satisfaction verification')
  }
  await writeCaptureDecayD3AcceptanceRecord(options.writeRecord, record, {
    expectedCurrentRecordSha256: captureDecayCanonicalJsonSha256(acceptedRecord),
    expectedCurrentStatus: 'accepted',
    expectedHeadCommit: gitState.headCommit,
    repoRoot
  })
  console.log(
    `capture-decay-d3-satisfaction: PASS (${normalizedReceipt.release.releaseId}; later descendant releases use recurring synthetic gates)`
  )
}

function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (
      ![
        '--evidence-manifest',
        '--write-record',
        '--satisfy-with',
        '--publication-subject-dir',
        '--published-release-dir',
        '--publication-attestation'
      ].includes(name)
    ) {
      throw new Error(`unknown argument: ${name}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`)
    options[toCamelCase(name.slice(2))] = value
    index += 1
  }
  return options
}

async function readExactArtifacts({ descriptors, readBytes, root }) {
  const artifacts = []
  for (const descriptor of descriptors) {
    const path = join(root, descriptor.filename)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== descriptor.sizeBytes) {
      throw new Error(`${descriptor.label} does not have its exact accepted byte size`)
    }
    const artifact = await readCaptureDecayEvidenceArtifact({
      label: descriptor.label,
      path,
      readBytes: false,
      root
    })
    if (
      artifact.relativePath !== descriptor.filename ||
      artifact.filename !== descriptor.filename ||
      artifact.sha256 !== descriptor.sha256 ||
      artifact.sizeBytes !== descriptor.sizeBytes
    ) {
      throw new Error(`${descriptor.label} does not match its exact accepted sealed bytes`)
    }
    const includeBytes = readBytes === true || readBytes?.has?.(descriptor.label) === true
    artifacts.push({
      label: descriptor.label,
      ...artifact,
      bytes: includeBytes ? await readExactBytes(artifact.path, descriptor) : null
    })
  }
  return artifacts
}

async function readExactBytes(path, descriptor) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.size !== BigInt(descriptor.sizeBytes) ||
      descriptor.sizeBytes > 8 * 1024 * 1024
    ) {
      throw new Error('bounded publication JSON artifact changed before it could be read')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      bytes.byteLength !== descriptor.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256
    ) {
      throw new Error('bounded publication JSON artifact changed while it was being read')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function assertFixedRecordPath(path) {
  if (resolve(path) !== fixedRecordPath) {
    throw new Error(`--write-record must target ${fixedRecordPath}`)
  }
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredSha256Env(name) {
  const value = requiredEnv(name).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`)
  }
  return value
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

main().catch((error) => {
  console.error(`capture-decay-release-acceptance: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
