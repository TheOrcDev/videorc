import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

import {
  assertCaptureDecayAppBundleIdentityEqual,
  captureDecayAppBundleIdentityFromExecutable,
  normalizeCaptureDecayAppBundleIdentity,
  verifyCaptureDecayDmgAppBundle
} from './capture-decay-app-bundle.mjs'
import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  getReleaseUploadS3Config,
  publishReleaseUploadArtifact,
  sha256Base64FromHex
} from './release-upload-s3.mjs'
import { buildMacosReleaseArtifactChecks } from './macos-release-artifact-validation.mjs'

export const MACOS_D3_SEALED_CANDIDATE_PROFILE = 'macos-capture-decay-d3-sealed-candidate-v1'
export const MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE =
  'macos-capture-decay-d3-candidate-seal-receipt-v1'
export const MACOS_D3_CANDIDATE_MANIFEST_FILENAME = 'candidate.json'
export const MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME = 'candidate-seal-receipt.json'
export const MACOS_D3_PUBLICATION_VERIFICATION_FILENAME = 'candidate-publication-verification.json'
export const MACOS_D3_PUBLICATION_VERIFICATION_PROFILE =
  'macos-capture-decay-d3-publication-verification-v1'
export const MACOS_D3_PUBLICATION_VERIFICATION_DESCRIPTOR_ENV =
  'VIDEORC_MACOS_D3_PUBLICATION_VERIFICATION_DESCRIPTOR'
export const MACOS_D3_CANDIDATE_ROOT = 'candidates/macos/capture-decay-d3'
export const MACOS_D3_EXPECTED_SIGNING_PUBLISHER = 'Uros Miric'
export const MACOS_D3_EXPECTED_SIGNING_TEAM_ID = 'C2PA37RB58'
export const MACOS_D3_EXPECTED_SIGNING_AUTHORITY = `Developer ID Application: ${MACOS_D3_EXPECTED_SIGNING_PUBLISHER} (${MACOS_D3_EXPECTED_SIGNING_TEAM_ID})`

export const MACOS_D3_CANDIDATE_ARTIFACT_LABELS = Object.freeze([
  'dmg',
  'sha256',
  'manifest',
  'feed-zip',
  'feed-blockmap',
  'feed-manifest'
])

const ARTIFACT_LIMITS = Object.freeze({
  'candidate-executable': 4 * 1024 * 1024 * 1024,
  dmg: 4 * 1024 * 1024 * 1024,
  sha256: 1024,
  manifest: 256 * 1024,
  'feed-zip': 4 * 1024 * 1024 * 1024,
  'feed-blockmap': 512 * 1024 * 1024,
  'feed-manifest': 1024 * 1024,
  'candidate-manifest': 2 * 1024 * 1024,
  'candidate-seal-receipt': 2 * 1024 * 1024,
  'publication-verification': 1024 * 1024
})

const CONTENT_TYPES = Object.freeze({
  dmg: 'application/x-apple-diskimage',
  sha256: 'text/plain; charset=utf-8',
  manifest: 'application/json',
  'feed-zip': 'application/zip',
  'feed-blockmap': 'application/octet-stream',
  'feed-manifest': 'text/yaml; charset=utf-8',
  'candidate-manifest': 'application/json'
})

const RELEASE_MANIFEST_FIELDS = Object.freeze([
  'architecture',
  'bundleVersion',
  'channel',
  'displayVersion',
  'filename',
  'minimumMacOS',
  'objectKey',
  'platform',
  'product',
  'releaseId',
  'releaseNotesUrl',
  'releasedAt',
  'sha256',
  'sizeBytes'
])

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const macosReleaseArtifactValidatorPath = join(
  repoRoot,
  'scripts',
  'validate-macos-release-artifact.mjs'
)

export class MacosD3SealedCandidateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MacosD3SealedCandidateError'
    this.code = code
  }
}

export async function verifyMacosD3ReleaseArtifactAuthenticity(
  { dmgPath },
  {
    readSigningDetails = readMacosD3ReleaseArtifactSigningDetails,
    runArtifactValidation = runMacosD3ReleaseArtifactValidation
  } = {}
) {
  const artifactPath = resolve(requiredText(dmgPath, 'candidate DMG path'))
  let validation
  try {
    validation = await runArtifactValidation(artifactPath)
  } catch (cause) {
    throw candidateErrorWithCause(
      'candidate-authenticity-validation',
      'Candidate DMG failed macOS code-signing, notarization, or stapling validation.',
      cause
    )
  }
  if (validation?.ok !== true) {
    throw candidateError(
      'candidate-authenticity-unverifiable',
      'Candidate DMG macOS authenticity validation did not return an explicit pass.'
    )
  }

  let signingDetails
  try {
    signingDetails = await readSigningDetails(artifactPath)
  } catch (cause) {
    throw candidateErrorWithCause(
      'candidate-authenticity-unverifiable',
      'Candidate DMG signing identity could not be verified.',
      cause
    )
  }
  return assertMacosD3SigningIdentity(signingDetails)
}

async function runMacosD3ReleaseArtifactValidation(artifactPath) {
  await execFileAsync(process.execPath, [macosReleaseArtifactValidatorPath, artifactPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  })
  return { ok: true }
}

async function readMacosD3ReleaseArtifactSigningDetails(artifactPath) {
  const displayCheck = buildMacosReleaseArtifactChecks(artifactPath).find(
    (check) => check.id === 'codesign-display'
  )
  if (!displayCheck?.command || !Array.isArray(displayCheck.args)) {
    throw new Error('macOS release validator omitted its codesign display check')
  }
  const { stderr, stdout } = await execFileAsync(displayCheck.command, displayCheck.args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  })
  return [stdout, stderr].filter(Boolean).join('\n')
}

function assertMacosD3SigningIdentity(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 * 1024) {
    throw candidateError(
      'candidate-authenticity-unverifiable',
      'Candidate DMG signing identity output was missing or unsafe.'
    )
  }
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  const authorities = lines
    .filter((line) => line.startsWith('Authority='))
    .map((line) => line.slice('Authority='.length))
  const teamIdentifiers = lines
    .filter((line) => line.startsWith('TeamIdentifier='))
    .map((line) => line.slice('TeamIdentifier='.length))
  if (authorities.length === 0 || teamIdentifiers.length !== 1) {
    throw candidateError(
      'candidate-authenticity-unverifiable',
      'Candidate DMG signing identity omitted its signing authority or unique TeamIdentifier.'
    )
  }
  if (teamIdentifiers[0] !== MACOS_D3_EXPECTED_SIGNING_TEAM_ID) {
    throw candidateError(
      'candidate-authenticity-team-id',
      `Candidate DMG TeamIdentifier must be ${MACOS_D3_EXPECTED_SIGNING_TEAM_ID}.`
    )
  }
  if (authorities[0] !== MACOS_D3_EXPECTED_SIGNING_AUTHORITY) {
    throw candidateError(
      'candidate-authenticity-publisher',
      `Candidate DMG signing authority must be ${MACOS_D3_EXPECTED_SIGNING_AUTHORITY}.`
    )
  }
  return {
    authority: authorities[0],
    publisher: MACOS_D3_EXPECTED_SIGNING_PUBLISHER,
    teamId: teamIdentifiers[0]
  }
}

export function getMacosD3CandidateS3Config(env = process.env) {
  const prefix = 'VIDEORC_MACOS_D3_CANDIDATE_S3_'
  return getReleaseUploadS3Config({
    VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: env[`${prefix}ACCESS_KEY_ID`],
    VIDEORC_RELEASE_UPLOAD_S3_BUCKET: env[`${prefix}BUCKET`],
    VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL: env[`${prefix}ENDPOINT_URL`],
    VIDEORC_RELEASE_UPLOAD_S3_FORCE_PATH_STYLE: env[`${prefix}FORCE_PATH_STYLE`],
    VIDEORC_RELEASE_UPLOAD_S3_REGION: env[`${prefix}REGION`],
    VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: env[`${prefix}SECRET_ACCESS_KEY`],
    VIDEORC_RELEASE_UPLOAD_S3_SESSION_TOKEN: env[`${prefix}SESSION_TOKEN`],
    VIDEORC_RELEASE_UPLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS:
      env[`${prefix}TLS_ALLOWED_ISSUER_ORGANIZATIONS`],
    VIDEORC_RELEASE_UPLOAD_S3_TLS_ALLOWED_SPKI_SHA256: env[`${prefix}TLS_ALLOWED_SPKI_SHA256`]
  })
}

export function macosD3CandidateStorageIdentity(config) {
  let endpointUrl = config?.endpointUrl ?? null
  if (endpointUrl !== null) {
    try {
      const url = new URL(requiredText(endpointUrl, 'candidate storage endpoint URL'))
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('unsafe endpoint')
      }
      url.pathname = url.pathname.replace(/\/+$/, '')
      endpointUrl = url.toString()
    } catch {
      throw candidateError(
        'candidate-storage-endpoint',
        'Candidate storage endpoint must be a credential-free HTTPS URL.'
      )
    }
  }
  return {
    bucket: safeStorageName(config?.bucket, 'candidate storage bucket'),
    endpointUrl,
    forcePathStyle: config?.forcePathStyle === true,
    region: safeStorageName(config?.region, 'candidate storage region'),
    tlsPolicy: normalizeTlsPolicy(config?.tlsPolicy)
  }
}

export function macosD3CandidatePrefix({ releaseId, sourceCommit, dmgSha256 }) {
  const release = requireReleaseId(releaseId)
  const commit = requireCommit(sourceCommit, 'candidate source commit')
  const digest = requireSha256(dmgSha256, 'candidate DMG SHA-256')
  return `${MACOS_D3_CANDIDATE_ROOT}/${release}/${commit}/${digest}`
}

export function canonicalMacosD3Json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function sha256MacosD3CanonicalJson(value) {
  return sha256Bytes(Buffer.from(canonicalMacosD3Json(value)))
}

export async function buildMacosD3SealedCandidatePlan(
  {
    candidate,
    candidateExecutablePath,
    candidateStorageConfig,
    manifestPath,
    publicationDestinationBindingSha256,
    releaseDir
  },
  dependencies = {}
) {
  const normalizedCandidate = normalizeCandidate(candidate)
  const directory = resolve(requiredText(releaseDir, 'release directory'))
  const releaseManifestPath = resolve(manifestPath ?? join(directory, 'release.json'))
  const executablePath = resolve(
    requiredText(candidateExecutablePath, 'candidate app executable path')
  )
  const storage = macosD3CandidateStorageIdentity(candidateStorageConfig)
  const destinationBindingSha256 = requireSha256(
    publicationDestinationBindingSha256,
    'publication destination binding SHA-256'
  )

  const manifestText = await readUtf8File(releaseManifestPath, 'release manifest')
  const releaseManifest = parseCanonicalJson(manifestText, 'release manifest')
  validateReleaseManifest(releaseManifest, normalizedCandidate)
  const zipFilename = `${normalizedCandidate.dmgFilename.slice(0, -'.dmg'.length)}.zip`
  const definitions = [
    ['dmg', normalizedCandidate.dmgFilename, join(directory, normalizedCandidate.dmgFilename)],
    [
      'sha256',
      `${normalizedCandidate.dmgFilename}.sha256`,
      join(directory, `${normalizedCandidate.dmgFilename}.sha256`)
    ],
    ['manifest', 'release.json', releaseManifestPath],
    ['feed-zip', zipFilename, join(directory, zipFilename)],
    ['feed-blockmap', `${zipFilename}.blockmap`, join(directory, `${zipFilename}.blockmap`)],
    ['feed-manifest', 'latest-mac.yml', join(directory, 'latest-mac.yml')]
  ]
  const prefix = macosD3CandidatePrefix({
    dmgSha256: normalizedCandidate.dmgSha256,
    releaseId: releaseManifest.releaseId,
    sourceCommit: normalizedCandidate.sourceCommit
  })
  const artifacts = []
  for (const [label, filename, path] of definitions) {
    const safeName = safeFilename(filename, `${label} filename`)
    const sizeBytes = await regularFileSize(path, label, ARTIFACT_LIMITS[label])
    artifacts.push({
      contentType: CONTENT_TYPES[label],
      filename: safeName,
      immutable: true,
      label,
      maxBytes: ARTIFACT_LIMITS[label],
      objectKey: safeObjectKey(`${prefix}/artifacts/${safeName}`, `${label} object key`),
      path: resolve(path),
      sha256: await sha256File(path),
      sizeBytes
    })
  }
  assertExactArtifactSet(artifacts)
  assertArtifactMatchesCandidate(artifacts, normalizedCandidate)
  await validateReleasePayloadSemantics({
    artifacts,
    candidate: normalizedCandidate,
    releaseManifest
  })
  const before = artifactSnapshot(artifacts)

  const executableSizeBytes = await regularFileSize(
    executablePath,
    'candidate executable',
    ARTIFACT_LIMITS['candidate-executable']
  )
  const executableSha256 = await sha256File(executablePath)
  if (
    executableSizeBytes !== normalizedCandidate.executableSizeBytes ||
    executableSha256 !== normalizedCandidate.executableSha256
  ) {
    throw candidateError(
      'candidate-executable-mismatch',
      'Candidate executable does not equal the owner-tested executable identity.'
    )
  }

  const localIdentity = await (
    dependencies.captureAppBundleIdentity ?? captureDecayAppBundleIdentityFromExecutable
  )(executablePath)
  assertCaptureDecayAppBundleIdentityEqual(
    normalizedCandidate.appBundle,
    localIdentity,
    'sealed candidate local app bundle'
  )
  await (dependencies.verifyDmgAppBundle ?? verifyCaptureDecayDmgAppBundle)({
    dmgPath: artifactByLabel(artifacts, 'dmg').path,
    expectedIdentity: normalizedCandidate.appBundle
  })
  await (dependencies.verifyZipAppBundle ?? verifyMacosD3ZipAppBundle)({
    expectedIdentity: normalizedCandidate.appBundle,
    zipPath: artifactByLabel(artifacts, 'feed-zip').path
  })
  await assertArtifactSnapshotUnchanged(artifacts, before, 'candidate validation')
  if (
    (await regularFileSize(
      executablePath,
      'candidate executable',
      ARTIFACT_LIMITS['candidate-executable']
    )) !== executableSizeBytes ||
    (await sha256File(executablePath)) !== executableSha256
  ) {
    throw candidateError(
      'candidate-executable-mutated',
      'Candidate executable changed during candidate validation.'
    )
  }
  assertCaptureDecayAppBundleIdentityEqual(
    normalizedCandidate.appBundle,
    await (dependencies.captureAppBundleIdentity ?? captureDecayAppBundleIdentityFromExecutable)(
      executablePath
    ),
    'sealed candidate app bundle after validation'
  )

  const artifactBindings = artifacts.map(candidateArtifactBinding)
  const artifactSetSha256 = sha256MacosD3CanonicalJson(artifactBindings)
  const document = normalizeMacosD3SealedCandidateManifest({
    schemaVersion: 1,
    profile: MACOS_D3_SEALED_CANDIDATE_PROFILE,
    source: {
      commit: normalizedCandidate.sourceCommit,
      tree: normalizedCandidate.sourceTree
    },
    candidate: normalizedCandidate,
    publicationDestinationBindingSha256: destinationBindingSha256,
    storage: {
      ...storage,
      prefix,
      manifestObjectKey: `${prefix}/${MACOS_D3_CANDIDATE_MANIFEST_FILENAME}`
    },
    release: {
      releaseId: releaseManifest.releaseId,
      bundleVersion: releaseManifest.bundleVersion,
      artifactSetSha256,
      artifacts: artifactBindings
    }
  })
  const body = Buffer.from(canonicalMacosD3Json(document))
  if (body.byteLength > ARTIFACT_LIMITS['candidate-manifest']) {
    throw candidateError(
      'candidate-manifest-size',
      'Sealed candidate manifest exceeds its size bound.'
    )
  }
  const manifestArtifact = {
    body,
    contentType: CONTENT_TYPES['candidate-manifest'],
    filename: MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
    immutable: true,
    label: 'candidate-manifest',
    maxBytes: ARTIFACT_LIMITS['candidate-manifest'],
    objectKey: document.storage.manifestObjectKey,
    sha256: sha256Bytes(body),
    sizeBytes: body.byteLength
  }
  return {
    artifacts,
    candidate: normalizedCandidate,
    document,
    manifestArtifact,
    releaseManifest,
    storageConfig: candidateStorageConfig
  }
}

export function normalizeMacosD3SealedCandidateManifest(document) {
  assertExactKeys(
    document,
    [
      'candidate',
      'profile',
      'publicationDestinationBindingSha256',
      'release',
      'schemaVersion',
      'source',
      'storage'
    ],
    'sealed candidate manifest'
  )
  if (document?.schemaVersion !== 1 || document?.profile !== MACOS_D3_SEALED_CANDIDATE_PROFILE) {
    throw candidateError(
      'candidate-manifest-profile',
      `Sealed candidate manifest must use ${MACOS_D3_SEALED_CANDIDATE_PROFILE}.`
    )
  }
  const candidate = normalizeCandidate(document.candidate)
  assertExactKeys(document.source, ['commit', 'tree'], 'sealed candidate source')
  const source = {
    commit: requireCommit(document.source?.commit, 'sealed candidate source commit'),
    tree: requireGitObject(document.source?.tree, 'sealed candidate source tree')
  }
  if (source.commit !== candidate.sourceCommit || source.tree !== candidate.sourceTree) {
    throw candidateError(
      'candidate-source-mismatch',
      'Sealed candidate source does not match its exact candidate identity.'
    )
  }
  assertExactKeys(
    document.storage,
    [
      'bucket',
      'endpointUrl',
      'forcePathStyle',
      'manifestObjectKey',
      'prefix',
      'region',
      'tlsPolicy'
    ],
    'sealed candidate storage'
  )
  const storageIdentity = macosD3CandidateStorageIdentity(document.storage)
  const releaseId = requireReleaseId(document.release?.releaseId)
  const expectedPrefix = macosD3CandidatePrefix({
    dmgSha256: candidate.dmgSha256,
    releaseId,
    sourceCommit: candidate.sourceCommit
  })
  const prefix = safeObjectKey(document.storage?.prefix, 'sealed candidate prefix')
  const manifestObjectKey = safeObjectKey(
    document.storage?.manifestObjectKey,
    'sealed candidate manifest object key'
  )
  if (
    prefix !== expectedPrefix ||
    manifestObjectKey !== `${expectedPrefix}/${MACOS_D3_CANDIDATE_MANIFEST_FILENAME}`
  ) {
    throw candidateError(
      'candidate-storage-route',
      'Sealed candidate storage route is not derived from its release, source, and DMG identity.'
    )
  }
  assertExactKeys(
    document.release,
    ['artifactSetSha256', 'artifacts', 'bundleVersion', 'releaseId'],
    'sealed candidate release'
  )
  const bundleVersion = requireVersion(document.release?.bundleVersion)
  const artifacts = normalizeCandidateArtifactBindings(document.release?.artifacts, expectedPrefix)
  const artifactSetSha256 = requireSha256(
    document.release?.artifactSetSha256,
    'sealed candidate artifact-set SHA-256'
  )
  if (sha256MacosD3CanonicalJson(artifacts) !== artifactSetSha256) {
    throw candidateError(
      'candidate-artifact-set-hash',
      'Sealed candidate artifact-set SHA-256 is invalid.'
    )
  }
  const dmg = artifactByLabel(artifacts, 'dmg')
  if (
    dmg.filename !== candidate.dmgFilename ||
    dmg.sha256 !== candidate.dmgSha256 ||
    dmg.sizeBytes !== candidate.dmgSizeBytes
  ) {
    throw candidateError(
      'candidate-dmg-mismatch',
      'Sealed candidate DMG artifact does not equal the owner-tested candidate DMG.'
    )
  }
  return {
    schemaVersion: 1,
    profile: MACOS_D3_SEALED_CANDIDATE_PROFILE,
    source,
    candidate,
    publicationDestinationBindingSha256: requireSha256(
      document.publicationDestinationBindingSha256,
      'publication destination binding SHA-256'
    ),
    storage: {
      ...storageIdentity,
      prefix,
      manifestObjectKey
    },
    release: {
      releaseId,
      bundleVersion,
      artifactSetSha256,
      artifacts
    }
  }
}

export async function stageMacosD3SealedCandidate(
  plan,
  {
    createTransportImpl = createReleaseUploadS3Transport,
    inspectImpl = inspectMacosD3RemoteArtifact,
    now = () => new Date(),
    publishImpl = publishReleaseUploadArtifact,
    transport = null,
    verifyReleaseArtifactAuthenticity = verifyMacosD3ReleaseArtifactAuthenticity
  } = {}
) {
  const document = normalizeMacosD3SealedCandidateManifest(plan?.document)
  const manifestArtifact = normalizeUploadArtifact(plan?.manifestArtifact, 'candidate-manifest')
  if (
    manifestArtifact.objectKey !== document.storage.manifestObjectKey ||
    manifestArtifact.sha256 !== sha256MacosD3CanonicalJson(document)
  ) {
    throw candidateError(
      'candidate-manifest-artifact',
      'Candidate manifest upload artifact does not match the canonical sealed manifest.'
    )
  }
  const artifacts = normalizeUploadArtifacts(plan?.artifacts)
  assertPlanMatchesManifest(artifacts, document)
  const localSnapshot = artifactSnapshot(artifacts)
  await assertArtifactSnapshotUnchanged(artifacts, localSnapshot, 'candidate stage preflight')
  await verifyReleaseArtifactAuthenticity({
    dmgPath: artifactByLabel(artifacts, 'dmg').path
  })
  await assertArtifactSnapshotUnchanged(
    artifacts,
    localSnapshot,
    'candidate authenticity verification'
  )
  const config = plan?.storageConfig
  if (
    JSON.stringify(macosD3CandidateStorageIdentity(config)) !==
    JSON.stringify(storageIdentityFromManifest(document))
  ) {
    throw candidateError(
      'candidate-storage-config',
      'Candidate storage credentials target a different non-secret destination than the sealed manifest.'
    )
  }

  const activeTransport = transport ?? createTransportImpl({ config })
  const ownsTransport = transport === null
  try {
    const results = []
    // The canonical manifest is deliberately last: its presence is the commit marker
    // that says every referenced payload was already stored and byte-verified.
    for (const artifact of [...artifacts, manifestArtifact]) {
      const result = await publishImpl({
        artifact,
        config,
        transport: boundedPublicationTransport(activeTransport, artifact),
        verifyAfterPut: true
      })
      const verification = await inspectImpl({ artifact, config, transport: activeTransport })
      results.push({
        action: requiredText(result?.action, `${artifact.label} publication action`),
        ...candidateArtifactBinding(artifact),
        verification
      })
    }
    // Re-read every payload after the manifest commit marker to catch a concurrent
    // delete/replacement before emitting the durable local seal receipt.
    for (const artifact of artifacts) {
      await inspectImpl({ artifact, config, transport: activeTransport })
    }
    await assertArtifactSnapshotUnchanged(artifacts, localSnapshot, 'candidate stage')
    const sealedAt = now().toISOString()
    if (!Number.isFinite(Date.parse(sealedAt))) {
      throw candidateError('candidate-seal-time', 'Candidate seal timestamp is invalid.')
    }
    return normalizeMacosD3CandidateSealReceipt({
      schemaVersion: 1,
      profile: MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE,
      sealedAt,
      candidateManifest: document,
      candidate: {
        ...document.candidate,
        artifactSetSha256: document.release.artifactSetSha256,
        releaseId: document.release.releaseId,
        bundleVersion: document.release.bundleVersion,
        publicationDestinationBindingSha256: document.publicationDestinationBindingSha256
      },
      manifest: candidateArtifactBinding(manifestArtifact),
      storage: storageIdentityFromManifest(document),
      objects: results
    })
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export function normalizeMacosD3CandidateSealReceipt(receipt) {
  assertExactKeys(
    receipt,
    [
      'candidate',
      'candidateManifest',
      'manifest',
      'objects',
      'profile',
      'schemaVersion',
      'sealedAt',
      'storage'
    ],
    'candidate seal receipt'
  )
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.profile !== MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE
  ) {
    throw candidateError(
      'candidate-seal-profile',
      `Candidate seal receipt must use ${MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE}.`
    )
  }
  const sealedAt = requiredTimestamp(receipt.sealedAt, 'candidate seal receipt timestamp')
  assertExactKeys(
    receipt.candidate,
    [
      'artifactSetSha256',
      'appBundle',
      'bundleVersion',
      'dmgFilename',
      'dmgSha256',
      'dmgSizeBytes',
      'executableFilename',
      'executableSha256',
      'executableSizeBytes',
      'publicationDestinationBindingSha256',
      'releaseId',
      'sourceCommit',
      'sourceTree'
    ],
    'candidate seal identity'
  )
  const candidateIdentity = normalizeCandidate(receipt.candidate)
  const candidate = {
    ...candidateIdentity,
    artifactSetSha256: requireSha256(
      receipt.candidate?.artifactSetSha256,
      'sealed artifact-set SHA-256'
    ),
    releaseId: requireReleaseId(receipt.candidate?.releaseId),
    bundleVersion: requireVersion(receipt.candidate?.bundleVersion),
    publicationDestinationBindingSha256: requireSha256(
      receipt.candidate?.publicationDestinationBindingSha256,
      'sealed publication destination binding SHA-256'
    )
  }
  const manifest = normalizeCandidateArtifactBinding(receipt.manifest, {
    expectedLabel: 'candidate-manifest'
  })
  const candidateManifest = normalizeMacosD3SealedCandidateManifest(receipt.candidateManifest)
  assertExactKeys(
    receipt.storage,
    ['bucket', 'endpointUrl', 'forcePathStyle', 'region', 'tlsPolicy'],
    'candidate seal storage'
  )
  const storage = macosD3CandidateStorageIdentity(receipt.storage)
  if (!Array.isArray(receipt.objects) || receipt.objects.length !== 7) {
    throw candidateError(
      'candidate-seal-objects',
      'Candidate seal receipt must retain six payloads plus the manifest commit marker.'
    )
  }
  const expectedLabels = [...MACOS_D3_CANDIDATE_ARTIFACT_LABELS, 'candidate-manifest']
  const objects = receipt.objects.map((entry, index) => {
    const normalized = normalizeCandidateArtifactBinding(entry, {
      expectedLabel: expectedLabels[index],
      allowPublicationEvidence: true
    })
    if (
      normalized.verification.sha256 !== normalized.sha256 ||
      normalized.verification.sizeBytes !== normalized.sizeBytes
    ) {
      throw candidateError(
        'candidate-seal-verification',
        `Candidate seal verification does not match ${normalized.label}.`
      )
    }
    return normalized
  })
  if (JSON.stringify(candidateArtifactBinding(objects.at(-1))) !== JSON.stringify(manifest)) {
    throw candidateError(
      'candidate-seal-manifest',
      'Candidate seal manifest descriptor does not match its manifest-last verification entry.'
    )
  }
  const candidateManifestBytes = Buffer.from(canonicalMacosD3Json(candidateManifest))
  if (
    candidateManifestBytes.byteLength !== manifest.sizeBytes ||
    sha256Bytes(candidateManifestBytes) !== manifest.sha256 ||
    JSON.stringify(candidateManifest.candidate) !== JSON.stringify(candidateIdentity) ||
    candidateManifest.release.releaseId !== candidate.releaseId ||
    candidateManifest.release.bundleVersion !== candidate.bundleVersion ||
    candidateManifest.release.artifactSetSha256 !== candidate.artifactSetSha256 ||
    candidateManifest.publicationDestinationBindingSha256 !==
      candidate.publicationDestinationBindingSha256 ||
    JSON.stringify(candidateManifest.release.artifacts) !==
      JSON.stringify(objects.slice(0, -1).map(candidateArtifactBinding)) ||
    JSON.stringify(storageIdentityFromManifest(candidateManifest)) !== JSON.stringify(storage)
  ) {
    throw candidateError(
      'candidate-seal-manifest-document',
      'Candidate seal receipt does not exactly bind its canonical candidate manifest document.'
    )
  }
  return {
    schemaVersion: 1,
    profile: MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE,
    sealedAt,
    candidate,
    candidateManifest,
    manifest,
    storage,
    objects
  }
}

export function macosD3CandidateSealSummary(receipt) {
  const normalized = normalizeMacosD3CandidateSealReceipt(receipt)
  const receiptBody = Buffer.from(canonicalMacosD3Json(normalized))
  return {
    profile: MACOS_D3_SEALED_CANDIDATE_PROFILE,
    artifactSetSha256: normalized.candidate.artifactSetSha256,
    manifest: {
      objectKey: normalized.manifest.objectKey,
      sha256: normalized.manifest.sha256,
      sizeBytes: normalized.manifest.sizeBytes
    },
    storageBindingSha256: sha256MacosD3CanonicalJson(normalized.storage),
    sealReceipt: {
      profile: MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE,
      sha256: sha256Bytes(receiptBody),
      sizeBytes: receiptBody.byteLength,
      sealedAt: normalized.sealedAt,
      document: normalized
    }
  }
}

export function normalizeMacosD3SealedCandidateBinding(value) {
  assertExactKeys(
    value,
    ['artifactSetSha256', 'manifest', 'profile', 'sealReceipt', 'storageBindingSha256'],
    'accepted sealed candidate'
  )
  if (value.profile !== MACOS_D3_SEALED_CANDIDATE_PROFILE) {
    throw candidateError(
      'candidate-binding-profile',
      `Accepted sealed candidate must use ${MACOS_D3_SEALED_CANDIDATE_PROFILE}.`
    )
  }
  assertExactKeys(
    value.manifest,
    ['objectKey', 'sha256', 'sizeBytes'],
    'accepted candidate manifest'
  )
  assertExactKeys(
    value.sealReceipt,
    ['document', 'profile', 'sealedAt', 'sha256', 'sizeBytes'],
    'accepted candidate seal receipt'
  )
  if (value.sealReceipt.profile !== MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE) {
    throw candidateError(
      'candidate-binding-receipt-profile',
      `Accepted candidate seal receipt must use ${MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE}.`
    )
  }
  const expected = macosD3CandidateSealSummary(value.sealReceipt.document)
  const supplied = {
    profile: value.profile,
    artifactSetSha256: requireSha256(
      value.artifactSetSha256,
      'accepted candidate artifact-set SHA-256'
    ),
    manifest: normalizeExpectedManifestDescriptor(value.manifest),
    storageBindingSha256: requireSha256(
      value.storageBindingSha256,
      'accepted candidate storage binding SHA-256'
    ),
    sealReceipt: {
      profile: value.sealReceipt.profile,
      sha256: requireSha256(value.sealReceipt.sha256, 'accepted candidate seal receipt SHA-256'),
      sizeBytes: boundedPositiveSize(
        value.sealReceipt.sizeBytes,
        'accepted candidate seal receipt size',
        ARTIFACT_LIMITS['candidate-manifest']
      ),
      sealedAt: requiredTimestamp(value.sealReceipt.sealedAt, 'accepted candidate seal time'),
      document: normalizeMacosD3CandidateSealReceipt(value.sealReceipt.document)
    }
  }
  if (JSON.stringify(supplied) !== JSON.stringify(expected)) {
    throw candidateError(
      'candidate-binding-mismatch',
      'Accepted sealed-candidate binding does not match its canonical seal receipt.'
    )
  }
  return expected
}

export function macosD3SealedCandidateCompactBinding(value) {
  const sealedCandidate = normalizeMacosD3SealedCandidateBinding(value)
  return {
    profile: sealedCandidate.profile,
    artifactSetSha256: sealedCandidate.artifactSetSha256,
    manifestSha256: sealedCandidate.manifest.sha256,
    sealReceiptSha256: sealedCandidate.sealReceipt.sha256,
    storageBindingSha256: sealedCandidate.storageBindingSha256
  }
}

export function macosD3SealedCandidateBindingSha256(value) {
  return sha256MacosD3CanonicalJson(macosD3SealedCandidateCompactBinding(value))
}

export function assertMacosD3SealedCandidateMatches({
  candidate,
  publicationDestinationBindingSha256,
  sealedCandidate
}) {
  const normalized = normalizeMacosD3SealedCandidateBinding(sealedCandidate)
  const expectedCandidate = normalizeCandidate(candidate)
  const sealedManifest = normalized.sealReceipt.document.candidateManifest
  if (
    JSON.stringify(sealedManifest.candidate) !== JSON.stringify(expectedCandidate) ||
    sealedManifest.publicationDestinationBindingSha256 !==
      requireSha256(
        publicationDestinationBindingSha256,
        'expected publication destination binding SHA-256'
      )
  ) {
    throw candidateError(
      'candidate-seal-identity-mismatch',
      'Sealed candidate does not match the exact tested source, executable, app bundle, DMG, and publication destination.'
    )
  }
  return normalized
}

export function macosD3CandidateArtifactMap(manifest) {
  const document = normalizeMacosD3SealedCandidateManifest(manifest)
  return Object.fromEntries(
    document.release.artifacts.map((artifact) => [artifact.label, { ...artifact }])
  )
}

export function macosD3CandidatePublicationArtifactMapping(manifest) {
  const document = normalizeMacosD3SealedCandidateManifest(manifest)
  return document.release.artifacts.map((artifact) => ({
    candidateLabel: artifact.label,
    filename: artifact.filename,
    sealedObjectKey: artifact.objectKey,
    contentType: artifact.contentType,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  }))
}

export async function inspectMacosD3RemoteArtifact({ artifact, config, transport = null }) {
  const normalized = normalizeUploadArtifact(artifact, artifact?.label)
  const activeTransport = transport ?? createReleaseUploadS3Transport({ config })
  const ownsTransport = transport === null
  const signed = buildSignedS3Request({
    config,
    method: 'GET',
    objectKey: normalized.objectKey
  })
  try {
    const response = await activeTransport.request(signed.url, {
      headers: { ...signed.headers, 'accept-encoding': 'identity' },
      method: 'GET'
    })
    if (!response.ok || !response.body) {
      await discardRemoteBody(response.body)
      throw candidateError(
        'candidate-remote-read',
        `Could not read sealed candidate object ${normalized.objectKey}: HTTP ${response.status}.`
      )
    }
    const headers = assertRemoteHeaders(response.headers, normalized)
    const hash = createHash('sha256')
    let sizeBytes = 0
    for await (const chunk of response.body) {
      sizeBytes += chunk.byteLength
      if (sizeBytes > normalized.maxBytes || sizeBytes > normalized.sizeBytes) {
        throw candidateError(
          'candidate-remote-size',
          `Sealed candidate object ${normalized.objectKey} exceeded its exact size bound.`
        )
      }
      hash.update(chunk)
    }
    const sha256 = hash.digest('hex')
    if (sizeBytes !== normalized.sizeBytes || sha256 !== normalized.sha256) {
      throw candidateError(
        'candidate-remote-bytes',
        `Sealed candidate object ${normalized.objectKey} does not match its exact bytes.`
      )
    }
    return {
      state: 'identical',
      sha256,
      sizeBytes,
      etag: headers.etag
    }
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export async function downloadMacosD3SealedCandidate(
  { candidateStorageConfig, expectedManifest, outputDir },
  { createTransportImpl = createReleaseUploadS3Transport, transport = null } = {}
) {
  const destination = resolve(requiredText(outputDir, 'candidate download directory'))
  await ensureEmptyOwnedDirectory(destination)
  const descriptor = normalizeExpectedManifestDescriptor(expectedManifest)
  const storage = macosD3CandidateStorageIdentity(candidateStorageConfig)
  const manifestPath = join(destination, MACOS_D3_CANDIDATE_MANIFEST_FILENAME)
  const manifestArtifact = {
    ...descriptor,
    contentType: CONTENT_TYPES['candidate-manifest'],
    filename: MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
    immutable: true,
    label: 'candidate-manifest',
    maxBytes: ARTIFACT_LIMITS['candidate-manifest']
  }
  const activeTransport = transport ?? createTransportImpl({ config: candidateStorageConfig })
  const ownsTransport = transport === null
  try {
    await downloadRemoteArtifact({
      artifact: manifestArtifact,
      config: candidateStorageConfig,
      destination: manifestPath,
      transport: activeTransport
    })
    const manifestText = await readUtf8File(manifestPath, 'downloaded candidate manifest')
    const document = normalizeMacosD3SealedCandidateManifest(
      parseCanonicalJson(manifestText, 'downloaded candidate manifest')
    )
    if (
      document.storage.manifestObjectKey !== descriptor.objectKey ||
      JSON.stringify(storageIdentityFromManifest(document)) !== JSON.stringify(storage)
    ) {
      throw candidateError(
        'candidate-download-authority',
        'Downloaded candidate manifest does not match the accepted object key and storage authority.'
      )
    }
    for (const binding of document.release.artifacts) {
      const artifact = {
        ...binding,
        immutable: true,
        maxBytes: ARTIFACT_LIMITS[binding.label]
      }
      await downloadRemoteArtifact({
        artifact,
        config: candidateStorageConfig,
        destination: join(destination, binding.filename),
        transport: activeTransport
      })
    }
    return { directory: destination, document, manifestPath }
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export async function writeMacosD3PublicationVerificationDescriptor({
  descriptorPath,
  expectedSealedCandidate,
  outputDir
}) {
  const directory = await requireRealCandidateDirectory(outputDir)
  const destination = requirePublicationVerificationDescriptorPath(descriptorPath, directory)
  const sealedCandidate = normalizeMacosD3SealedCandidateBinding(expectedSealedCandidate)
  const descriptor = macosD3PublicationVerificationDescriptor(sealedCandidate)
  await assertCandidateDirectoryContents(directory, descriptor.files)
  await verifyMacosD3PublicationCandidateFiles({
    directory,
    files: descriptor.files
  })
  await writeMacosD3CanonicalJsonExclusive(destination, descriptor)
  await assertCandidateDirectoryContents(directory, [
    ...descriptor.files,
    publicationVerificationFileDescriptor(descriptor)
  ])
  return destination
}

export async function reverifyMacosD3PublicationCandidate({
  descriptorPath,
  expectedSealedCandidate,
  outputDir
}) {
  const directory = await requireRealCandidateDirectory(outputDir)
  const destination = requirePublicationVerificationDescriptorPath(descriptorPath, directory)
  const sealedCandidate = normalizeMacosD3SealedCandidateBinding(expectedSealedCandidate)
  const descriptor = macosD3PublicationVerificationDescriptor(sealedCandidate)
  const descriptorFile = publicationVerificationFileDescriptor(descriptor)
  await assertCandidateDirectoryContents(directory, [...descriptor.files, descriptorFile])
  await verifyMacosD3PublicationCandidateFiles({
    directory,
    files: [descriptorFile, ...descriptor.files]
  })
  return {
    document: sealedCandidate.sealReceipt.document.candidateManifest,
    releaseManifest: null,
    publicationVerification: descriptor
  }
}

export async function verifyDownloadedMacosD3SealedCandidate(
  { expectedManifest = null, expectedSealedCandidate = null, outputDir },
  dependencies = {}
) {
  const directory = await requireRealCandidateDirectory(outputDir)
  const exactPromotion = dependencies.requireFullVerification
    ? false
    : (dependencies.exactPromotion ?? envFlag(process.env.VIDEORC_CAPTURE_DECAY_D3_EXACT_PROMOTION))
  if (exactPromotion) {
    if (!expectedSealedCandidate) {
      throw candidateError(
        'candidate-publication-verification-authority',
        'Exact D3 publication revalidation requires the accepted sealed-candidate binding.'
      )
    }
    const descriptorPath =
      dependencies.publicationVerificationDescriptorPath ??
      process.env[MACOS_D3_PUBLICATION_VERIFICATION_DESCRIPTOR_ENV]
    if (!descriptorPath) {
      throw candidateError(
        'candidate-publication-verification-required',
        `Exact D3 publication requires ${MACOS_D3_PUBLICATION_VERIFICATION_DESCRIPTOR_ENV}.`
      )
    }
    return await reverifyMacosD3PublicationCandidate({
      descriptorPath,
      expectedSealedCandidate,
      outputDir: directory
    })
  }
  const manifestPath = join(directory, MACOS_D3_CANDIDATE_MANIFEST_FILENAME)
  const manifestBytes = await readFile(manifestPath)
  const sealedCandidate = expectedSealedCandidate
    ? normalizeMacosD3SealedCandidateBinding(expectedSealedCandidate)
    : null
  if (sealedCandidate && expectedManifest) {
    const suppliedDescriptor = normalizeExpectedManifestDescriptor(expectedManifest)
    if (JSON.stringify(suppliedDescriptor) !== JSON.stringify(sealedCandidate.manifest)) {
      throw candidateError(
        'candidate-manifest-authority',
        'Expected candidate manifest descriptor conflicts with the sealed-candidate binding.'
      )
    }
  }
  const authoritativeManifest = sealedCandidate?.manifest ?? expectedManifest
  if (authoritativeManifest) {
    const expected = normalizeExpectedManifestDescriptor(authoritativeManifest)
    if (
      manifestBytes.byteLength !== expected.sizeBytes ||
      sha256Bytes(manifestBytes) !== expected.sha256
    ) {
      throw candidateError(
        'candidate-manifest-expected',
        'Downloaded candidate manifest does not match the accepted descriptor.'
      )
    }
  }
  const document = normalizeMacosD3SealedCandidateManifest(
    parseCanonicalJson(manifestBytes.toString('utf8'), 'downloaded candidate manifest')
  )
  if (sealedCandidate) assertDocumentMatchesSealedCandidate(document, sealedCandidate)
  const expectedNames = new Set([
    MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
    ...(sealedCandidate ? [MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME] : []),
    ...document.release.artifacts.map((artifact) => artifact.filename)
  ])
  const entries = await readdir(directory, { withFileTypes: true })
  if (
    entries.length !== expectedNames.size ||
    entries.some((entry) => !entry.isFile() || !expectedNames.has(entry.name))
  ) {
    throw candidateError(
      'candidate-directory-contents',
      'Candidate directory must contain exactly the sealed manifest and its six regular files.'
    )
  }
  if (sealedCandidate) {
    const receiptBytes = await readFile(join(directory, MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME))
    const expectedReceiptBytes = Buffer.from(
      canonicalMacosD3Json(sealedCandidate.sealReceipt.document)
    )
    if (!receiptBytes.equals(expectedReceiptBytes)) {
      throw candidateError(
        'candidate-local-seal-receipt',
        'Candidate seal receipt does not equal the reviewed accepted-record receipt.'
      )
    }
  }
  const localArtifacts = []
  for (const binding of document.release.artifacts) {
    const path = join(directory, binding.filename)
    const sizeBytes = await regularFileSize(path, binding.label, ARTIFACT_LIMITS[binding.label])
    const sha256 = await sha256File(path)
    if (sizeBytes !== binding.sizeBytes || sha256 !== binding.sha256) {
      throw candidateError(
        'candidate-local-artifact',
        `Downloaded ${binding.label} does not match its sealed descriptor.`
      )
    }
    localArtifacts.push({ ...binding, path })
  }
  const releaseManifest = parseCanonicalJson(
    await readUtf8File(artifactByLabel(localArtifacts, 'manifest').path, 'release manifest'),
    'release manifest'
  )
  validateReleaseManifest(releaseManifest, document.candidate)
  await validateReleasePayloadSemantics({
    artifacts: localArtifacts,
    candidate: document.candidate,
    releaseManifest
  })
  const before = artifactSnapshot(localArtifacts)
  await (
    dependencies.verifyReleaseArtifactAuthenticity ?? verifyMacosD3ReleaseArtifactAuthenticity
  )({
    dmgPath: artifactByLabel(localArtifacts, 'dmg').path
  })
  await (dependencies.verifyDmgAppBundle ?? verifyCaptureDecayDmgAppBundle)({
    dmgPath: artifactByLabel(localArtifacts, 'dmg').path,
    expectedIdentity: document.candidate.appBundle
  })
  await (dependencies.verifyZipAppBundle ?? verifyMacosD3ZipAppBundle)({
    expectedIdentity: document.candidate.appBundle,
    zipPath: artifactByLabel(localArtifacts, 'feed-zip').path
  })
  await assertArtifactSnapshotUnchanged(localArtifacts, before, 'downloaded candidate verification')
  return { document, releaseManifest }
}

export async function verifyMacosD3ZipAppBundle(
  { expectedIdentity, zipPath },
  {
    captureAppBundleIdentity = captureDecayAppBundleIdentityFromExecutable,
    extractZip = extractZipWithDitto
  } = {}
) {
  const expected = normalizeCaptureDecayAppBundleIdentity(
    expectedIdentity,
    'candidate ZIP app bundle'
  )
  const archivePath = resolve(requiredText(zipPath, 'candidate ZIP path'))
  await validateZipCentralDirectory(archivePath, expected.bundleFilename)
  const ownerDirectory = await mkdtemp(join(tmpdir(), 'videorc-macos-d3-zip-'))
  const extracted = join(ownerDirectory, 'extracted')
  await mkdir(extracted, { mode: 0o700 })
  try {
    await extractZip(archivePath, extracted)
    const entries = await readdir(extracted, { withFileTypes: true })
    if (
      entries.length !== 1 ||
      !entries[0].isDirectory() ||
      entries[0].name !== expected.bundleFilename
    ) {
      throw candidateError(
        'candidate-zip-root',
        `Candidate ZIP must extract to exactly one ${expected.bundleFilename} directory.`
      )
    }
    const executablePath = join(
      extracted,
      expected.bundleFilename,
      ...expected.executableRelativePath.split('/')
    )
    return assertCaptureDecayAppBundleIdentityEqual(
      expected,
      await captureAppBundleIdentity(executablePath),
      'candidate ZIP app bundle'
    )
  } finally {
    await rm(ownerDirectory, { force: true, recursive: true })
  }
}

export async function validateZipCentralDirectory(zipPath, expectedBundleFilename) {
  const path = resolve(requiredText(zipPath, 'candidate ZIP path'))
  const sizeBytes = await regularFileSize(path, 'candidate ZIP', ARTIFACT_LIMITS['feed-zip'])
  const expectedRoot = `${safeFilename(expectedBundleFilename, 'candidate app bundle filename')}/`
  const handle = await open(path, 'r')
  try {
    const tailLength = Math.min(sizeBytes, 65_557)
    const tail = Buffer.alloc(tailLength)
    await readExactly(handle, tail, sizeBytes - tailLength)
    const eocdOffset = lastIndexOfSignature(tail, 0x06054b50)
    if (eocdOffset < 0 || eocdOffset + 22 > tail.length) {
      throw candidateError('candidate-zip-eocd', 'Candidate ZIP has no bounded end record.')
    }
    const disk = tail.readUInt16LE(eocdOffset + 4)
    const centralDisk = tail.readUInt16LE(eocdOffset + 6)
    const diskEntries = tail.readUInt16LE(eocdOffset + 8)
    const totalEntries = tail.readUInt16LE(eocdOffset + 10)
    const centralSize = tail.readUInt32LE(eocdOffset + 12)
    const centralOffset = tail.readUInt32LE(eocdOffset + 16)
    const commentLength = tail.readUInt16LE(eocdOffset + 20)
    if (
      disk !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== totalEntries ||
      totalEntries === 0 ||
      totalEntries === 0xffff ||
      totalEntries > 100_000 ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff ||
      centralSize > 64 * 1024 * 1024 ||
      centralOffset + centralSize > sizeBytes ||
      eocdOffset + 22 + commentLength !== tail.length
    ) {
      throw candidateError(
        'candidate-zip-layout',
        'Candidate ZIP must be one bounded non-ZIP64 archive.'
      )
    }
    const central = Buffer.alloc(centralSize)
    await readExactly(handle, central, centralOffset)
    let offset = 0
    const names = new Set()
    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
        throw candidateError(
          'candidate-zip-central',
          'Candidate ZIP central directory is malformed.'
        )
      }
      const flags = central.readUInt16LE(offset + 8)
      const filenameLength = central.readUInt16LE(offset + 28)
      const extraLength = central.readUInt16LE(offset + 30)
      const entryCommentLength = central.readUInt16LE(offset + 32)
      const localOffset = central.readUInt32LE(offset + 42)
      const end = offset + 46 + filenameLength + extraLength + entryCommentLength
      if ((flags & 1) !== 0 || filenameLength === 0 || end > central.length) {
        throw candidateError(
          'candidate-zip-entry',
          'Candidate ZIP contains an encrypted, unnamed, or truncated entry.'
        )
      }
      const nameBytes = central.subarray(offset + 46, offset + 46 + filenameLength)
      const name = decodeZipName(nameBytes)
      assertSafeZipEntry(name, expectedRoot)
      if (names.has(name)) {
        throw candidateError('candidate-zip-duplicate', `Candidate ZIP repeats entry ${name}.`)
      }
      names.add(name)
      await assertMatchingLocalZipHeader(handle, { centralName: name, localOffset, sizeBytes })
      offset = end
    }
    if (offset !== central.length) {
      throw candidateError(
        'candidate-zip-central',
        'Candidate ZIP central directory contains trailing unparsed bytes.'
      )
    }
    return [...names]
  } finally {
    await handle.close()
  }
}

export async function writeMacosD3CanonicalJsonExclusive(path, value, { mode = 0o600 } = {}) {
  const destination = resolve(requiredText(path, 'canonical JSON output path'))
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, canonicalMacosD3Json(value), {
    encoding: 'utf8',
    flag: 'wx',
    mode
  })
  return destination
}

export async function normalizeMacosD3UpdateFeedForSealing({
  candidate,
  manifestPath,
  releaseDir
}) {
  const normalizedCandidate = normalizeCandidate(candidate)
  const directory = resolve(requiredText(releaseDir, 'release directory'))
  const releaseManifestPath = resolve(manifestPath ?? join(directory, 'release.json'))
  const releaseManifest = parseCanonicalJson(
    await readUtf8File(releaseManifestPath, 'release manifest'),
    'release manifest'
  )
  validateReleaseManifest(releaseManifest, normalizedCandidate)

  const zipFilename = `${normalizedCandidate.dmgFilename.slice(0, -'.dmg'.length)}.zip`
  const zipPath = join(directory, zipFilename)
  const dmgPath = join(directory, normalizedCandidate.dmgFilename)
  const feedPath = join(directory, 'latest-mac.yml')
  const zipSizeBytes = await regularFileSize(zipPath, 'feed-zip', ARTIFACT_LIMITS['feed-zip'])
  const dmgSizeBytes = await regularFileSize(dmgPath, 'dmg', ARTIFACT_LIMITS.dmg)
  if (
    dmgSizeBytes !== normalizedCandidate.dmgSizeBytes ||
    (await sha256File(dmgPath)) !== normalizedCandidate.dmgSha256
  ) {
    throw candidateError(
      'candidate-artifact-mismatch',
      'Candidate DMG changed before update-feed normalization.'
    )
  }
  await regularFileSize(feedPath, 'feed-manifest', ARTIFACT_LIMITS['feed-manifest'])
  const zipSha512 = await sha512File(zipPath)
  const dmgSha512 = await sha512File(dmgPath)

  let feed
  try {
    feed = loadYaml(await readUtf8File(feedPath, 'macOS update feed'), { schema: JSON_SCHEMA })
  } catch (cause) {
    throw candidateErrorWithCause(
      'candidate-feed-yaml',
      'latest-mac.yml is not strict valid YAML.',
      cause
    )
  }
  assertExactKeys(feed, ['files', 'path', 'releaseDate', 'sha512', 'version'], 'macOS update feed')
  if (!Array.isArray(feed.files) || ![1, 2].includes(feed.files.length)) {
    throw candidateError(
      'candidate-feed-files',
      'Electron Builder latest-mac.yml must list the update ZIP and at most the sealed DMG.'
    )
  }
  const expectedFiles = new Map([
    [zipFilename, { sha512: zipSha512, size: zipSizeBytes }],
    [normalizedCandidate.dmgFilename, { sha512: dmgSha512, size: dmgSizeBytes }]
  ])
  const seen = new Set()
  for (const file of feed.files) {
    assertExactKeys(file, ['sha512', 'size', 'url'], 'macOS update feed file')
    const filename = safeFilename(file.url, 'macOS update feed file URL')
    const expected = expectedFiles.get(filename)
    if (
      !expected ||
      seen.has(filename) ||
      file.sha512 !== expected.sha512 ||
      file.size !== expected.size
    ) {
      throw candidateError(
        'candidate-feed-files',
        'latest-mac.yml contains an unsealed, duplicate, or mismatched update artifact.'
      )
    }
    seen.add(filename)
  }
  if (
    !seen.has(zipFilename) ||
    (feed.files.length === 2 && !seen.has(normalizedCandidate.dmgFilename)) ||
    feed.version !== requireVersion(releaseManifest.bundleVersion) ||
    feed.path !== zipFilename ||
    feed.sha512 !== zipSha512 ||
    !Number.isFinite(Date.parse(feed.releaseDate))
  ) {
    throw candidateError(
      'candidate-feed-mismatch',
      'latest-mac.yml must bind the sealed ZIP, optional sealed DMG, version, and release date.'
    )
  }

  const releaseDate = new Date(feed.releaseDate).toISOString()
  const canonical = [
    `version: ${releaseManifest.bundleVersion}`,
    'files:',
    `  - url: ${zipFilename}`,
    `    sha512: '${zipSha512}'`,
    `    size: ${zipSizeBytes}`,
    `path: ${zipFilename}`,
    `sha512: '${zipSha512}'`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
  validateMacosUpdateFeed(canonical, {
    bundleVersion: releaseManifest.bundleVersion,
    zipFilename,
    zipSha512,
    zipSizeBytes
  })

  const temporary = join(dirname(feedPath), `.${basename(feedPath)}.d3-${randomUUID()}`)
  try {
    await writeFile(temporary, canonical, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, feedPath)
  } catch (cause) {
    throw candidateErrorWithCause(
      'candidate-feed-normalize',
      'Could not atomically normalize latest-mac.yml for sealed publication.',
      cause
    )
  } finally {
    await unlink(temporary).catch(() => {})
  }
  await regularFileSize(feedPath, 'feed-manifest', ARTIFACT_LIMITS['feed-manifest'])
  return { feedPath, normalized: true, zipFilename }
}

async function validateReleasePayloadSemantics({ artifacts, candidate, releaseManifest }) {
  const sidecar = await readUtf8File(artifactByLabel(artifacts, 'sha256').path, 'DMG checksum')
  if (sidecar !== `${candidate.dmgSha256}  ${candidate.dmgFilename}\n`) {
    throw candidateError(
      'candidate-checksum',
      'Candidate DMG checksum sidecar does not exactly match the tested DMG.'
    )
  }
  const zip = artifactByLabel(artifacts, 'feed-zip')
  const feedText = await readUtf8File(
    artifactByLabel(artifacts, 'feed-manifest').path,
    'macOS update feed'
  )
  validateMacosUpdateFeed(feedText, {
    bundleVersion: releaseManifest.bundleVersion,
    zipFilename: zip.filename,
    zipSha512: await sha512File(zip.path),
    zipSizeBytes: zip.sizeBytes
  })
}

export function validateMacosUpdateFeed(
  feedText,
  { bundleVersion, zipFilename, zipSha512, zipSizeBytes }
) {
  let feed
  try {
    feed = loadYaml(feedText, { schema: JSON_SCHEMA })
  } catch {
    throw candidateError('candidate-feed-yaml', 'latest-mac.yml is not strict valid YAML.')
  }
  assertExactKeys(feed, ['files', 'path', 'releaseDate', 'sha512', 'version'], 'macOS update feed')
  if (!Array.isArray(feed.files) || feed.files.length !== 1) {
    throw candidateError('candidate-feed-files', 'latest-mac.yml must list exactly one update ZIP.')
  }
  const file = feed.files[0]
  assertExactKeys(file, ['sha512', 'size', 'url'], 'macOS update feed file')
  const expectedFilename = safeFilename(zipFilename, 'update ZIP filename')
  if (
    feed.version !== requireVersion(bundleVersion) ||
    feed.path !== expectedFilename ||
    file.url !== expectedFilename ||
    feed.sha512 !== zipSha512 ||
    file.sha512 !== zipSha512 ||
    file.size !== zipSizeBytes ||
    !Number.isFinite(Date.parse(feed.releaseDate))
  ) {
    throw candidateError(
      'candidate-feed-mismatch',
      'latest-mac.yml must exactly bind the sealed update ZIP version, SHA-512, and byte size.'
    )
  }
  return feed
}

function validateReleaseManifest(manifest, candidate) {
  assertExactKeys(manifest, RELEASE_MANIFEST_FIELDS, 'macOS release manifest')
  const releaseId = requireReleaseId(manifest.releaseId)
  const bundleVersion = requireVersion(manifest.bundleVersion)
  if (
    manifest.product !== 'Videorc' ||
    manifest.channel !== 'beta' ||
    manifest.platform !== 'macos' ||
    !['arm64', 'universal'].includes(manifest.architecture) ||
    manifest.filename !== candidate.dmgFilename ||
    manifest.sha256 !== candidate.dmgSha256 ||
    manifest.sizeBytes !== candidate.dmgSizeBytes ||
    manifest.objectKey !== `releases/macos/${releaseId}/${candidate.dmgFilename}` ||
    !requiredText(manifest.displayVersion, 'release display version') ||
    !requiredText(manifest.minimumMacOS, 'minimum macOS') ||
    !safeHttpsUrl(manifest.releaseNotesUrl) ||
    !Number.isFinite(Date.parse(manifest.releasedAt)) ||
    !candidate.dmgFilename.includes(`-${bundleVersion}-mac-`)
  ) {
    throw candidateError(
      'candidate-release-manifest',
      'release.json does not exactly identify the tested signed DMG and release coordinates.'
    )
  }
  return manifest
}

function normalizeCandidate(candidate) {
  const appBundle = normalizeCaptureDecayAppBundleIdentity(
    candidate?.appBundle,
    'candidate app bundle'
  )
  const executableFilename = safeFilename(
    candidate?.executableFilename,
    'candidate executable filename'
  )
  const dmgFilename = safeFilename(candidate?.dmgFilename, 'candidate DMG filename')
  if (
    !dmgFilename.endsWith('.dmg') ||
    basename(appBundle.executableRelativePath) !== executableFilename
  ) {
    throw candidateError(
      'candidate-artifact-name',
      'Candidate artifact filenames do not match the bound app bundle.'
    )
  }
  return {
    sourceCommit: requireCommit(candidate?.sourceCommit, 'candidate source commit'),
    sourceTree: requireGitObject(candidate?.sourceTree, 'candidate source tree'),
    executableSha256: requireSha256(candidate?.executableSha256, 'candidate executable SHA-256'),
    executableSizeBytes: positiveSafeInteger(
      candidate?.executableSizeBytes,
      'candidate executable size'
    ),
    dmgSha256: requireSha256(candidate?.dmgSha256, 'candidate DMG SHA-256'),
    dmgSizeBytes: positiveSafeInteger(candidate?.dmgSizeBytes, 'candidate DMG size'),
    executableFilename,
    dmgFilename,
    appBundle
  }
}

function normalizeCandidateArtifactBindings(values, prefix) {
  if (!Array.isArray(values) || values.length !== MACOS_D3_CANDIDATE_ARTIFACT_LABELS.length) {
    throw candidateError(
      'candidate-artifact-set',
      'Sealed candidate requires exactly six ordered release artifacts.'
    )
  }
  const filenames = new Set()
  const objectKeys = new Set()
  return values.map((value, index) => {
    const label = MACOS_D3_CANDIDATE_ARTIFACT_LABELS[index]
    const binding = normalizeCandidateArtifactBinding(value, { expectedLabel: label })
    if (filenames.has(binding.filename) || objectKeys.has(binding.objectKey)) {
      throw candidateError(
        'candidate-artifact-duplicate',
        'Sealed candidate repeats an artifact filename or object key.'
      )
    }
    if (binding.objectKey !== `${prefix}/artifacts/${binding.filename}`) {
      throw candidateError(
        'candidate-artifact-route',
        `Sealed ${label} object key is not derived from the candidate prefix.`
      )
    }
    filenames.add(binding.filename)
    objectKeys.add(binding.objectKey)
    return binding
  })
}

function normalizeCandidateArtifactBinding(
  value,
  { allowPublicationEvidence = false, expectedLabel } = {}
) {
  const baseKeys = ['contentType', 'filename', 'label', 'objectKey', 'sha256', 'sizeBytes']
  assertExactKeys(
    value,
    allowPublicationEvidence ? [...baseKeys, 'action', 'verification'] : baseKeys,
    `${expectedLabel ?? 'candidate'} artifact`
  )
  const label = requiredText(value?.label, 'candidate artifact label')
  if (expectedLabel && label !== expectedLabel) {
    throw candidateError(
      'candidate-artifact-order',
      `Expected sealed artifact ${expectedLabel}, got ${label}.`
    )
  }
  const maxBytes = ARTIFACT_LIMITS[label]
  if (!maxBytes) {
    throw candidateError('candidate-artifact-label', `Unsupported sealed artifact label ${label}.`)
  }
  const normalized = {
    label,
    filename: safeFilename(value?.filename, `${label} filename`),
    objectKey: safeObjectKey(value?.objectKey, `${label} object key`),
    contentType: exactContentType(value?.contentType, label),
    sha256: requireSha256(value?.sha256, `${label} SHA-256`),
    sizeBytes: boundedPositiveSize(value?.sizeBytes, `${label} size`, maxBytes)
  }
  if (!allowPublicationEvidence) return normalized
  const action = requiredText(value?.action, `${label} publication action`)
  if (!['uploaded', 'reused'].includes(action)) {
    throw candidateError(
      'candidate-seal-action',
      `Candidate seal action for ${label} must be uploaded or reused.`
    )
  }
  assertExactKeys(
    value.verification,
    ['etag', 'sha256', 'sizeBytes', 'state'],
    `${label} verification`
  )
  return {
    ...normalized,
    action,
    verification: {
      state: value.verification?.state === 'identical' ? 'identical' : invalidVerification(label),
      sha256: requireSha256(value.verification?.sha256, `${label} verified SHA-256`),
      sizeBytes: boundedPositiveSize(
        value.verification?.sizeBytes,
        `${label} verified size`,
        maxBytes
      ),
      etag: safeEtag(value.verification?.etag)
    }
  }
}

function candidateArtifactBinding(artifact) {
  return normalizeCandidateArtifactBinding({
    label: artifact.label,
    filename: artifact.filename,
    objectKey: artifact.objectKey,
    contentType: artifact.contentType,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  })
}

function normalizeUploadArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) {
    throw candidateError('candidate-upload-plan', 'Candidate upload plan must be an array.')
  }
  const normalized = artifacts.map((artifact, index) =>
    normalizeUploadArtifact(artifact, MACOS_D3_CANDIDATE_ARTIFACT_LABELS[index])
  )
  assertExactArtifactSet(normalized)
  return normalized
}

function normalizeUploadArtifact(artifact, expectedLabel) {
  const binding = normalizeCandidateArtifactBinding(
    {
      label: artifact?.label,
      filename: artifact?.filename,
      objectKey: artifact?.objectKey,
      contentType: artifact?.contentType,
      sha256: artifact?.sha256,
      sizeBytes: artifact?.sizeBytes
    },
    { expectedLabel }
  )
  if (artifact?.immutable !== true) {
    throw candidateError('candidate-upload-mutability', `${binding.label} must be immutable.`)
  }
  const maxBytes = ARTIFACT_LIMITS[binding.label]
  if (artifact.body !== undefined) {
    if (!(artifact.body instanceof Uint8Array)) {
      throw candidateError('candidate-upload-body', `${binding.label} body must be bytes.`)
    }
    if (
      artifact.body.byteLength !== binding.sizeBytes ||
      sha256Bytes(artifact.body) !== binding.sha256
    ) {
      throw candidateError(
        'candidate-upload-body',
        `${binding.label} body does not match its hash.`
      )
    }
  } else {
    requiredText(artifact?.path, `${binding.label} local path`)
  }
  return {
    ...artifact,
    ...binding,
    immutable: true,
    maxBytes
  }
}

function normalizeExpectedManifestDescriptor(value) {
  assertExactKeys(value, ['objectKey', 'sha256', 'sizeBytes'], 'expected candidate manifest')
  return {
    objectKey: safeObjectKey(value?.objectKey, 'expected candidate manifest object key'),
    sha256: requireSha256(value?.sha256, 'expected candidate manifest SHA-256'),
    sizeBytes: boundedPositiveSize(
      value?.sizeBytes,
      'expected candidate manifest size',
      ARTIFACT_LIMITS['candidate-manifest']
    )
  }
}

function normalizeUploadRouteContentType(value) {
  return requiredText(value, 'remote content type')
    .toLowerCase()
    .replace(/[ \t]+/g, ' ')
}

function assertRemoteHeaders(headers, artifact, { verifyChecksum = true } = {}) {
  const contentLengthText = headers.get('content-length')
  const contentLength = Number(contentLengthText)
  const metadataSha256 = headers.get('x-amz-meta-videorc-sha256')?.trim().toLowerCase()
  const contentType = normalizeUploadRouteContentType(headers.get('content-type'))
  const checksum = headers.get('x-amz-checksum-sha256')?.trim()
  if (
    !contentLengthText ||
    !Number.isSafeInteger(contentLength) ||
    contentLength !== artifact.sizeBytes ||
    contentLength > artifact.maxBytes
  ) {
    throw candidateError(
      'candidate-remote-content-length',
      `Sealed candidate object ${artifact.objectKey} returned an unsafe Content-Length.`
    )
  }
  if (metadataSha256 !== artifact.sha256) {
    throw candidateError(
      'candidate-remote-metadata',
      `Sealed candidate object ${artifact.objectKey} is missing its exact SHA-256 metadata.`
    )
  }
  if (contentType !== normalizeUploadRouteContentType(artifact.contentType)) {
    throw candidateError(
      'candidate-remote-content-type',
      `Sealed candidate object ${artifact.objectKey} returned the wrong Content-Type.`
    )
  }
  if (verifyChecksum && checksum && checksum !== sha256Base64FromHex(artifact.sha256)) {
    throw candidateError(
      'candidate-remote-checksum',
      `Sealed candidate object ${artifact.objectKey} returned the wrong checksum metadata.`
    )
  }
  return { contentLength, etag: safeEtag(headers.get('etag')) }
}

async function downloadRemoteArtifact({ artifact, config, destination, transport }) {
  const normalized = normalizeUploadArtifact(
    { ...artifact, path: destination, immutable: true },
    artifact.label
  )
  await requireMissingPath(destination)
  const signed = buildSignedS3Request({
    config,
    method: 'GET',
    objectKey: normalized.objectKey
  })
  const response = await transport.request(signed.url, {
    headers: { ...signed.headers, 'accept-encoding': 'identity' },
    method: 'GET'
  })
  if (!response.ok || !response.body) {
    await discardRemoteBody(response.body)
    throw candidateError(
      'candidate-download-read',
      `Could not download sealed candidate object ${normalized.objectKey}: HTTP ${response.status}.`
    )
  }
  assertRemoteHeaders(response.headers, normalized)
  const temporary = `${destination}.part`
  const hash = createHash('sha256')
  let sizeBytes = 0
  const limiter = new TransformHashStream({
    hash,
    maxBytes: normalized.sizeBytes,
    onBytes: (value) => {
      sizeBytes = value
    }
  })
  try {
    await pipeline(
      Readable.from(response.body),
      limiter,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    )
    const sha256 = hash.digest('hex')
    if (sizeBytes !== normalized.sizeBytes || sha256 !== normalized.sha256) {
      throw candidateError(
        'candidate-download-bytes',
        `Downloaded candidate object ${normalized.objectKey} failed exact byte verification.`
      )
    }
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

class TransformHashStream extends Transform {
  constructor({ hash, maxBytes, onBytes }) {
    super()
    this.hash = hash
    this.maxBytes = maxBytes
    this.onBytes = onBytes
    this.sizeBytes = 0
  }

  _transform(chunk, _encoding, callback) {
    this.sizeBytes += chunk.byteLength
    this.onBytes(this.sizeBytes)
    if (this.sizeBytes > this.maxBytes) {
      callback(candidateError('candidate-download-size', 'Candidate download exceeded its bound.'))
      return
    }
    this.hash.update(chunk)
    callback(null, chunk)
  }
}

class BoundedCandidateReadStream extends Transform {
  constructor({ artifact }) {
    super()
    this.artifact = artifact
    this.sizeBytes = 0
  }

  _transform(chunk, _encoding, callback) {
    this.sizeBytes += chunk.byteLength
    if (this.sizeBytes > this.artifact.maxBytes || this.sizeBytes > this.artifact.sizeBytes) {
      callback(
        candidateError(
          'candidate-remote-size',
          `Sealed candidate object ${this.artifact.objectKey} exceeded its exact size bound.`
        )
      )
      return
    }
    callback(null, chunk)
  }
}

function boundedPublicationTransport(transport, artifact) {
  return {
    async request(url, options) {
      const response = await transport.request(url, options)
      if (options?.method !== 'GET' || !response.ok || !response.body) return response
      assertRemoteHeaders(response.headers, artifact, { verifyChecksum: false })
      const boundedBody = new BoundedCandidateReadStream({ artifact })
      boundedBody.once('error', () => response.body.destroy?.())
      return {
        ...response,
        body: Readable.from(response.body).pipe(boundedBody)
      }
    },
    close() {
      // The stage owns and closes the shared underlying transport exactly once.
    }
  }
}

async function ensureEmptyOwnedDirectory(path) {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw candidateError(
        'candidate-output-directory',
        'Candidate output path must be a real empty directory.'
      )
    }
    if ((await readdir(path)).length !== 0) {
      throw candidateError(
        'candidate-output-not-empty',
        'Candidate output directory must be empty; existing files are never replaced.'
      )
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(path, { mode: 0o700 })
  }
}

async function requireMissingPath(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw candidateError('candidate-output-exists', `Refusing to replace candidate file ${path}.`)
}

async function extractZipWithDitto(zipPath, outputDirectory) {
  if (process.platform !== 'darwin') {
    throw candidateError(
      'candidate-zip-platform',
      'Production candidate ZIP verification requires the macOS owner or promotion host.'
    )
  }
  try {
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', '--', zipPath, outputDirectory], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    })
  } catch (cause) {
    const error = candidateError('candidate-zip-extract', 'Could not extract candidate ZIP safely.')
    error.cause = cause
    throw error
  }
}

async function assertMatchingLocalZipHeader(handle, { centralName, localOffset, sizeBytes }) {
  if (!Number.isSafeInteger(localOffset) || localOffset < 0 || localOffset + 30 > sizeBytes) {
    throw candidateError(
      'candidate-zip-local-header',
      'Candidate ZIP local header offset is unsafe.'
    )
  }
  const header = Buffer.alloc(30)
  await readExactly(handle, header, localOffset)
  if (header.readUInt32LE(0) !== 0x04034b50) {
    throw candidateError('candidate-zip-local-header', 'Candidate ZIP local header is malformed.')
  }
  const filenameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  if (
    filenameLength === 0 ||
    localOffset + 30 + filenameLength + extraLength > sizeBytes ||
    filenameLength > 4096
  ) {
    throw candidateError('candidate-zip-local-header', 'Candidate ZIP local filename is unsafe.')
  }
  const filename = Buffer.alloc(filenameLength)
  await readExactly(handle, filename, localOffset + 30)
  if (decodeZipName(filename) !== centralName) {
    throw candidateError(
      'candidate-zip-header-mismatch',
      'Candidate ZIP central and local filenames do not match.'
    )
  }
}

function assertSafeZipEntry(name, expectedRoot) {
  if (
    !name.startsWith(expectedRoot) ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /[\0-\x1f\x7f]/.test(name) ||
    name
      .split('/')
      .some((part, index, parts) =>
        index === parts.length - 1 && part === '' ? false : !part || part === '.' || part === '..'
      )
  ) {
    throw candidateError(
      'candidate-zip-entry-path',
      `Candidate ZIP entry is unsafe or outside ${expectedRoot}`
    )
  }
}

function decodeZipName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw candidateError('candidate-zip-filename', 'Candidate ZIP contains a non-UTF-8 filename.')
  }
}

async function readExactly(handle, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    )
    if (bytesRead === 0) {
      throw candidateError('candidate-file-truncated', 'Candidate file ended unexpectedly.')
    }
    offset += bytesRead
  }
}

function lastIndexOfSignature(buffer, signature) {
  for (let index = buffer.length - 4; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === signature) return index
  }
  return -1
}

function assertPlanMatchesManifest(artifacts, manifest) {
  const bindings = artifacts.map(candidateArtifactBinding)
  if (JSON.stringify(bindings) !== JSON.stringify(manifest.release.artifacts)) {
    throw candidateError(
      'candidate-upload-plan',
      'Candidate upload plan does not match the canonical sealed manifest.'
    )
  }
}

function assertDocumentMatchesSealedCandidate(document, sealedCandidate) {
  const receipt = sealedCandidate.sealReceipt.document
  if (JSON.stringify(document) !== JSON.stringify(receipt.candidateManifest)) {
    throw candidateError(
      'candidate-seal-document-mismatch',
      'Downloaded candidate manifest does not equal the reviewed seal receipt identity.'
    )
  }
}

function storageIdentityFromManifest(document) {
  return {
    bucket: document.storage.bucket,
    endpointUrl: document.storage.endpointUrl,
    forcePathStyle: document.storage.forcePathStyle,
    region: document.storage.region,
    tlsPolicy: document.storage.tlsPolicy
  }
}

function assertExactArtifactSet(artifacts) {
  if (
    artifacts.length !== MACOS_D3_CANDIDATE_ARTIFACT_LABELS.length ||
    artifacts.some(
      (artifact, index) => artifact.label !== MACOS_D3_CANDIDATE_ARTIFACT_LABELS[index]
    )
  ) {
    throw candidateError(
      'candidate-artifact-set',
      'Candidate artifact set must contain the exact ordered six release artifacts.'
    )
  }
  const filenames = new Set()
  const keys = new Set()
  for (const artifact of artifacts) {
    if (filenames.has(artifact.filename) || keys.has(artifact.objectKey)) {
      throw candidateError(
        'candidate-artifact-duplicate',
        'Candidate artifact set repeats a filename or object key.'
      )
    }
    filenames.add(artifact.filename)
    keys.add(artifact.objectKey)
  }
}

function assertArtifactMatchesCandidate(artifacts, candidate) {
  const dmg = artifactByLabel(artifacts, 'dmg')
  if (
    dmg.filename !== candidate.dmgFilename ||
    dmg.sha256 !== candidate.dmgSha256 ||
    dmg.sizeBytes !== candidate.dmgSizeBytes
  ) {
    throw candidateError(
      'candidate-dmg-mismatch',
      'Local release DMG does not equal the owner-tested candidate identity.'
    )
  }
}

function artifactByLabel(artifacts, label) {
  const artifact = artifacts.find((entry) => entry.label === label)
  if (!artifact) throw candidateError('candidate-artifact-missing', `Missing ${label} artifact.`)
  return artifact
}

function artifactSnapshot(artifacts) {
  return new Map(
    artifacts.map((artifact) => [
      artifact.label,
      { sha256: artifact.sha256, sizeBytes: artifact.sizeBytes }
    ])
  )
}

async function assertArtifactSnapshotUnchanged(artifacts, snapshot, phase) {
  for (const artifact of artifacts) {
    const before = snapshot.get(artifact.label)
    const sizeBytes = await regularFileSize(
      artifact.path,
      artifact.label,
      artifact.maxBytes ?? ARTIFACT_LIMITS[artifact.label]
    )
    const sha256 = await sha256File(artifact.path)
    if (!before || before.sizeBytes !== sizeBytes || before.sha256 !== sha256) {
      throw candidateError(
        'candidate-artifact-mutated',
        `Candidate ${artifact.label} changed during ${phase}.`
      )
    }
  }
}

function macosD3PublicationVerificationDescriptor(sealedCandidate) {
  const document = sealedCandidate.sealReceipt.document.candidateManifest
  return {
    schemaVersion: 1,
    profile: MACOS_D3_PUBLICATION_VERIFICATION_PROFILE,
    sealedCandidateBindingSha256: macosD3SealedCandidateBindingSha256(sealedCandidate),
    artifactSetSha256: sealedCandidate.artifactSetSha256,
    files: [
      {
        label: 'candidate-manifest',
        filename: MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
        sha256: sealedCandidate.manifest.sha256,
        sizeBytes: sealedCandidate.manifest.sizeBytes
      },
      {
        label: 'candidate-seal-receipt',
        filename: MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME,
        sha256: sealedCandidate.sealReceipt.sha256,
        sizeBytes: sealedCandidate.sealReceipt.sizeBytes
      },
      ...document.release.artifacts.map(({ filename, label, sha256, sizeBytes }) => ({
        label,
        filename,
        sha256,
        sizeBytes
      }))
    ]
  }
}

function publicationVerificationFileDescriptor(descriptor) {
  const bytes = Buffer.from(canonicalMacosD3Json(descriptor))
  if (bytes.byteLength > ARTIFACT_LIMITS['publication-verification']) {
    throw candidateError(
      'candidate-publication-verification-size',
      'Candidate publication verification descriptor exceeds its bound.'
    )
  }
  return {
    label: 'publication-verification',
    filename: MACOS_D3_PUBLICATION_VERIFICATION_FILENAME,
    sha256: sha256Bytes(bytes),
    sizeBytes: bytes.byteLength
  }
}

async function requireRealCandidateDirectory(value) {
  const directory = resolve(requiredText(value, 'candidate directory'))
  let directoryStat
  try {
    directoryStat = await lstat(directory)
  } catch (cause) {
    throw candidateErrorWithCause(
      'candidate-directory',
      'Candidate directory must exist as a real directory.',
      cause
    )
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw candidateError('candidate-directory', 'Candidate directory must be a real directory.')
  }
  return directory
}

function requirePublicationVerificationDescriptorPath(value, directory) {
  const path = resolve(requiredText(value, 'candidate publication verification descriptor path'))
  if (
    dirname(path) !== directory ||
    basename(path) !== MACOS_D3_PUBLICATION_VERIFICATION_FILENAME
  ) {
    throw candidateError(
      'candidate-publication-verification-path',
      `Candidate publication verification descriptor must be ${MACOS_D3_PUBLICATION_VERIFICATION_FILENAME} inside the candidate directory.`
    )
  }
  return path
}

async function assertCandidateDirectoryContents(directory, files) {
  const expectedNames = new Set(files.map((file) => file.filename))
  if (expectedNames.size !== files.length) {
    throw candidateError(
      'candidate-publication-verification-files',
      'Candidate publication verification repeats a filename.'
    )
  }
  const entries = await readdir(directory, { withFileTypes: true })
  if (
    entries.length !== expectedNames.size ||
    entries.some((entry) => !entry.isFile() || !expectedNames.has(entry.name))
  ) {
    throw candidateError(
      'candidate-directory-contents',
      'Candidate directory must contain exactly the verification descriptor, sealed manifest, seal receipt, and six regular payload files.'
    )
  }
}

async function verifyMacosD3PublicationCandidateFiles({ directory, files }) {
  for (const file of files) {
    const maxBytes = ARTIFACT_LIMITS[file.label]
    if (!maxBytes) {
      throw candidateError(
        'candidate-publication-verification-files',
        `Candidate publication verification contains unsupported file label ${file.label}.`
      )
    }
    await verifyExactRegularFileNoFollow({
      expectedSha256: file.sha256,
      expectedSizeBytes: file.sizeBytes,
      label: file.label,
      maxBytes,
      path: join(directory, file.filename)
    })
  }
}

async function verifyExactRegularFileNoFollow({
  expectedSha256,
  expectedSizeBytes,
  label,
  maxBytes,
  path
}) {
  if (!Number.isSafeInteger(constants.O_NOFOLLOW)) {
    throw candidateError(
      'candidate-publication-verification-nofollow',
      'Candidate publication verification requires native O_NOFOLLOW support.'
    )
  }
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (cause) {
    throw candidateErrorWithCause(
      'candidate-publication-verification-file',
      `Candidate publication ${label} could not be opened without following links.`,
      cause
    )
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.size !== BigInt(expectedSizeBytes) ||
      expectedSizeBytes <= 0 ||
      expectedSizeBytes > maxBytes
    ) {
      throw candidateError(
        'candidate-publication-verification-file',
        `Candidate publication ${label} is not its exact bounded regular file.`
      )
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let sizeBytes = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      sizeBytes += bytesRead
      if (sizeBytes > expectedSizeBytes || sizeBytes > maxBytes) {
        throw candidateError(
          'candidate-publication-verification-file',
          `Candidate publication ${label} exceeded its exact byte bound.`
        )
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      sizeBytes !== expectedSizeBytes ||
      hash.digest('hex') !== expectedSha256
    ) {
      throw candidateError(
        'candidate-publication-verification-file',
        `Candidate publication ${label} changed or does not match its verified descriptor.`
      )
    }
  } finally {
    await handle.close()
  }
}

async function regularFileSize(path, label, maxBytes) {
  let info
  try {
    info = await lstat(path)
  } catch {
    throw candidateError('candidate-file-missing', `Missing candidate ${label}.`)
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) {
    throw candidateError(
      'candidate-file-type',
      `Candidate ${label} must be a bounded non-empty regular file.`
    )
  }
  return info.size
}

async function sha256File(path) {
  return hashFile(path, 'sha256', 'hex')
}

async function sha512File(path) {
  return hashFile(path, 'sha512', 'base64')
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}

async function discardRemoteBody(body) {
  if (!body) return
  try {
    for await (const _chunk of body) {
      // Drain bounded error bodies so the explicit transport can close cleanly.
    }
  } catch {
    // The primary HTTP error remains the actionable failure.
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readUtf8File(path, label) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch {
    throw candidateError('candidate-file-read', `Could not read candidate ${label}.`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw candidateError('candidate-file-utf8', `Candidate ${label} is not valid UTF-8.`)
  }
}

function parseCanonicalJson(text, label) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw candidateError('candidate-json', `Candidate ${label} is not valid JSON.`)
  }
  if (text !== canonicalMacosD3Json(value)) {
    throw candidateError('candidate-json-canonical', `Candidate ${label} is not canonical JSON.`)
  }
  return value
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw candidateError('candidate-schema', `${label} must be an object.`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw candidateError('candidate-schema', `${label} has unexpected or missing fields.`)
  }
}

function safeObjectKey(value, label) {
  const objectKey = requiredText(value, label)
  if (
    objectKey.startsWith('/') ||
    objectKey.includes('\\') ||
    /[\0-\x1f\x7f]/.test(objectKey) ||
    objectKey
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || !safeSegment(part))
  ) {
    throw candidateError('candidate-object-key', `${label} is unsafe.`)
  }
  return objectKey
}

function safeFilename(value, label) {
  const filename = requiredText(value, label)
  if (filename !== basename(filename) || !safeSegment(filename)) {
    throw candidateError('candidate-filename', `${label} must be one safe basename.`)
  }
  return filename
}

function safeSegment(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
}

function safeStorageName(value, label) {
  const text = requiredText(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw candidateError('candidate-storage-name', `${label} is unsafe.`)
  }
  return text
}

function normalizeTlsPolicy(value) {
  assertExactKeys(
    value,
    ['allowedIssuerOrganizations', 'allowedSpkiSha256'],
    'candidate storage TLS policy'
  )
  const allowedIssuerOrganizations = normalizeDistinctSafeTexts(
    value.allowedIssuerOrganizations,
    'candidate TLS issuer organization',
    200
  )
  const allowedSpkiSha256 = normalizeDistinctSafeTexts(
    value.allowedSpkiSha256,
    'candidate TLS SPKI SHA-256',
    64
  ).map((digest) => requireSha256(digest.toLowerCase(), 'candidate TLS SPKI SHA-256'))
  if (allowedIssuerOrganizations.length === 0 && allowedSpkiSha256.length === 0) {
    throw candidateError(
      'candidate-tls-policy',
      'Candidate storage requires an issuer-organization or SPKI SHA-256 allowlist.'
    )
  }
  return { allowedIssuerOrganizations, allowedSpkiSha256 }
}

function normalizeDistinctSafeTexts(value, label, maxLength) {
  if (!Array.isArray(value)) {
    throw candidateError('candidate-tls-policy', `${label} allowlist must be an array.`)
  }
  const entries = value.map((entry) => {
    const text = requiredText(entry, label)
    if (text.length > maxLength) {
      throw candidateError('candidate-tls-policy', `${label} exceeds its length bound.`)
    }
    return text
  })
  if (new Set(entries).size !== entries.length) {
    throw candidateError('candidate-tls-policy', `${label} allowlist must be distinct.`)
  }
  return entries
}

function exactContentType(value, label) {
  const contentType = requiredText(value, `${label} content type`)
  if (contentType !== CONTENT_TYPES[label]) {
    throw candidateError('candidate-content-type', `${label} has the wrong content type.`)
  }
  return contentType
}

function requireReleaseId(value) {
  const releaseId = requiredText(value, 'candidate release id')
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(releaseId)) {
    throw candidateError(
      'candidate-release-id',
      'Candidate release id must be a numeric macOS beta identifier.'
    )
  }
  return releaseId
}

function requireVersion(value) {
  const version = requiredText(value, 'candidate bundle version')
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw candidateError('candidate-version', 'Candidate bundle version must be numeric semver.')
  }
  return version
}

function requireCommit(value, label) {
  const commit = requiredText(value, label)
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw candidateError('candidate-commit', `${label} must be a full lowercase commit.`)
  }
  return commit
}

function requireGitObject(value, label) {
  const object = requiredText(value, label)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)) {
    throw candidateError('candidate-git-object', `${label} must be a full lowercase Git object.`)
  }
  return object
}

function requireSha256(value, label) {
  const digest = requiredText(value, label)
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw candidateError('candidate-sha256', `${label} must be a lowercase SHA-256.`)
  }
  return digest
}

function boundedPositiveSize(value, label, maxBytes) {
  const size = positiveSafeInteger(value, label)
  if (size > maxBytes) throw candidateError('candidate-size', `${label} exceeds its bound.`)
  return size
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw candidateError('candidate-number', `${label} must be a positive safe integer.`)
  }
  return value
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw candidateError('candidate-value', `${label} is required and must be safe text.`)
  }
  return value.trim()
}

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label)
  const date = new Date(text)
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) {
    throw candidateError('candidate-timestamp', `${label} must be a canonical UTC timestamp.`)
  }
  return text
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(requiredText(value, 'release notes URL'))
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function safeEtag(value) {
  if (value === null || value === undefined) return null
  const etag = requiredText(value, 'candidate object ETag')
  if (etag.length > 512)
    throw candidateError('candidate-etag', 'Candidate object ETag is too long.')
  return etag
}

function invalidVerification(label) {
  throw candidateError('candidate-seal-verification', `${label} was not remotely verified.`)
}

function candidateError(code, message) {
  return new MacosD3SealedCandidateError(code, message)
}

function candidateErrorWithCause(code, message, cause) {
  const error = candidateError(code, message)
  error.cause = cause
  return error
}
