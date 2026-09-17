import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION = 2
export const CAPTURE_DECAY_ATTEMPT_LEDGER_ENTRY_PROFILE = 'capture-decay-attempt-ledger-entry-v2'
export const CAPTURE_DECAY_ATTEMPT_LEDGER_MANIFEST_PROFILE =
  'capture-decay-attempt-ledger-manifest-v2'

const ENTRY_FILENAME = /^entry-(\d{6})\.json$/
const ATTEMPT_KINDS = Object.freeze(['soak', 'recovery'])
const RESULT_STATUSES = Object.freeze(['passed', 'failed', 'interrupted'])
const START_KEYS = Object.freeze([
  'attemptId',
  'attemptKind',
  'candidateCanonicalSha256',
  'ceremonyId',
  'entryType',
  'hostId',
  'previousEntrySha256',
  'profile',
  'recordedAt',
  'schemaVersion',
  'sealedCandidateBindingSha256',
  'sequence'
])
const RESULT_KEYS = Object.freeze([...START_KEYS, 'attestation', 'status'].sort())
const ARTIFACT_KEYS = Object.freeze(['relativePath', 'sha256', 'sizeBytes'])
const MANIFEST_ENTRY_KEYS = Object.freeze([
  'attemptId',
  'entryType',
  'relativePath',
  'sequence',
  'sha256',
  'sizeBytes'
])
const MANIFEST_KEYS = Object.freeze([
  'candidateCanonicalSha256',
  'ceremonyId',
  'entries',
  'entryCount',
  'headEntrySha256',
  'hostId',
  'ledgerDirectory',
  'profile',
  'schemaVersion',
  'sealedCandidateBindingSha256'
])

export class CaptureDecayAttemptLedgerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CaptureDecayAttemptLedgerError'
    this.code = code
  }
}

export function captureDecayAttemptLedgerCanonicalText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function captureDecayAttemptLedgerSha256(value) {
  return sha256Text(captureDecayAttemptLedgerCanonicalText(value))
}

/**
 * Append a start entry. If the previous process died with an unmatched start,
 * its immutable interrupted result is appended before the new start.
 */
export async function startCaptureDecayAttempt({
  attemptId = randomUUID(),
  attemptKind,
  candidateCanonicalSha256,
  ceremonyId,
  hostId,
  ledgerDirectory,
  sealedCandidateBindingSha256,
  startedAt = new Date().toISOString()
}) {
  const identity = normalizeIdentity({
    candidateCanonicalSha256,
    ceremonyId,
    hostId,
    sealedCandidateBindingSha256
  })
  const normalizedAttemptId = requiredId(attemptId, 'attempt id')
  const normalizedKind = requiredAttemptKind(attemptKind)
  const normalizedStartedAt = requiredTimestamp(startedAt, 'attempt start time')
  const directory = resolve(requiredText(ledgerDirectory, 'attempt ledger directory'))
  await mkdir(directory, { recursive: true })
  let ledger = await loadLedgerDirectory({
    allowOpen: true,
    expectedIdentity: identity,
    ledgerDirectory: directory
  })

  if (
    ledger.attempts.some((attempt) => attempt.attemptId === normalizedAttemptId) ||
    ledger.openAttempt?.attemptId === normalizedAttemptId
  ) {
    throw ledgerError(
      'duplicate-attempt',
      `Capture-decay attempt id ${normalizedAttemptId} is already present in the ledger.`
    )
  }
  assertTimestampNotBefore(normalizedStartedAt, ledger.lastRecordedAt, 'attempt start time')

  let previousEntrySha256 = ledger.headEntrySha256
  let sequence = ledger.entries.length + 1
  let autoInterruptedAttemptId = null
  if (ledger.openAttempt) {
    autoInterruptedAttemptId = ledger.openAttempt.attemptId
    const interruption = resultEntry({
      ...identity,
      attestation: null,
      attemptId: ledger.openAttempt.attemptId,
      attemptKind: ledger.openAttempt.attemptKind,
      previousEntrySha256,
      recordedAt: normalizedStartedAt,
      sequence,
      status: 'interrupted'
    })
    const written = await appendEntry(directory, interruption)
    previousEntrySha256 = written.sha256
    sequence += 1
  }

  const entry = startEntry({
    ...identity,
    attemptId: normalizedAttemptId,
    attemptKind: normalizedKind,
    previousEntrySha256,
    recordedAt: normalizedStartedAt,
    sequence
  })
  await appendEntry(directory, entry)
  ledger = await loadLedgerDirectory({
    allowOpen: true,
    expectedIdentity: identity,
    ledgerDirectory: directory
  })
  return {
    attemptId: normalizedAttemptId,
    autoInterruptedAttemptId,
    entry,
    ledger
  }
}

/** Append the one result allowed for the currently open attempt. */
export async function finishCaptureDecayAttempt({
  attestation = null,
  attemptId,
  bundleRoot,
  candidateCanonicalSha256,
  ceremonyId,
  finishedAt = new Date().toISOString(),
  hostId,
  ledgerDirectory,
  sealedCandidateBindingSha256,
  status
}) {
  const identity = normalizeIdentity({
    candidateCanonicalSha256,
    ceremonyId,
    hostId,
    sealedCandidateBindingSha256
  })
  const normalizedAttemptId = requiredId(attemptId, 'attempt id')
  const normalizedStatus = requiredResultStatus(status)
  const normalizedFinishedAt = requiredTimestamp(finishedAt, 'attempt finish time')
  const directory = resolve(requiredText(ledgerDirectory, 'attempt ledger directory'))
  const evidenceRoot = resolve(bundleRoot ?? dirname(directory))
  const ledger = await loadLedgerDirectory({
    allowOpen: true,
    bundleRoot: evidenceRoot,
    expectedIdentity: identity,
    ledgerDirectory: directory,
    verifyAttestations: true
  })
  if (!ledger.openAttempt) {
    throw ledgerError('no-open-attempt', 'Capture-decay attempt ledger has no open attempt.')
  }
  if (ledger.openAttempt.attemptId !== normalizedAttemptId) {
    throw ledgerError(
      'attempt-result-mismatch',
      `Result for ${normalizedAttemptId} cannot close open attempt ${ledger.openAttempt.attemptId}.`
    )
  }
  assertTimestampNotBefore(
    normalizedFinishedAt,
    ledger.openAttempt.startedAt,
    'attempt finish time'
  )
  const normalizedAttestation = normalizeResultAttestation(attestation, normalizedStatus)
  if (normalizedAttestation) {
    if (
      ledger.attestationSha256s.has(normalizedAttestation.sha256) ||
      ledger.attestationPaths.has(normalizedAttestation.relativePath)
    ) {
      throw ledgerError(
        'attestation-reuse',
        'A passed capture-decay attestation cannot be reused by another attempt result.'
      )
    }
    const artifact = await loadContainedArtifact({
      descriptor: normalizedAttestation,
      label: 'passed attempt attestation',
      root: evidenceRoot,
      verifyCanonicalJson: true
    })
    assertAttestationAttemptBinding(artifact.document, ledger.openAttempt, identity)
  }

  const entry = resultEntry({
    ...identity,
    attestation: normalizedAttestation,
    attemptId: normalizedAttemptId,
    attemptKind: ledger.openAttempt.attemptKind,
    previousEntrySha256: ledger.headEntrySha256,
    recordedAt: normalizedFinishedAt,
    sequence: ledger.entries.length + 1,
    status: normalizedStatus
  })
  await appendEntry(directory, entry)
  return {
    entry,
    ledger: await loadLedgerDirectory({
      allowOpen: false,
      bundleRoot: evidenceRoot,
      expectedIdentity: identity,
      ledgerDirectory: directory,
      verifyAttestations: true
    })
  }
}

/**
 * Build the canonical descriptor manifest by scanning the immutable directory.
 * The manifest itself can be embedded in the release evidence manifest.
 */
export async function buildCaptureDecayAttemptLedgerManifest({ bundleRoot, ledgerDirectory }) {
  const root = resolve(requiredText(bundleRoot, 'attempt ledger bundle root'))
  const directory = resolve(requiredText(ledgerDirectory, 'attempt ledger directory'))
  const ledgerDirectoryRelativePath = await containedDirectoryRelativePath(root, directory)
  const ledger = await loadLedgerDirectory({
    allowOpen: false,
    bundleRoot: root,
    ledgerDirectory: directory,
    verifyAttestations: true
  })
  if (ledger.entries.length === 0) {
    throw ledgerError('empty-ledger', 'Capture-decay attempt ledger cannot be empty.')
  }
  return {
    schemaVersion: CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_ATTEMPT_LEDGER_MANIFEST_PROFILE,
    ceremonyId: ledger.identity.ceremonyId,
    candidateCanonicalSha256: ledger.identity.candidateCanonicalSha256,
    hostId: ledger.identity.hostId,
    sealedCandidateBindingSha256: ledger.identity.sealedCandidateBindingSha256,
    ledgerDirectory: ledgerDirectoryRelativePath,
    entryCount: ledger.entries.length,
    headEntrySha256: ledger.headEntrySha256,
    entries: ledger.entryArtifacts.map((artifact) => ({
      sequence: artifact.entry.sequence,
      entryType: artifact.entry.entryType,
      attemptId: artifact.entry.attemptId,
      relativePath: containedLexicalRelativePath(root, artifact.path, 'ledger entry'),
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes
    }))
  }
}

export async function loadCaptureDecayAttemptLedgerManifest({
  expectedCandidateCanonicalSha256,
  expectedCeremonyId,
  expectedHostId,
  expectedSealedCandidateBindingSha256,
  manifestPath
}) {
  const absolutePath = resolve(requiredText(manifestPath, 'attempt ledger manifest path'))
  const text = await readFile(absolutePath, 'utf8')
  const parsed = parseJson(text, 'attempt ledger manifest')
  const normalized = normalizeManifest(parsed)
  if (text !== captureDecayAttemptLedgerCanonicalText(normalized)) {
    throw ledgerError(
      'manifest-noncanonical',
      'Capture-decay attempt ledger manifest must use canonical JSON.'
    )
  }
  return loadAndValidateCaptureDecayAttemptLedger({
    expectedCandidateCanonicalSha256,
    expectedCeremonyId,
    expectedHostId,
    expectedSealedCandidateBindingSha256,
    manifest: normalized,
    manifestDirectory: dirname(absolutePath)
  })
}

/** Verify manifest descriptors, exact directory membership, bytes, and chain. */
export async function loadAndValidateCaptureDecayAttemptLedger({
  expectedCandidateCanonicalSha256,
  expectedCeremonyId,
  expectedHostId,
  expectedSealedCandidateBindingSha256,
  manifest,
  manifestDirectory
}) {
  const normalizedManifest = normalizeManifest(manifest)
  const root = resolve(requiredText(manifestDirectory, 'attempt ledger manifest directory'))
  const ledgerDirectory = await resolveContainedDirectory(
    root,
    normalizedManifest.ledgerDirectory,
    'attempt ledger directory'
  )
  const expectedIdentity = normalizeOptionalExpectedIdentity({
    candidateCanonicalSha256: expectedCandidateCanonicalSha256,
    ceremonyId: expectedCeremonyId,
    hostId: expectedHostId,
    sealedCandidateBindingSha256: expectedSealedCandidateBindingSha256
  })
  const ledger = await loadLedgerDirectory({
    allowOpen: false,
    bundleRoot: root,
    expectedIdentity: {
      candidateCanonicalSha256:
        expectedIdentity.candidateCanonicalSha256 ?? normalizedManifest.candidateCanonicalSha256,
      ceremonyId: expectedIdentity.ceremonyId ?? normalizedManifest.ceremonyId,
      hostId: expectedIdentity.hostId ?? normalizedManifest.hostId,
      sealedCandidateBindingSha256:
        expectedIdentity.sealedCandidateBindingSha256 ??
        normalizedManifest.sealedCandidateBindingSha256
    },
    ledgerDirectory,
    verifyAttestations: true
  })

  assertIdentityEqual(ledger.identity, {
    candidateCanonicalSha256: normalizedManifest.candidateCanonicalSha256,
    ceremonyId: normalizedManifest.ceremonyId,
    hostId: normalizedManifest.hostId,
    sealedCandidateBindingSha256: normalizedManifest.sealedCandidateBindingSha256
  })
  if (normalizedManifest.entries.length !== ledger.entryArtifacts.length) {
    throw ledgerError(
      'manifest-entry-set',
      'Attempt ledger manifest must describe every immutable entry exactly once.'
    )
  }
  for (let index = 0; index < normalizedManifest.entries.length; index += 1) {
    const descriptor = normalizedManifest.entries[index]
    // Resolve every descriptor before comparing it so traversal is always a
    // first-class validation failure rather than an incidental order mismatch.
    const descriptorPath = await resolveContainedFile(
      root,
      descriptor.relativePath,
      `attempt ledger entry ${index + 1}`
    )
    const artifact = ledger.entryArtifacts[index]
    if (
      descriptor.sequence !== artifact.entry.sequence ||
      descriptor.entryType !== artifact.entry.entryType ||
      descriptor.attemptId !== artifact.entry.attemptId ||
      descriptorPath !== artifact.realPath
    ) {
      throw ledgerError(
        'manifest-entry-order',
        'Attempt ledger manifest entries must preserve the exact on-disk sequence.'
      )
    }
    if (descriptor.sizeBytes !== artifact.sizeBytes) {
      throw ledgerError('entry-size', `Attempt ledger entry ${descriptor.sequence} size changed.`)
    }
    if (descriptor.sha256 !== artifact.sha256) {
      throw ledgerError('entry-sha256', `Attempt ledger entry ${descriptor.sequence} hash changed.`)
    }
  }
  if (
    normalizedManifest.entryCount !== ledger.entries.length ||
    normalizedManifest.headEntrySha256 !== ledger.headEntrySha256
  ) {
    throw ledgerError(
      'manifest-head',
      'Attempt ledger manifest count/head does not match the exact verified chain.'
    )
  }
  return { ...ledger, manifest: normalizedManifest }
}

/**
 * Prove that acceptance selected the latest three consecutive passed soak
 * attempts and a separate passed recovery attempt that happened afterwards.
 */
export function validateCaptureDecayAttemptLedgerSelection({
  ledger,
  selectedRecoveryAttestationSha256,
  selectedSoakAttestationSha256s
}) {
  if (ledger?.openAttempt) {
    throw ledgerError('open-attempt', 'An open attempt cannot qualify D3 acceptance evidence.')
  }
  if (!Array.isArray(ledger?.attempts)) {
    throw ledgerError('invalid-ledger', 'A verified capture-decay attempt ledger is required.')
  }
  if (
    !Array.isArray(selectedSoakAttestationSha256s) ||
    selectedSoakAttestationSha256s.length !== 3
  ) {
    throw ledgerError('soak-selection-count', 'D3 selection must name exactly three soak passes.')
  }
  const selectedSoaks = selectedSoakAttestationSha256s.map((sha256, index) =>
    requiredSha256(sha256, `selected soak ${index + 1} attestation SHA-256`)
  )
  if (new Set(selectedSoaks).size !== selectedSoaks.length) {
    throw ledgerError('soak-selection-duplicate', 'Selected soak attestations must be distinct.')
  }
  const selectedRecovery = requiredSha256(
    selectedRecoveryAttestationSha256,
    'selected recovery attestation SHA-256'
  )

  let trailingSoakPasses = []
  for (const attempt of ledger.attempts.filter((entry) => entry.attemptKind === 'soak')) {
    if (attempt.status === 'passed') trailingSoakPasses.push(attempt)
    else trailingSoakPasses = []
  }
  const expectedSoaks = trailingSoakPasses.slice(-3)
  if (
    expectedSoaks.length !== 3 ||
    expectedSoaks.some((attempt, index) => attempt.attestation?.sha256 !== selectedSoaks[index])
  ) {
    throw ledgerError(
      'soak-selection-not-latest-streak',
      'Selected soaks are not the latest three consecutive successful soak attempts.'
    )
  }
  const recoveryAttempt = ledger.attempts.find(
    (attempt) =>
      attempt.attemptKind === 'recovery' &&
      attempt.status === 'passed' &&
      attempt.attestation?.sha256 === selectedRecovery
  )
  if (!recoveryAttempt) {
    throw ledgerError(
      'recovery-selection',
      'Selected recovery attestation is not a passed recovery attempt in this ledger.'
    )
  }
  if (recoveryAttempt !== ledger.attempts.at(-1)) {
    throw ledgerError(
      'recovery-not-final-attempt',
      'Selected recovery must be the final completed attempt in the D3 ceremony ledger.'
    )
  }
  if (
    selectedSoaks.includes(selectedRecovery) ||
    recoveryAttempt.startSequence <= expectedSoaks[2].resultSequence
  ) {
    throw ledgerError(
      'recovery-before-soaks',
      'Selected recovery must be a distinct passed attempt after the third selected soak.'
    )
  }
  return {
    soakAttemptIds: expectedSoaks.map((attempt) => attempt.attemptId),
    recoveryAttemptId: recoveryAttempt.attemptId
  }
}

function startEntry({
  attemptId,
  attemptKind,
  candidateCanonicalSha256,
  ceremonyId,
  hostId,
  previousEntrySha256,
  recordedAt,
  sealedCandidateBindingSha256,
  sequence
}) {
  return {
    schemaVersion: CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_ATTEMPT_LEDGER_ENTRY_PROFILE,
    sequence,
    previousEntrySha256,
    ceremonyId,
    candidateCanonicalSha256,
    hostId,
    sealedCandidateBindingSha256,
    entryType: 'start',
    attemptId,
    attemptKind,
    recordedAt
  }
}

function resultEntry({
  attestation,
  attemptId,
  attemptKind,
  candidateCanonicalSha256,
  ceremonyId,
  hostId,
  previousEntrySha256,
  recordedAt,
  sealedCandidateBindingSha256,
  sequence,
  status
}) {
  return {
    schemaVersion: CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_ATTEMPT_LEDGER_ENTRY_PROFILE,
    sequence,
    previousEntrySha256,
    ceremonyId,
    candidateCanonicalSha256,
    hostId,
    sealedCandidateBindingSha256,
    entryType: 'result',
    attemptId,
    attemptKind,
    recordedAt,
    status,
    attestation
  }
}

async function appendEntry(ledgerDirectory, entry) {
  const normalized = normalizeEntry(entry)
  const path = resolve(ledgerDirectory, entryFilename(normalized.sequence))
  const text = captureDecayAttemptLedgerCanonicalText(normalized)
  const handle = await open(path, 'wx', 0o400).catch((cause) => {
    if (cause?.code === 'EEXIST') {
      throw ledgerError(
        'concurrent-ledger-write',
        `Attempt ledger sequence ${normalized.sequence} was already claimed.`
      )
    }
    throw cause
  })
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // The D3 ceremony runs on macOS, where syncing the containing directory
  // makes the new append durable before the caller starts the child process.
  // Windows does not support opening directories through this Node API.
  if (process.platform !== 'win32') {
    const directoryHandle = await open(ledgerDirectory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  }
  return { path, sha256: sha256Text(text), sizeBytes: Buffer.byteLength(text) }
}

async function loadLedgerDirectory({
  allowOpen,
  bundleRoot,
  expectedIdentity,
  ledgerDirectory,
  verifyAttestations = false
}) {
  const directory = resolve(ledgerDirectory)
  const directoryEntries = await readdir(directory, { withFileTypes: true })
  const entryNames = []
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.name.startsWith('entry-')) continue
    if (!ENTRY_FILENAME.test(directoryEntry.name) || !directoryEntry.isFile()) {
      throw ledgerError(
        'entry-filename',
        `Invalid immutable attempt ledger entry: ${directoryEntry.name}.`
      )
    }
    entryNames.push(directoryEntry.name)
  }
  entryNames.sort()

  const entries = []
  const entryArtifacts = []
  let previousSha256 = null
  let identity = null
  for (const [index, name] of entryNames.entries()) {
    const expectedSequence = index + 1
    if (name !== entryFilename(expectedSequence)) {
      throw ledgerError(
        'entry-sequence-gap',
        'Attempt ledger entries must be a complete sequence starting at one.'
      )
    }
    const path = resolve(directory, name)
    const artifact = await readCanonicalEntry(path)
    const entry = artifact.entry
    if (entry.sequence !== expectedSequence) {
      throw ledgerError('entry-sequence', `Attempt ledger entry ${name} has the wrong sequence.`)
    }
    if (entry.previousEntrySha256 !== previousSha256) {
      throw ledgerError(
        'entry-chain',
        `Attempt ledger entry ${entry.sequence} does not hash-chain to its predecessor.`
      )
    }
    const entryIdentity = identityFromEntry(entry)
    if (identity === null) identity = entryIdentity
    else assertIdentityEqual(identity, entryIdentity)
    entries.push(entry)
    entryArtifacts.push({ ...artifact, path })
    previousSha256 = artifact.sha256
  }

  if (identity === null && expectedIdentity) identity = normalizeIdentity(expectedIdentity)
  if (identity !== null && expectedIdentity) {
    assertIdentityEqual(identity, normalizeIdentity(expectedIdentity))
  }
  const lifecycle = validateEntryLifecycle(entries, entryArtifacts)
  if (lifecycle.openAttempt && !allowOpen) {
    throw ledgerError(
      'open-attempt',
      `Capture-decay attempt ${lifecycle.openAttempt.attemptId} has no immutable result.`
    )
  }
  if (verifyAttestations) {
    if (!bundleRoot) {
      throw ledgerError('missing-bundle-root', 'Attestation verification requires a bundle root.')
    }
    for (const attempt of lifecycle.attempts) {
      if (attempt.attestation) {
        const artifact = await loadContainedArtifact({
          descriptor: attempt.attestation,
          label: `attempt ${attempt.attemptId} attestation`,
          root: bundleRoot,
          verifyCanonicalJson: true
        })
        assertAttestationAttemptBinding(artifact.document, attempt, identity)
      }
    }
  }
  return {
    ...lifecycle,
    entries,
    entryArtifacts,
    headEntrySha256: previousSha256,
    identity,
    lastRecordedAt: entries.at(-1)?.recordedAt ?? null
  }
}

async function readCanonicalEntry(path) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw ledgerError('entry-type', `Attempt ledger entry must be a regular file: ${path}.`)
  }
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text) !== metadata.size) {
    throw ledgerError('entry-size-race', `Attempt ledger entry changed while reading: ${path}.`)
  }
  const parsed = parseJson(text, `attempt ledger entry ${basename(path)}`)
  const entry = normalizeEntry(parsed)
  if (text !== captureDecayAttemptLedgerCanonicalText(entry)) {
    throw ledgerError(
      'entry-noncanonical',
      `Attempt ledger entry ${basename(path)} must use canonical JSON.`
    )
  }
  return {
    entry,
    realPath: await realpath(path),
    sha256: sha256Text(text),
    sizeBytes: metadata.size
  }
}

function validateEntryLifecycle(entries, entryArtifacts) {
  const attempts = []
  const attemptIds = new Set()
  const attestationPaths = new Set()
  const attestationSha256s = new Set()
  let openAttempt = null
  let previousRecordedAt = null
  for (const [index, entry] of entries.entries()) {
    assertTimestampNotBefore(entry.recordedAt, previousRecordedAt, 'ledger entry time')
    previousRecordedAt = entry.recordedAt
    if (entry.entryType === 'start') {
      if (openAttempt) {
        throw ledgerError(
          'nested-attempt',
          `Attempt ${entry.attemptId} started before ${openAttempt.attemptId} had a result.`
        )
      }
      if (attemptIds.has(entry.attemptId)) {
        throw ledgerError('duplicate-attempt', `Attempt id ${entry.attemptId} is reused.`)
      }
      attemptIds.add(entry.attemptId)
      openAttempt = {
        attemptId: entry.attemptId,
        attemptKind: entry.attemptKind,
        startEntrySha256: entryArtifacts[index].sha256,
        startedAt: entry.recordedAt,
        startSequence: entry.sequence
      }
      continue
    }
    if (
      !openAttempt ||
      openAttempt.attemptId !== entry.attemptId ||
      openAttempt.attemptKind !== entry.attemptKind
    ) {
      throw ledgerError(
        'orphan-result',
        `Attempt result ${entry.attemptId} does not close the immediately preceding start.`
      )
    }
    if (entry.attestation) {
      if (
        attestationSha256s.has(entry.attestation.sha256) ||
        attestationPaths.has(entry.attestation.relativePath)
      ) {
        throw ledgerError(
          'attestation-reuse',
          'A passed capture-decay attestation is bound to more than one result.'
        )
      }
      attestationSha256s.add(entry.attestation.sha256)
      attestationPaths.add(entry.attestation.relativePath)
    }
    attempts.push({
      ...openAttempt,
      attestation: entry.attestation,
      finishedAt: entry.recordedAt,
      resultEntrySha256: entryArtifacts[index].sha256,
      resultSequence: entry.sequence,
      status: entry.status
    })
    openAttempt = null
  }
  return { attempts, attestationPaths, attestationSha256s, openAttempt }
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw ledgerError('invalid-entry', 'Attempt ledger entry must be an object.')
  }
  if (entry.schemaVersion !== CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION) {
    throw ledgerError('entry-schema', 'Attempt ledger entry schema version is unsupported.')
  }
  if (entry.profile !== CAPTURE_DECAY_ATTEMPT_LEDGER_ENTRY_PROFILE) {
    throw ledgerError('entry-profile', 'Attempt ledger entry profile is unsupported.')
  }
  const sequence = positiveInteger(entry.sequence, 'entry sequence')
  const previousEntrySha256 =
    entry.previousEntrySha256 === null
      ? null
      : requiredSha256(entry.previousEntrySha256, 'previous entry SHA-256')
  const identity = normalizeIdentity(entry)
  const attemptId = requiredId(entry.attemptId, 'attempt id')
  const attemptKind = requiredAttemptKind(entry.attemptKind)
  const recordedAt = requiredTimestamp(entry.recordedAt, 'entry time')
  if (entry.entryType === 'start') {
    assertExactKeys(entry, START_KEYS, 'entry-shape', 'start entry')
    return startEntry({
      ...identity,
      attemptId,
      attemptKind,
      previousEntrySha256,
      recordedAt,
      sequence
    })
  }
  if (entry.entryType === 'result') {
    assertExactKeys(entry, RESULT_KEYS, 'entry-shape', 'result entry')
    const status = requiredResultStatus(entry.status)
    return resultEntry({
      ...identity,
      attestation: normalizeResultAttestation(entry.attestation, status),
      attemptId,
      attemptKind,
      previousEntrySha256,
      recordedAt,
      sequence,
      status
    })
  }
  throw ledgerError('entry-type', 'Attempt ledger entry type must be start or result.')
}

function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw ledgerError('invalid-manifest', 'Attempt ledger manifest must be an object.')
  }
  assertExactKeys(manifest, MANIFEST_KEYS, 'manifest-shape', 'attempt ledger manifest')
  if (manifest.schemaVersion !== CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION) {
    throw ledgerError('manifest-schema', 'Attempt ledger manifest schema version is unsupported.')
  }
  if (manifest.profile !== CAPTURE_DECAY_ATTEMPT_LEDGER_MANIFEST_PROFILE) {
    throw ledgerError('manifest-profile', 'Attempt ledger manifest profile is unsupported.')
  }
  const identity = normalizeIdentity(manifest)
  const ledgerDirectory = requiredRelativePath(manifest.ledgerDirectory, 'ledger directory')
  const entryCount = positiveInteger(manifest.entryCount, 'manifest entry count')
  const headEntrySha256 = requiredSha256(manifest.headEntrySha256, 'manifest head SHA-256')
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== entryCount) {
    throw ledgerError(
      'manifest-entry-count',
      'Attempt ledger manifest entry count does not match its descriptor array.'
    )
  }
  const entries = manifest.entries.map((descriptor, index) => {
    assertExactKeys(
      descriptor,
      MANIFEST_ENTRY_KEYS,
      'manifest-entry-shape',
      `manifest entry ${index + 1}`
    )
    const entryType = descriptor.entryType
    if (!['start', 'result'].includes(entryType)) {
      throw ledgerError('manifest-entry-type', 'Manifest entry type must be start or result.')
    }
    return {
      sequence: positiveInteger(descriptor.sequence, 'manifest entry sequence'),
      entryType,
      attemptId: requiredId(descriptor.attemptId, 'manifest attempt id'),
      relativePath: requiredRelativePath(descriptor.relativePath, 'manifest entry path'),
      sha256: requiredSha256(descriptor.sha256, 'manifest entry SHA-256'),
      sizeBytes: positiveInteger(descriptor.sizeBytes, 'manifest entry size')
    }
  })
  return {
    schemaVersion: CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_ATTEMPT_LEDGER_MANIFEST_PROFILE,
    ceremonyId: identity.ceremonyId,
    candidateCanonicalSha256: identity.candidateCanonicalSha256,
    hostId: identity.hostId,
    sealedCandidateBindingSha256: identity.sealedCandidateBindingSha256,
    ledgerDirectory,
    entryCount,
    headEntrySha256,
    entries
  }
}

function normalizeResultAttestation(attestation, status) {
  if (status !== 'passed') {
    if (attestation !== null && attestation !== undefined) {
      throw ledgerError(
        'unexpected-attestation',
        'Failed or interrupted attempt results cannot bind pass evidence.'
      )
    }
    return null
  }
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw ledgerError('missing-attestation', 'Passed attempt result requires an attestation.')
  }
  assertExactKeys(attestation, ARTIFACT_KEYS, 'attestation-shape', 'attestation descriptor')
  return {
    relativePath: requiredRelativePath(attestation.relativePath, 'attestation path'),
    sha256: requiredSha256(attestation.sha256, 'attestation SHA-256'),
    sizeBytes: positiveInteger(attestation.sizeBytes, 'attestation size')
  }
}

async function loadContainedArtifact({ descriptor, label, root, verifyCanonicalJson }) {
  const path = await resolveContainedFile(root, descriptor.relativePath, label)
  const metadata = await stat(path)
  const text = await readFile(path, 'utf8')
  if (metadata.size !== descriptor.sizeBytes || Buffer.byteLength(text) !== descriptor.sizeBytes) {
    throw ledgerError('attestation-size', `${label} size does not match its descriptor.`)
  }
  if (sha256Text(text) !== descriptor.sha256) {
    throw ledgerError('attestation-sha256', `${label} SHA-256 does not match its descriptor.`)
  }
  let document = null
  if (verifyCanonicalJson) {
    document = parseJson(text, label)
    if (text !== captureDecayAttemptLedgerCanonicalText(document)) {
      throw ledgerError('attestation-noncanonical', `${label} must use canonical JSON.`)
    }
  }
  return { document, path, text }
}

function assertAttestationAttemptBinding(document, attempt, identity) {
  const binding = document?.attemptLedger
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw ledgerError(
      'attestation-attempt-binding',
      `Passed attestation for ${attempt.attemptId} is missing its ledger start binding.`
    )
  }
  assertExactKeys(
    binding,
    ['attemptId', 'ceremonyId', 'startEntrySha256'],
    'attestation-attempt-binding',
    'attestation attempt-ledger binding'
  )
  if (
    binding.attemptId !== attempt.attemptId ||
    binding.ceremonyId !== identity.ceremonyId ||
    binding.startEntrySha256 !== attempt.startEntrySha256 ||
    document.sealedCandidateBindingSha256 !== identity.sealedCandidateBindingSha256
  ) {
    throw ledgerError(
      'attestation-attempt-binding',
      `Passed attestation for ${attempt.attemptId} does not bind its exact ledger start entry and sealed candidate.`
    )
  }
}

async function resolveContainedDirectory(root, relativePath, label) {
  const normalized = requiredRelativePath(relativePath, `${label} path`)
  const rootPath = resolve(root)
  const path = resolve(rootPath, normalized)
  assertLexicallyContained(rootPath, path, label)
  const [rootRealPath, pathRealPath] = await Promise.all([realpath(rootPath), realpath(path)])
  assertLexicallyContained(rootRealPath, pathRealPath, label)
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw ledgerError('directory-type', `${label} must be a real directory.`)
  }
  return path
}

async function resolveContainedFile(root, relativePath, label) {
  const normalized = requiredRelativePath(relativePath, `${label} path`)
  const rootPath = resolve(root)
  const path = resolve(rootPath, normalized)
  assertLexicallyContained(rootPath, path, label)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw ledgerError('artifact-type', `${label} must be a regular file.`)
  }
  const [rootRealPath, pathRealPath] = await Promise.all([realpath(rootPath), realpath(path)])
  assertLexicallyContained(rootRealPath, pathRealPath, label)
  return pathRealPath
}

async function containedDirectoryRelativePath(root, directory) {
  const rootPath = resolve(root)
  const directoryPath = resolve(directory)
  assertLexicallyContained(rootPath, directoryPath, 'attempt ledger directory')
  const relativePath = relative(rootPath, directoryPath)
  requiredRelativePath(relativePath, 'attempt ledger directory')
  const resolvedPath = await resolveContainedDirectory(
    rootPath,
    relativePath,
    'attempt ledger directory'
  )
  if (resolvedPath !== directoryPath) {
    throw ledgerError('directory-alias', 'Attempt ledger directory must use its canonical path.')
  }
  return relativePath.split(sep).join('/')
}

function containedLexicalRelativePath(root, path, label) {
  const rootPath = resolve(root)
  const absolutePath = resolve(path)
  assertLexicallyContained(rootPath, absolutePath, label)
  return requiredRelativePath(
    relative(rootPath, absolutePath).split(sep).join('/'),
    `${label} path`
  )
}

function assertLexicallyContained(root, path, label) {
  const traversal = relative(resolve(root), resolve(path))
  if (traversal === '..' || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) {
    throw ledgerError('path-traversal', `${label} escapes the capture-decay evidence bundle.`)
  }
}

function normalizeIdentity({
  candidateCanonicalSha256,
  ceremonyId,
  hostId,
  sealedCandidateBindingSha256
}) {
  return {
    ceremonyId: requiredId(ceremonyId, 'ceremony id'),
    candidateCanonicalSha256: requiredSha256(
      candidateCanonicalSha256,
      'candidate canonical SHA-256'
    ),
    hostId: requiredSha256(hostId, 'host id'),
    sealedCandidateBindingSha256: requiredSha256(
      sealedCandidateBindingSha256,
      'sealed candidate binding SHA-256'
    )
  }
}

function normalizeOptionalExpectedIdentity({
  candidateCanonicalSha256,
  ceremonyId,
  hostId,
  sealedCandidateBindingSha256
}) {
  return {
    ceremonyId: ceremonyId === undefined ? null : requiredId(ceremonyId, 'ceremony id'),
    candidateCanonicalSha256:
      candidateCanonicalSha256 === undefined
        ? null
        : requiredSha256(candidateCanonicalSha256, 'candidate canonical SHA-256'),
    hostId: hostId === undefined ? null : requiredSha256(hostId, 'host id'),
    sealedCandidateBindingSha256:
      sealedCandidateBindingSha256 === undefined
        ? null
        : requiredSha256(sealedCandidateBindingSha256, 'sealed candidate binding SHA-256')
  }
}

function identityFromEntry(entry) {
  return {
    ceremonyId: entry.ceremonyId,
    candidateCanonicalSha256: entry.candidateCanonicalSha256,
    hostId: entry.hostId,
    sealedCandidateBindingSha256: entry.sealedCandidateBindingSha256
  }
}

function assertIdentityEqual(expected, actual) {
  if (
    expected?.ceremonyId !== actual?.ceremonyId ||
    expected?.candidateCanonicalSha256 !== actual?.candidateCanonicalSha256 ||
    expected?.hostId !== actual?.hostId ||
    expected?.sealedCandidateBindingSha256 !== actual?.sealedCandidateBindingSha256
  ) {
    throw ledgerError(
      'ledger-identity',
      'Ceremony id, candidate canonical SHA-256, sealed candidate binding SHA-256, and host id must be invariant across the ledger.'
    )
  }
}

function requiredRelativePath(value, label) {
  const text = requiredText(value, label)
  if (
    isAbsolute(text) ||
    text.includes('\\') ||
    text.includes('\0') ||
    /^[a-zA-Z]:/.test(text) ||
    text.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw ledgerError('path-traversal', `${label} must be a contained canonical relative path.`)
  }
  return text
}

function requiredId(value, label) {
  const text = requiredText(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw ledgerError(
      'invalid-id',
      `${label} must contain only letters, numbers, dot, underscore, colon, or dash.`
    )
  }
  return text
}

function requiredAttemptKind(value) {
  if (!ATTEMPT_KINDS.includes(value)) {
    throw ledgerError('attempt-kind', 'Capture-decay attempt kind must be soak or recovery.')
  }
  return value
}

function requiredResultStatus(value) {
  if (!RESULT_STATUSES.includes(value)) {
    throw ledgerError(
      'result-status',
      'Capture-decay attempt result must be passed, failed, or interrupted.'
    )
  }
  return value
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw ledgerError('invalid-timestamp', `${label} must be a canonical ISO timestamp.`)
  }
  return text
}

function assertTimestampNotBefore(value, previous, label) {
  if (previous !== null && Date.parse(value) < Date.parse(previous)) {
    throw ledgerError('timestamp-order', `${label} cannot precede the previous ledger event.`)
  }
}

function requiredSha256(value, label) {
  const text = requiredText(value, label)
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw ledgerError('invalid-sha256', `${label} must be 64 lowercase hexadecimal characters.`)
  }
  return text
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw ledgerError('invalid-integer', `${label} must be a positive safe integer.`)
  }
  return value
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw ledgerError('invalid-text', `${label} must be non-empty text without outer whitespace.`)
  }
  return value
}

function assertExactKeys(value, expectedKeys, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ledgerError(code, `${label} must be an object.`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw ledgerError(code, `${label} does not have the canonical field set.`)
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw ledgerError('invalid-json', `${label} is not valid JSON.`)
  }
}

function entryFilename(sequence) {
  if (sequence > 999_999) {
    throw ledgerError('entry-sequence-limit', 'Attempt ledger exceeds its sequence capacity.')
  }
  return `entry-${String(sequence).padStart(6, '0')}.json`
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

function ledgerError(code, message) {
  return new CaptureDecayAttemptLedgerError(code, message)
}
