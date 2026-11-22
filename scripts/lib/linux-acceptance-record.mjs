// The public Linux acceptance record (plan 257 S20).
//
// Two record kinds live under docs/acceptance/:
//
// - linux-alpha/<x.y.z>-alpha.N.json: the release owner's waiver
//   (`videorc-linux-alpha-owner-waiver`). Every Linux Alpha so far shipped
//   this way. It claims no gate and states that no physical acceptance ran.
// - linux-beta/<x.y.z>-beta.N.json: the PASS record of a physical acceptance
//   pass (`videorc-linux-beta-acceptance`) on at least two named Tier 1 boxes,
//   every gate PASS on each box.
//
// D11 (plan 257, decided 2026-11-21): the Linux Beta gate is physical
// acceptance on both Tier 1 boxes with no owner waiver. A waiver for a Beta
// release is refused, whatever its kind says.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { linuxAlphaAppImageFilename } from './linux-alpha-release.mjs'
import { linuxCandidateIdentity, linuxCandidatePrefix } from './linux-release-candidate.mjs'

export const LINUX_ALPHA_OWNER_WAIVER_KIND = 'videorc-linux-alpha-owner-waiver'
export const LINUX_ALPHA_OWNER_WAIVER_BASES = Object.freeze(['field-use-by-alpha-testers'])
export const LINUX_BETA_ACCEPTANCE_KIND = 'videorc-linux-beta-acceptance'

// The gate keys of plan 257 "Physical acceptance", in checklist order.
export const REQUIRED_LINUX_BETA_ACCEPTANCE_GATES = Object.freeze([
  'cleanInstall',
  'protocolSignIn',
  'portalScreenGrant',
  'restoreToken',
  'screenOnlyRecording',
  'cameraOnlyRecording',
  'screenCameraMicrophoneRecording',
  'desktopAudioRecording',
  'liveSourceChange',
  'vaapiPath',
  'softwareFallbackPath',
  'globalShortcuts',
  'liveCaptions',
  'allFourPlatformsLive',
  'talkShowScreenShare',
  'virtualCamera',
  'betaToBetaUpdate',
  'ownedProcessCleanup',
  'supportBundleRedaction',
  'artifactSignature'
])

// D1 Tier 1 desktops. A box names its desktop with one of these ids and
// nothing else: hostnames, serials and people stay in the private record.
export const LINUX_TIER1_DESKTOPS = Object.freeze([
  'ubuntu-24.04-gnome-wayland',
  'arch-hyprland-wayland',
  'fedora-kde-plasma-6-wayland'
])

// D11: "physical acceptance on both Tier 1 boxes".
export const MIN_LINUX_BETA_ACCEPTANCE_BOXES = 2

// Owner decision 2026-11-22: one of the boxes is always Ubuntu 24.04 GNOME,
// the LTS most Linux users run; the others are different Tier 1 desktops.
export const REQUIRED_LINUX_BETA_DESKTOP = 'ubuntu-24.04-gnome-wayland'

const ALPHA_RELEASE_ID = /^(\d+\.\d+\.\d+)-alpha\.(\d+)$/
const BETA_RELEASE_ID = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/
const ALPHA_RECORD_FILENAME = /^(\d+\.\d+\.\d+-alpha\.\d+)\.json$/
const BETA_RECORD_FILENAME = /^(\d+\.\d+\.\d+-beta\.\d+)\.json$/
const FUTURE_SKEW_MS = 5 * 60 * 1000

export class LinuxAcceptanceRecordError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LinuxAcceptanceRecordError'
    this.code = code
  }
}

export function linuxReleaseTrack(releaseId) {
  if (ALPHA_RELEASE_ID.test(releaseId ?? '')) return 'alpha'
  if (BETA_RELEASE_ID.test(releaseId ?? '')) return 'beta'
  throw new LinuxAcceptanceRecordError(
    'invalid-release-id',
    'Linux releaseId must be <x.y.z>-alpha.N or <x.y.z>-beta.N.'
  )
}

// Same string as linuxCandidateIdentity, which only knows the Alpha track.
export function linuxBetaCandidateIdentity({ releaseId, sourceCommit, appImageSha256 }) {
  if (linuxReleaseTrack(releaseId) !== 'beta') {
    throw new LinuxAcceptanceRecordError(
      'invalid-release-id',
      'A Linux Beta candidate identity needs a <x.y.z>-beta.N releaseId.'
    )
  }
  requireCommit(sourceCommit, 'sourceCommit')
  requireSha256(appImageSha256, 'appImageSha256')
  return `linux:${releaseId}:${sourceCommit}:sha256:${appImageSha256}`
}

export function isLinuxOwnerWaiverShaped(record) {
  return (
    isObject(record) &&
    ((typeof record.kind === 'string' && record.kind.includes('waiver')) ||
      record.status === 'OWNER_WAIVED' ||
      'physicalAcceptance' in record ||
      'decidedBy' in record)
  )
}

/**
 * Validate one Linux acceptance record against the exact candidate.
 *
 * expectations: { releaseId, sourceCommit, appImageSha256, filename,
 *   sizeBytes?, releasedAt?, now?, priorAcceptedReleaseIds (Beta only) }
 */
export function assertLinuxAcceptanceRecord(record, expectations) {
  if (!isObject(record)) {
    throw new LinuxAcceptanceRecordError(
      'invalid-acceptance-record',
      'Linux acceptance record must be a JSON object.'
    )
  }
  const track = linuxReleaseTrack(expectations?.releaseId)
  if (isLinuxOwnerWaiverShaped(record)) {
    if (track === 'beta') {
      throw new LinuxAcceptanceRecordError(
        'beta-waiver-refused',
        'A Linux Beta needs a physical acceptance PASS on two Tier 1 boxes; an owner waiver is refused (plan 257 D11).'
      )
    }
    assertSelfConsistentCandidateIdentity(record)
    return assertLinuxAlphaOwnerWaiver(record, expectations)
  }
  if (track === 'alpha') {
    throw new LinuxAcceptanceRecordError(
      'acceptance-kind-mismatch',
      `A Linux Alpha record must be a ${LINUX_ALPHA_OWNER_WAIVER_KIND}; a physical PASS record is a Beta record.`
    )
  }
  assertSelfConsistentCandidateIdentity(record)
  return assertLinuxBetaAcceptance(record, expectations)
}

// The record must agree with itself before it is compared with the candidate:
// candidateIdentity is exactly linux:<releaseId>:<sourceCommit>:sha256:<artifact.sha256>.
// 0.15.0-alpha.1 and 0.16.0-alpha.1 were once committed with a corrupted
// identity (repaired in #1645); this check keeps that from coming back.
function assertSelfConsistentCandidateIdentity(record) {
  const expected = `linux:${record.releaseId}:${record.sourceCommit}:sha256:${record.artifact?.sha256}`
  if (record.candidateIdentity !== expected) {
    throw new LinuxAcceptanceRecordError(
      'candidate-identity-mismatch',
      'candidateIdentity must equal linux:<releaseId>:<sourceCommit>:sha256:<artifact.sha256>.'
    )
  }
}

function assertLinuxAlphaOwnerWaiver(record, expectations) {
  assertKeys(
    record,
    [
      'schemaVersion',
      'kind',
      'status',
      'releaseId',
      'sourceCommit',
      'candidateIdentity',
      'artifact',
      'decidedAt',
      'decidedBy',
      'basis',
      'physicalAcceptance'
    ],
    ['candidateStoragePrefix'],
    'record'
  )
  requireEqual(record.schemaVersion, 1, 'schemaVersion')
  requireEqual(record.kind, LINUX_ALPHA_OWNER_WAIVER_KIND, 'kind')
  requireEqual(record.status, 'OWNER_WAIVED', 'status')
  requireEqual(record.releaseId, expectations.releaseId, 'releaseId')
  requireEqual(record.sourceCommit, expectations.sourceCommit, 'sourceCommit')
  requireEqual(
    record.candidateIdentity,
    linuxCandidateIdentity({
      appImageSha256: expectations.appImageSha256,
      releaseId: expectations.releaseId,
      sourceCommit: expectations.sourceCommit
    }),
    'candidateIdentity'
  )
  if ('candidateStoragePrefix' in record) {
    requireEqual(
      record.candidateStoragePrefix,
      linuxCandidatePrefix(expectations),
      'candidateStoragePrefix'
    )
  }
  assertArtifact(record.artifact, expectations, { sizeBytesRequired: false })

  const decidedAt = canonicalTimestamp(record.decidedAt, 'decidedAt')
  assertWithinCandidateWindow(decidedAt, expectations, 'decidedAt', 'waiver')
  requireEqual(record.decidedBy, 'release-owner', 'decidedBy')
  if (!LINUX_ALPHA_OWNER_WAIVER_BASES.includes(record.basis)) {
    throw new LinuxAcceptanceRecordError(
      'acceptance-basis-mismatch',
      `Owner waiver basis must be one of: ${LINUX_ALPHA_OWNER_WAIVER_BASES.join(', ')}.`
    )
  }
  // A waiver may never claim the test it replaces.
  assertKeys(record.physicalAcceptance, ['performed'], [], 'physicalAcceptance')
  requireEqual(record.physicalAcceptance.performed, false, 'physicalAcceptance.performed')
  return record
}

function assertLinuxBetaAcceptance(record, expectations) {
  assertKeys(
    record,
    [
      'schemaVersion',
      'kind',
      'status',
      'releaseId',
      'sourceCommit',
      'candidateIdentity',
      'artifact',
      'releaseSequence',
      'boxes'
    ],
    [],
    'record'
  )
  requireEqual(record.schemaVersion, 1, 'schemaVersion')
  requireEqual(record.kind, LINUX_BETA_ACCEPTANCE_KIND, 'kind')
  requireEqual(record.status, 'PASS', 'status')
  requireEqual(record.releaseId, expectations.releaseId, 'releaseId')
  requireEqual(record.sourceCommit, expectations.sourceCommit, 'sourceCommit')
  requireEqual(
    record.candidateIdentity,
    linuxBetaCandidateIdentity({
      appImageSha256: expectations.appImageSha256,
      releaseId: expectations.releaseId,
      sourceCommit: expectations.sourceCommit
    }),
    'candidateIdentity'
  )
  assertArtifact(record.artifact, expectations, { sizeBytesRequired: true })
  assertBetaReleaseSequence(record.releaseSequence, record.releaseId, expectations)

  if (!Array.isArray(record.boxes) || record.boxes.length < MIN_LINUX_BETA_ACCEPTANCE_BOXES) {
    throw new LinuxAcceptanceRecordError(
      'acceptance-boxes-missing',
      `A Linux Beta record needs at least ${MIN_LINUX_BETA_ACCEPTANCE_BOXES} physical Tier 1 boxes (plan 257 D11).`
    )
  }
  const desktops = new Set()
  record.boxes.forEach((box, index) => {
    const label = `boxes[${index}]`
    assertKeys(
      box,
      ['desktop', 'architecture', 'physicalHardware', 'testedAt', 'requiredGates'],
      [],
      label
    )
    if (!LINUX_TIER1_DESKTOPS.includes(box.desktop)) {
      throw new LinuxAcceptanceRecordError(
        'acceptance-desktop-not-tier1',
        `${label}.desktop must be one of: ${LINUX_TIER1_DESKTOPS.join(', ')}.`
      )
    }
    if (desktops.has(box.desktop)) {
      throw new LinuxAcceptanceRecordError(
        'acceptance-duplicate-desktop',
        `${label}.desktop repeats ${box.desktop}; each box must be a different Tier 1 desktop.`
      )
    }
    desktops.add(box.desktop)
    requireEqual(box.architecture, 'x64', `${label}.architecture`)
    requireEqual(box.physicalHardware, true, `${label}.physicalHardware`)
    const testedAt = canonicalTimestamp(box.testedAt, `${label}.testedAt`)
    assertWithinCandidateWindow(testedAt, expectations, `${label}.testedAt`, 'acceptance')
    assertKeys(
      box.requiredGates,
      REQUIRED_LINUX_BETA_ACCEPTANCE_GATES,
      [],
      `${label}.requiredGates`
    )
    for (const gate of REQUIRED_LINUX_BETA_ACCEPTANCE_GATES) {
      const gateLabel = `${label}.requiredGates.${gate}`
      assertKeys(box.requiredGates[gate], ['status'], [], gateLabel)
      requireEqual(box.requiredGates[gate].status, 'PASS', `${gateLabel}.status`)
    }
  })
  if (!desktops.has(REQUIRED_LINUX_BETA_DESKTOP)) {
    throw new LinuxAcceptanceRecordError(
      'acceptance-ubuntu-box-missing',
      `One Linux Beta box must be ${REQUIRED_LINUX_BETA_DESKTOP}.`
    )
  }
  return record
}

function assertArtifact(artifact, expectations, { sizeBytesRequired }) {
  assertKeys(
    artifact,
    sizeBytesRequired ? ['filename', 'sha256', 'sizeBytes'] : ['filename', 'sha256'],
    sizeBytesRequired ? [] : ['sizeBytes'],
    'artifact'
  )
  requireEqual(artifact.filename, expectations.filename, 'artifact.filename')
  requireSha256(artifact.sha256, 'artifact.sha256')
  requireEqual(artifact.sha256, expectations.appImageSha256, 'artifact.sha256')
  if ('sizeBytes' in artifact) {
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
      throw new LinuxAcceptanceRecordError(
        'acceptance-artifact.sizeBytes-mismatch',
        'Acceptance artifact.sizeBytes must be a positive integer.'
      )
    }
    if (expectations.sizeBytes !== undefined) {
      requireEqual(artifact.sizeBytes, expectations.sizeBytes, 'artifact.sizeBytes')
    }
  }
}

function assertBetaReleaseSequence(sequence, releaseId, expectations) {
  if (!Array.isArray(expectations.priorAcceptedReleaseIds)) {
    throw new LinuxAcceptanceRecordError(
      'missing-release-history-expectation',
      'A Linux Beta record is validated against the exact previously accepted Linux Beta records.'
    )
  }
  if (expectations.priorAcceptedReleaseIds.length === 0) {
    assertKeys(sequence, ['kind'], [], 'releaseSequence')
    requireEqual(sequence.kind, 'first-public-beta', 'releaseSequence.kind')
    return
  }
  assertKeys(sequence, ['kind', 'previousReleaseId'], [], 'releaseSequence')
  requireEqual(sequence.kind, 'successor', 'releaseSequence.kind')
  if (!BETA_RELEASE_ID.test(sequence.previousReleaseId ?? '')) {
    throw new LinuxAcceptanceRecordError(
      'invalid-previous-release',
      'releaseSequence.previousReleaseId must name a concrete prior Linux Beta.'
    )
  }
  if (compareLinuxReleaseIds(sequence.previousReleaseId, releaseId) >= 0) {
    throw new LinuxAcceptanceRecordError(
      'invalid-previous-release',
      'releaseSequence.previousReleaseId must be an earlier Linux Beta.'
    )
  }
  const immediatePrior = expectations.priorAcceptedReleaseIds.at(-1)
  if (sequence.previousReleaseId !== immediatePrior) {
    throw new LinuxAcceptanceRecordError(
      'unaccepted-previous-release',
      `releaseSequence.previousReleaseId must name the immediately preceding validated PASS record ${immediatePrior}.`
    )
  }
}

/**
 * Validate every committed Linux Alpha record in order. Returns the release
 * ids. A file that is not named <x.y.z>-alpha.N.json fails, so nothing hides
 * beside the records.
 */
export async function loadValidatedLinuxAlphaAcceptanceHistory(directory) {
  const releaseIds = await listRecordIds(directory, ALPHA_RECORD_FILENAME, 'Alpha')
  for (const releaseId of releaseIds) {
    const record = await readRecord(directory, releaseId, 'Alpha')
    const core = ALPHA_RELEASE_ID.exec(releaseId)[1]
    if (record?.artifact?.filename !== linuxAlphaAppImageFilename(core)) {
      throw new LinuxAcceptanceRecordError(
        'acceptance-artifact.filename-mismatch',
        `Linux Alpha record ${releaseId} must name ${linuxAlphaAppImageFilename(core)}.`
      )
    }
    assertLinuxAcceptanceRecord(record, {
      appImageSha256: record?.artifact?.sha256,
      filename: record?.artifact?.filename,
      releaseId,
      sourceCommit: record?.sourceCommit
    })
  }
  return releaseIds
}

/**
 * Validate every committed Linux Beta record as one chain: the first is
 * first-public-beta, each later one names the one before it.
 */
export async function loadValidatedLinuxBetaAcceptanceHistory(directory) {
  const releaseIds = await listRecordIds(directory, BETA_RECORD_FILENAME, 'Beta')
  const validated = []
  for (const releaseId of releaseIds) {
    const record = await readRecord(directory, releaseId, 'Beta')
    assertLinuxAcceptanceRecord(record, {
      appImageSha256: record?.artifact?.sha256,
      filename: record?.artifact?.filename,
      releaseId,
      sourceCommit: record?.sourceCommit,
      priorAcceptedReleaseIds: [...validated]
    })
    validated.push(releaseId)
  }
  return validated
}

async function listRecordIds(directory, pattern, trackName) {
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const ids = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const match = pattern.exec(name)
    if (!match) {
      throw new LinuxAcceptanceRecordError(
        'unexpected-record-file',
        `${name} is not a Linux ${trackName} record name (<x.y.z>-${trackName.toLowerCase()}.N.json).`
      )
    }
    ids.push(match[1])
  }
  return ids.sort(compareLinuxReleaseIds)
}

async function readRecord(directory, releaseId, trackName) {
  try {
    return JSON.parse(await readFile(join(directory, `${releaseId}.json`), 'utf8'))
  } catch (error) {
    throw new LinuxAcceptanceRecordError(
      'acceptance-record-json',
      `Linux ${trackName} record ${releaseId} is not valid JSON: ${error?.message ?? 'parse error'}.`
    )
  }
}

export function compareLinuxReleaseIds(left, right) {
  const parse = (id) => {
    const match = /^(\d+)\.(\d+)\.(\d+)-(?:alpha|beta)\.(\d+)$/.exec(id)
    if (!match) {
      throw new LinuxAcceptanceRecordError('invalid-release-id', `Bad Linux releaseId ${id}.`)
    }
    return match.slice(1).map(Number)
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function assertWithinCandidateWindow(when, expectations, label, noun) {
  if (expectations.releasedAt && when < canonicalTimestamp(expectations.releasedAt, 'releasedAt')) {
    throw new LinuxAcceptanceRecordError(
      `${noun}-before-candidate`,
      `${label} must not predate the candidate releasedAt timestamp.`
    )
  }
  const now = expectations.now instanceof Date ? expectations.now : new Date()
  if (when.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    throw new LinuxAcceptanceRecordError(`${noun}-in-future`, `${label} must not be in the future.`)
  }
}

function canonicalTimestamp(value, label) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new LinuxAcceptanceRecordError(
      `invalid-${label}`,
      `Acceptance ${label} must be a canonical UTC ISO-8601 timestamp.`
    )
  }
  return new Date(milliseconds)
}

function assertKeys(value, requiredKeys, optionalKeys, label) {
  if (!isObject(value)) {
    throw new LinuxAcceptanceRecordError(
      `invalid-${label}`,
      `Acceptance ${label} must be an object.`
    )
  }
  const actual = Object.keys(value)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  if (requiredKeys.some((key) => !(key in value)) || actual.some((key) => !allowed.has(key))) {
    throw new LinuxAcceptanceRecordError(
      `invalid-${label}-keys`,
      `Acceptance ${label} has missing or unsupported fields.`
    )
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new LinuxAcceptanceRecordError(
      `acceptance-${label}-mismatch`,
      `Acceptance ${label} does not match the exact candidate contract.`
    )
  }
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new LinuxAcceptanceRecordError(
      `acceptance-${label}-mismatch`,
      `${label} must be a lowercase SHA-256 digest.`
    )
  }
}

function requireCommit(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new LinuxAcceptanceRecordError(
      `acceptance-${label}-mismatch`,
      `${label} must be a lowercase 40-character Git SHA.`
    )
  }
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
