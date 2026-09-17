import {
  assertWindowsAlphaReleaseManifest,
  compareNumericVersions
} from './windows-alpha-release.mjs'
import { windowsCandidateIdentity, windowsCandidatePrefix } from './windows-release-candidate.mjs'

const MAX_ACCEPTANCE_RECORD_BYTES = 64 * 1024
const GITHUB_OWNER = 'TheOrcDev'
const GITHUB_REPOSITORY = 'videorc'
const ACCEPTANCE_DIRECTORY = ['docs', 'acceptance', 'windows-alpha']

export const REQUIRED_WINDOWS_ACCEPTANCE_GATES = Object.freeze([
  'cleanInstall',
  'protocolSignIn',
  'signOutRelaunch',
  'uninstall',
  'screenOnlyRecording',
  'cameraOnlyRecording',
  'screenCameraMicrophoneRecording',
  'normalGpuPath',
  'fallbackGpuPath',
  'lowerCapacityHardware',
  'ownedProcessCleanup',
  'supportBundleRedaction',
  'defenderMalwareScan',
  'authenticodeSignature',
  'alphaToAlphaUpdate',
  'productionDownloadRoute',
  'advertisedRtmpWorkflow'
])

export const REQUIRED_WINDOWS_D3D11_ACCEPTANCE_GATES = Object.freeze([
  ...REQUIRED_WINDOWS_ACCEPTANCE_GATES,
  'windowsD3d11Aggregate',
  'windowsD3d11AutomaticDefault',
  'windowsD3d11NaturalFallback',
  'windowsD3d11SourceLane',
  'macosRecordingStudioRegression'
])

export class WindowsAcceptanceRecordError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WindowsAcceptanceRecordError'
    this.code = code
  }
}

export function parseWindowsAcceptanceRecordUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw acceptanceUrlError()
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname.includes('%')
  ) {
    throw acceptanceUrlError()
  }

  const parts = url.pathname.split('/').filter(Boolean)
  let recordCommit
  let recordPath
  if (url.hostname === 'raw.githubusercontent.com') {
    if (parts[0] !== GITHUB_OWNER || parts[1] !== GITHUB_REPOSITORY) {
      throw acceptanceUrlError()
    }
    recordCommit = parts[2]
    recordPath = parts.slice(3)
  } else if (url.hostname === 'github.com') {
    if (parts[0] !== GITHUB_OWNER || parts[1] !== GITHUB_REPOSITORY || parts[2] !== 'blob') {
      throw acceptanceUrlError()
    }
    recordCommit = parts[3]
    recordPath = parts.slice(4)
  } else {
    throw acceptanceUrlError()
  }

  if (
    !/^[a-f0-9]{40}$/.test(recordCommit ?? '') ||
    recordPath.length !== ACCEPTANCE_DIRECTORY.length + 1 ||
    !ACCEPTANCE_DIRECTORY.every((segment, index) => recordPath[index] === segment) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(recordPath.at(-1) ?? '')
  ) {
    throw acceptanceUrlError()
  }

  return {
    canonicalRawUrl: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/${recordCommit}/${recordPath.join('/')}`,
    publicUrl: url.toString(),
    recordCommit,
    recordPath: recordPath.join('/')
  }
}

export function assertWindowsAcceptanceRecord(record, expectations) {
  if (!isObject(record)) {
    throw new WindowsAcceptanceRecordError(
      'invalid-acceptance-record',
      'Windows acceptance record must be a JSON object.'
    )
  }
  const schemaVersion = record.schemaVersion
  const d3d11Record = schemaVersion === 3
  assertExactKeys(
    record,
    [
      'schemaVersion',
      'kind',
      'status',
      'releaseId',
      'sourceCommit',
      'candidateIdentity',
      'candidateStoragePrefix',
      'installer',
      'testedAt',
      'testPlatform',
      'releaseSequence',
      'requiredGates',
      ...(d3d11Record ? ['qualificationEvidence'] : [])
    ],
    'record'
  )

  if (![2, 3].includes(schemaVersion)) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-field-mismatch',
      'schemaVersion must be 2 or 3.'
    )
  }
  requireEqual(record.kind, 'videorc-windows-alpha-acceptance', 'kind')
  requireEqual(record.status, 'PASS', 'status')
  requireEqual(record.releaseId, expectations.releaseId, 'releaseId')
  requireEqual(record.sourceCommit, expectations.sourceCommit, 'sourceCommit')

  const expectedIdentity = windowsCandidateIdentity({
    installerSha256: expectations.installerSha256,
    releaseId: expectations.releaseId,
    sourceCommit: expectations.sourceCommit
  })
  requireEqual(record.candidateIdentity, expectedIdentity, 'candidateIdentity')
  requireEqual(
    record.candidateStoragePrefix,
    windowsCandidatePrefix(expectations),
    'candidateStoragePrefix'
  )

  assertExactKeys(record.installer, ['filename', 'sha256', 'publisherName'], 'installer')
  requireEqual(record.installer.filename, expectations.filename, 'installer.filename')
  requireEqual(record.installer.sha256, expectations.installerSha256, 'installer.sha256')
  requireEqual(
    record.installer.publisherName,
    expectations.publisherName,
    'installer.publisherName'
  )

  const testedAt = canonicalTimestamp(record.testedAt, 'testedAt')
  if (
    expectations.releasedAt &&
    testedAt < canonicalTimestamp(expectations.releasedAt, 'releasedAt')
  ) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-before-candidate',
      'Acceptance testedAt must not predate the candidate releasedAt timestamp.'
    )
  }
  const now = expectations.now instanceof Date ? expectations.now : new Date()
  if (testedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-in-future',
      'Acceptance testedAt must not be in the future.'
    )
  }

  assertExactKeys(
    record.testPlatform,
    ['operatingSystem', 'architecture', 'physicalHardware'],
    'testPlatform'
  )
  requireEqual(record.testPlatform.operatingSystem, 'Windows 11', 'testPlatform.operatingSystem')
  requireEqual(record.testPlatform.architecture, 'x64', 'testPlatform.architecture')
  requireEqual(record.testPlatform.physicalHardware, true, 'testPlatform.physicalHardware')

  assertReleaseSequence(record.releaseSequence, record.releaseId, expectations)

  const requiredGates = d3d11Record
    ? REQUIRED_WINDOWS_D3D11_ACCEPTANCE_GATES
    : REQUIRED_WINDOWS_ACCEPTANCE_GATES
  assertExactKeys(record.requiredGates, requiredGates, 'requiredGates')
  for (const gate of requiredGates) {
    if (gate === 'alphaToAlphaUpdate' && expectations.priorAcceptedReleaseIds.length === 0) {
      assertExactKeys(record.requiredGates[gate], ['status', 'reason'], `requiredGates.${gate}`)
      requireEqual(
        record.requiredGates[gate].status,
        'NOT_APPLICABLE',
        `requiredGates.${gate}.status`
      )
      requireEqual(
        record.requiredGates[gate].reason,
        'first-public-alpha',
        `requiredGates.${gate}.reason`
      )
    } else {
      assertExactKeys(record.requiredGates[gate], ['status'], `requiredGates.${gate}`)
      requireEqual(record.requiredGates[gate].status, 'PASS', `requiredGates.${gate}.status`)
    }
  }
  if (d3d11Record) {
    assertWindowsD3d11QualificationEvidence(record.qualificationEvidence, expectations)
  }

  return record
}

function assertWindowsD3d11QualificationEvidence(evidence, expectations) {
  assertExactKeys(
    evidence,
    [
      'candidate',
      'd3d11Budget',
      'comparisons',
      'hosts',
      'aggregateSha256',
      'qualifiedProfiles',
      'windowsSourceLane',
      'macosRegression'
    ],
    'qualificationEvidence'
  )
  assertExactKeys(
    evidence.candidate,
    ['executableSha256', 'packagePayloadSha256'],
    'qualificationEvidence.candidate'
  )
  requireSha256(
    evidence.candidate.executableSha256,
    'qualificationEvidence.candidate.executableSha256'
  )
  requireSha256(
    evidence.candidate.packagePayloadSha256,
    'qualificationEvidence.candidate.packagePayloadSha256'
  )
  if (expectations.installedAppSha256) {
    requireEqual(
      evidence.candidate.executableSha256,
      expectations.installedAppSha256,
      'qualificationEvidence.candidate.executableSha256'
    )
  }
  if (expectations.packagePayloadSha256) {
    requireEqual(
      evidence.candidate.packagePayloadSha256,
      expectations.packagePayloadSha256,
      'qualificationEvidence.candidate.packagePayloadSha256'
    )
  }

  assertExactKeys(evidence.d3d11Budget, ['status', 'sha256'], 'qualificationEvidence.d3d11Budget')
  requireEqual(evidence.d3d11Budget.status, 'active', 'qualificationEvidence.d3d11Budget.status')
  requireSha256(evidence.d3d11Budget.sha256, 'qualificationEvidence.d3d11Budget.sha256')
  assertExactDigestMap(
    evidence.comparisons,
    ['nvidiaTuringFloor', 'intelXeIntegrated'],
    'qualificationEvidence.comparisons'
  )
  assertExactDigestMap(
    evidence.hosts,
    ['nvidiaTuringFloor', 'intelXeIntegrated', 'unsupportedNaturalFallback'],
    'qualificationEvidence.hosts'
  )
  requireSha256(evidence.aggregateSha256, 'qualificationEvidence.aggregateSha256')

  assertExactKeys(
    evidence.qualifiedProfiles,
    ['nvidiaTuringFloor', 'intelXeIntegrated', 'unsupportedNaturalFallback'],
    'qualificationEvidence.qualifiedProfiles'
  )
  requireExactProfiles(
    evidence.qualifiedProfiles.nvidiaTuringFloor,
    ['1080p30', '1080p60'],
    'qualificationEvidence.qualifiedProfiles.nvidiaTuringFloor'
  )
  requireExactProfiles(
    evidence.qualifiedProfiles.intelXeIntegrated,
    ['1080p30', '1080p60'],
    'qualificationEvidence.qualifiedProfiles.intelXeIntegrated'
  )
  requireExactProfiles(
    evidence.qualifiedProfiles.unsupportedNaturalFallback,
    ['1080p30'],
    'qualificationEvidence.qualifiedProfiles.unsupportedNaturalFallback'
  )

  assertExactPassMap(
    evidence.windowsSourceLane,
    ['d3dRustDiscovery', 'fullRustTests', 'clippy'],
    'qualificationEvidence.windowsSourceLane'
  )
  assertExactKeys(
    evidence.macosRegression,
    ['recordingStudio', 'recordingStudioDevices'],
    'qualificationEvidence.macosRegression'
  )
  requireEqual(
    evidence.macosRegression.recordingStudio?.status,
    'PASS',
    'qualificationEvidence.macosRegression.recordingStudio.status'
  )
  assertExactKeys(
    evidence.macosRegression.recordingStudio,
    ['status'],
    'qualificationEvidence.macosRegression.recordingStudio'
  )
  const devices = evidence.macosRegression.recordingStudioDevices
  if (devices?.status === 'PASS') {
    assertExactKeys(
      devices,
      ['status'],
      'qualificationEvidence.macosRegression.recordingStudioDevices'
    )
  } else if (devices?.status === 'BLOCKED') {
    assertExactKeys(
      devices,
      ['status', 'reason'],
      'qualificationEvidence.macosRegression.recordingStudioDevices'
    )
    if (typeof devices.reason !== 'string' || !devices.reason.trim()) {
      throw new WindowsAcceptanceRecordError(
        'acceptance-field-mismatch',
        'qualificationEvidence.macosRegression.recordingStudioDevices.reason was missing.'
      )
    }
  } else {
    throw new WindowsAcceptanceRecordError(
      'acceptance-field-mismatch',
      'qualificationEvidence.macosRegression.recordingStudioDevices.status must be PASS or BLOCKED.'
    )
  }
}

function assertExactDigestMap(value, fields, label) {
  assertExactKeys(value, fields, label)
  for (const field of fields) requireSha256(value[field], `${label}.${field}`)
}

function assertExactPassMap(value, fields, label) {
  assertExactKeys(value, fields, label)
  for (const field of fields) {
    assertExactKeys(value[field], ['status'], `${label}.${field}`)
    requireEqual(value[field].status, 'PASS', `${label}.${field}.status`)
  }
}

function requireExactProfiles(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((profile, index) => profile !== expected[index])
  ) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-field-mismatch',
      `${label} must be exactly ${expected.join(', ')}.`
    )
  }
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-field-mismatch',
      `${label} must be a lowercase SHA-256 digest.`
    )
  }
}

export async function resolveWindowsAcceptanceRecord({
  expectations,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  url
}) {
  const parsedUrl = parseWindowsAcceptanceRecordUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(parsedUrl.canonicalRawUrl, {
      headers: { Accept: 'application/json, text/plain;q=0.9' },
      redirect: 'error',
      signal: controller.signal
    })
  } catch (error) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-record-fetch',
      `Unable to fetch the pinned acceptance record: ${error?.message ?? 'network error'}.`
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-record-http',
      `Pinned acceptance record returned HTTP ${response.status}.`
    )
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (
    contentType &&
    !['application/json', 'text/plain', 'application/octet-stream'].includes(contentType)
  ) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-record-content-type',
      `Pinned acceptance record returned unsupported Content-Type ${contentType}.`
    )
  }
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_ACCEPTANCE_RECORD_BYTES) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-record-too-large',
      'Pinned acceptance record exceeds the 64 KiB limit.'
    )
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ACCEPTANCE_RECORD_BYTES) {
    throw new WindowsAcceptanceRecordError(
      'acceptance-record-size',
      'Pinned acceptance record is empty or exceeds the 64 KiB limit.'
    )
  }
  let record
  try {
    record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new WindowsAcceptanceRecordError(
      'acceptance-record-json',
      'Pinned acceptance record is not valid UTF-8 JSON.'
    )
  }
  assertWindowsAcceptanceRecord(record, expectations)
  return { ...parsedUrl, record }
}

export function applyWindowsAcceptanceRecord({
  acceptanceRecordUrl,
  installedAppSha256,
  manifest,
  packagePayloadSha256,
  priorAcceptedReleaseIds,
  record,
  now
}) {
  assertWindowsAlphaReleaseManifest(manifest)
  if (manifest.acceptanceStatus !== 'pending' || manifest.acceptanceRecordUrl) {
    throw new WindowsAcceptanceRecordError(
      'manifest-not-pending',
      'Only an untouched pending candidate manifest can receive public acceptance.'
    )
  }
  parseWindowsAcceptanceRecordUrl(acceptanceRecordUrl)
  assertWindowsAcceptanceRecord(record, {
    filename: manifest.filename,
    installerSha256: manifest.sha256,
    now,
    publisherName: manifest.publisherName,
    releasedAt: manifest.releasedAt,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    ...(installedAppSha256 ? { installedAppSha256 } : {}),
    ...(packagePayloadSha256 ? { packagePayloadSha256 } : {}),
    priorAcceptedReleaseIds
  })
  const accepted = {
    ...manifest,
    acceptanceStatus: 'pass',
    acceptanceRecordUrl
  }
  assertWindowsAlphaReleaseManifest(accepted, { requireAccepted: true })
  return accepted
}

function assertReleaseSequence(sequence, releaseId, expectations) {
  if (!Array.isArray(expectations.priorAcceptedReleaseIds)) {
    throw new WindowsAcceptanceRecordError(
      'missing-release-history-expectation',
      'Promotion must validate the exact previously accepted Windows Alpha records.'
    )
  }
  if (expectations.priorAcceptedReleaseIds.length === 0) {
    assertExactKeys(sequence, ['kind'], 'releaseSequence')
    requireEqual(sequence.kind, 'first-public-alpha', 'releaseSequence.kind')
    return
  }
  assertExactKeys(sequence, ['kind', 'previousReleaseId'], 'releaseSequence')
  requireEqual(sequence.kind, 'successor', 'releaseSequence.kind')
  if (!/^\d+\.\d+\.\d+-alpha\.1$/.test(sequence.previousReleaseId ?? '')) {
    throw new WindowsAcceptanceRecordError(
      'invalid-previous-release',
      'releaseSequence.previousReleaseId must name a concrete prior Windows Alpha.'
    )
  }
  const currentCore = releaseId.split('-')[0]
  const previousCore = sequence.previousReleaseId.split('-')[0]
  if (compareNumericVersions(previousCore, currentCore) >= 0) {
    throw new WindowsAcceptanceRecordError(
      'invalid-previous-release',
      'releaseSequence.previousReleaseId must have a lower numeric updater version.'
    )
  }
  const immediatePriorReleaseId = expectations.priorAcceptedReleaseIds.at(-1)
  if (sequence.previousReleaseId !== immediatePriorReleaseId) {
    throw new WindowsAcceptanceRecordError(
      'unaccepted-previous-release',
      `releaseSequence.previousReleaseId must name the immediately preceding validated PASS record ${immediatePriorReleaseId}.`
    )
  }
}

function acceptanceUrlError() {
  return new WindowsAcceptanceRecordError(
    'unsafe-acceptance-record-url',
    'Acceptance record URL must be an immutable 40-character-commit GitHub blob/raw URL under TheOrcDev/videorc/docs/acceptance/windows-alpha/*.json.'
  )
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') {
    throw new WindowsAcceptanceRecordError(
      `invalid-${label}`,
      `Acceptance ${label} must be a canonical UTC ISO-8601 timestamp.`
    )
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new WindowsAcceptanceRecordError(
      `invalid-${label}`,
      `Acceptance ${label} must be a canonical UTC ISO-8601 timestamp.`
    )
  }
  return new Date(milliseconds)
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isObject(value)) {
    throw new WindowsAcceptanceRecordError(
      `invalid-${label}`,
      `Acceptance ${label} must be an object.`
    )
  }
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new WindowsAcceptanceRecordError(
      `invalid-${label}-keys`,
      `Acceptance ${label} has missing or unsupported fields.`
    )
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new WindowsAcceptanceRecordError(
      `acceptance-${label}-mismatch`,
      `Acceptance ${label} does not match the exact candidate contract.`
    )
  }
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
