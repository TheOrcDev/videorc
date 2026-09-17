import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { readCaptureDecayEvidenceArtifact } from './capture-decay-evidence-artifact.mjs'
import {
  MACOS_D3_PUBLICATION_RESERVATION_PROFILE,
  normalizeReleaseUploadTlsPolicy
} from './release-upload-s3.mjs'

export const CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE =
  'capture-decay-d3-destination-binding-v2'
export const CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_PROFILE =
  'capture-decay-d3-publication-attestation-v3'
export const CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE =
  'capture-decay-d3-public-route-verification-v2'
export const CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY = 'TheOrcDev/videorc'
export const CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH =
  '.github/workflows/promote-macos-capture-decay-d3.yml'
export const CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW =
  'github.com/TheOrcDev/videorc/.github/workflows/promote-macos-capture-decay-d3.yml'
export const CAPTURE_DECAY_D3_DESTINATION_BINDING_ENV =
  'VIDEORC_CAPTURE_DECAY_D3_DESTINATION_BINDING_SHA256'

const MAX_GH_OUTPUT_BYTES = 4 * 1024 * 1024

export function buildCaptureDecayD3DestinationBinding({ artifacts, config, reservation }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw contractError(
      'destination-upload-plan',
      'The D3 destination binding requires a non-empty upload plan.'
    )
  }
  const immutable = []
  const pointers = []
  const objectKeys = new Set()
  for (const artifact of artifacts) {
    const route = normalizeUploadRoute(
      artifact,
      artifact?.immutable === true ? 'immutable' : 'pointer'
    )
    rejectDuplicateObjectKey(objectKeys, route.objectKey)
    if (route.immutable) immutable.push(route)
    else pointers.push(route)
  }

  const reservationRoute = normalizeReservationRoute(reservation)
  rejectDuplicateObjectKey(objectKeys, reservationRoute.objectKey)
  const destination = normalizeDestination(config)
  assertReservationDestination(reservation?.document?.destination, destination, reservationRoute)
  const document = {
    schemaVersion: 2,
    profile: CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
    destination,
    uploadPlan: [...immutable, reservationRoute, ...pointers]
  }
  return {
    profile: CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
    sha256: sha256(canonicalJson(document)),
    document
  }
}

export async function verifyCaptureDecayD3PublicationAttestation(
  { attestationBundlePath, publicationSourceCommit, receiptPath, subjectPaths },
  { env = process.env, execute = executeCommand } = {}
) {
  const sourceDigest = requireCommit(publicationSourceCommit, 'publication source commit')
  const absoluteReceiptPath = resolve(requiredText(receiptPath, 'publication receipt path'))
  const absoluteBundlePath = resolve(
    requiredText(attestationBundlePath, 'publication attestation bundle path')
  )
  if (!Array.isArray(subjectPaths) || subjectPaths.length !== 8) {
    throw contractError(
      'publication-attestation-files',
      'Publication attestation verification requires the eight sealed-candidate subjects in addition to its receipt.'
    )
  }
  const subjectAbsolutePaths = subjectPaths.map((path) =>
    resolve(requiredText(path, 'publication attestation subject path'))
  )
  if (new Set(subjectAbsolutePaths).size !== subjectAbsolutePaths.length) {
    throw contractError(
      'publication-attestation-files',
      'Publication attestation subject paths must be distinct.'
    )
  }
  const [receiptArtifact, bundleArtifact, ...subjectArtifacts] = await Promise.all([
    readAttestationArtifact(absoluteReceiptPath, 'publication receipt', true),
    readAttestationArtifact(absoluteBundlePath, 'publication attestation bundle', true),
    ...subjectAbsolutePaths.map((path, index) =>
      readAttestationArtifact(path, `publication subject ${index + 1}`, false)
    )
  ])
  if (bundleArtifact.sizeBytes > MAX_GH_OUTPUT_BYTES) {
    throw contractError(
      'publication-attestation-files',
      'Publication attestation bundle exceeds its bounded size.'
    )
  }
  const expectedSubjectSha256s = [
    receiptArtifact.sha256,
    ...subjectArtifacts.map((artifact) => artifact.sha256)
  ].sort()
  if (new Set(expectedSubjectSha256s).size !== expectedSubjectSha256s.length) {
    throw contractError(
      'publication-attestation-files',
      'Publication attestation subjects must have distinct SHA-256 identities.'
    )
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'videorc-d3-attestation-'))
  try {
    const stableReceiptPath = join(temporaryDirectory, basename(absoluteReceiptPath))
    const stableBundlePath = join(temporaryDirectory, basename(absoluteBundlePath))
    await Promise.all([
      writeFile(stableReceiptPath, receiptArtifact.bytes, { flag: 'wx', mode: 0o600 }),
      writeFile(stableBundlePath, bundleArtifact.bytes, { flag: 'wx', mode: 0o600 })
    ])
    let result
    try {
      result = await execute(
        'gh',
        [
          'attestation',
          'verify',
          stableReceiptPath,
          '--bundle',
          stableBundlePath,
          '--repo',
          CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
          '--signer-workflow',
          CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
          '--source-digest',
          sourceDigest,
          '--format',
          'json'
        ],
        { env: captureDecayPublicationAttestationEnvironment(env) }
      )
    } catch (cause) {
      const error = contractError(
        'publication-attestation-tool',
        'Could not execute gh to verify the publication attestation bundle.'
      )
      error.cause = cause
      throw error
    }
    if (result?.code !== 0 || (result?.signal !== null && result?.signal !== undefined)) {
      throw contractError(
        'publication-attestation-verification',
        `gh attestation verification failed (code ${result?.code ?? 'missing'}, signal ${result?.signal ?? 'none'}).`
      )
    }
    let verification
    try {
      verification = JSON.parse(String(result.stdout ?? ''))
    } catch {
      throw contractError(
        'publication-attestation-output',
        'gh attestation verification did not return valid JSON.'
      )
    }
    if (!Array.isArray(verification) || verification.length !== 1) {
      throw contractError(
        'publication-attestation-output',
        'gh attestation verification must return exactly one verified attestation statement.'
      )
    }
    const exactStatement = statementHasExactSubjectDigests(
      verification[0]?.verificationResult?.statement,
      expectedSubjectSha256s
    )
    if (!exactStatement) {
      throw contractError(
        'publication-attestation-subject',
        'No single verified attestation statement contains exactly the publication receipt and eight sealed-candidate subject digests.'
      )
    }
    const [receiptAfter, bundleAfter, ...subjectsAfter] = await Promise.all([
      readAttestationArtifact(absoluteReceiptPath, 'publication receipt after verification', false),
      readAttestationArtifact(
        absoluteBundlePath,
        'publication attestation bundle after verification',
        false
      ),
      ...subjectAbsolutePaths.map((path, index) =>
        readAttestationArtifact(path, `publication subject ${index + 1} after verification`, false)
      )
    ])
    const before = [receiptArtifact, bundleArtifact, ...subjectArtifacts]
    const after = [receiptAfter, bundleAfter, ...subjectsAfter]
    if (
      before.some(
        (artifact, index) =>
          artifact.sha256 !== after[index].sha256 || artifact.sizeBytes !== after[index].sizeBytes
      )
    ) {
      throw contractError(
        'publication-attestation-mutated',
        'A publication receipt, bundle, or exact-promotion subject changed while gh was verifying it.'
      )
    }
    return {
      profile: CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_PROFILE,
      repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
      signerWorkflow: CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
      sourceDigest,
      receiptSha256: receiptArtifact.sha256,
      subjectSha256s: expectedSubjectSha256s,
      bundle: {
        filename: basename(absoluteBundlePath),
        sha256: bundleArtifact.sha256,
        sizeBytes: bundleArtifact.sizeBytes,
        bodyBase64: bundleArtifact.bytes.toString('base64')
      }
    }
  } catch (cause) {
    throw cause
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

async function readAttestationArtifact(path, label, readBytes) {
  return await readCaptureDecayEvidenceArtifact({
    label,
    path,
    readBytes,
    root: resolve(path, '..')
  })
}

export function captureDecayPublicationAttestationEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !isS3CredentialEnvironmentName(name))
  )
}

async function executeCommand(command, args, { env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    const append = (target, chunk) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_GH_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk) => append(stdout, chunk))
    child.stderr.on('data', (chunk) => append(stderr, chunk))
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (outputBytes > MAX_GH_OUTPUT_BYTES) {
        rejectPromise(new Error('gh attestation verification output exceeded its bound'))
        return
      }
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
  })
}

function isS3CredentialEnvironmentName(name) {
  return name.startsWith('AWS_') || /(?:^|_)S3(?:_|$)/.test(name)
}

function normalizeUploadRoute(artifact, phase) {
  if (artifact?.immutable !== true && artifact?.immutable !== false) {
    throw contractError(
      'destination-upload-plan',
      `Upload route ${artifact?.label ?? '(unknown)'} is not classified as immutable or pointer.`
    )
  }
  if ((phase === 'immutable') !== artifact.immutable) {
    throw contractError('destination-upload-plan', 'Upload route phase is inconsistent.')
  }
  const objectKey = safeObjectKey(artifact?.objectKey, 'upload object key')
  return {
    label: requiredText(artifact?.label, 'upload label'),
    filename: basename(objectKey),
    objectKey,
    contentType: requiredText(artifact?.contentType, 'upload content type'),
    immutable: artifact.immutable,
    phase
  }
}

function normalizeReservationRoute(reservation) {
  if (
    reservation?.document?.schemaVersion !== 3 ||
    reservation?.document?.profile !== MACOS_D3_PUBLICATION_RESERVATION_PROFILE
  ) {
    throw contractError(
      'destination-reservation',
      `The destination binding requires a ${MACOS_D3_PUBLICATION_RESERVATION_PROFILE} reservation.`
    )
  }
  const artifact = reservation?.artifact
  if (artifact?.immutable !== true || artifact?.label !== 'd3-publication-reservation') {
    throw contractError(
      'destination-reservation',
      'The destination binding requires one immutable D3 publication reservation.'
    )
  }
  const objectKey = safeObjectKey(artifact?.objectKey, 'reservation object key')
  return {
    profile: MACOS_D3_PUBLICATION_RESERVATION_PROFILE,
    label: 'd3-publication-reservation',
    filename: basename(objectKey),
    objectKey,
    contentType: requiredText(artifact?.contentType, 'reservation content type'),
    immutable: true,
    phase: 'reservation'
  }
}

function normalizeDestination(config) {
  let endpointUrl = config?.endpointUrl ?? null
  if (endpointUrl !== null) {
    try {
      const url = new URL(requiredText(endpointUrl, 'destination endpoint URL'))
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('unsafe endpoint')
      }
      url.pathname = url.pathname.replace(/\/+$/, '')
      endpointUrl = url.toString()
    } catch {
      throw contractError(
        'destination-endpoint',
        'The D3 publication destination endpoint must be a credential-free HTTPS URL.'
      )
    }
  }
  return {
    bucket: requiredText(config?.bucket, 'destination bucket'),
    endpointUrl,
    forcePathStyle: config?.forcePathStyle === true,
    region: requiredText(config?.region, 'destination region'),
    tlsPolicy: normalizeDestinationTlsPolicy(config?.tlsPolicy)
  }
}

function assertReservationDestination(value, expected, reservationRoute) {
  const actual = {
    bucket: value?.bucket,
    endpointUrl: value?.endpointUrl ?? null,
    forcePathStyle: value?.forcePathStyle === true,
    region: value?.region,
    tlsPolicy: normalizeDestinationTlsPolicy(value?.tlsPolicy)
  }
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    value?.reservationObjectKey !== reservationRoute.objectKey
  ) {
    throw contractError(
      'destination-reservation',
      'The reservation destination does not match the bound publication destination and route.'
    )
  }
}

function normalizeDestinationTlsPolicy(value) {
  try {
    return normalizeReleaseUploadTlsPolicy(value)
  } catch (cause) {
    const error = contractError(
      'destination-tls-policy',
      'The D3 publication destination requires one canonical issuer-organization or SPKI SHA-256 allowlist.'
    )
    error.cause = cause
    throw error
  }
}

function statementHasExactSubjectDigests(statement, expected) {
  if (!Array.isArray(statement?.subject) || statement.subject.length !== expected.length) {
    return false
  }
  const digests = statement.subject.map((subject) => subject?.digest?.sha256)
  if (
    digests.some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) ||
    new Set(digests).size !== digests.length
  ) {
    return false
  }
  digests.sort()
  return digests.every((digest, index) => digest === expected[index])
}

function rejectDuplicateObjectKey(objectKeys, objectKey) {
  if (objectKeys.has(objectKey)) {
    throw contractError(
      'destination-upload-plan',
      `The D3 destination upload plan repeats ${objectKey}.`
    )
  }
  objectKeys.add(objectKey)
}

function safeObjectKey(value, label) {
  const objectKey = requiredText(value, label)
  if (objectKey.startsWith('/') || objectKey.split('/').some((part) => !part || part === '..')) {
    throw contractError('destination-object-key', `${label} is unsafe.`)
  }
  return objectKey
}

function requireCommit(value, label) {
  const commit = requiredText(value, label)
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw contractError('publication-source-commit', `${label} must be a full lowercase commit.`)
  }
  return commit
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw contractError('publication-missing-value', `${label} is required.`)
  }
  return value.trim()
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function contractError(code, message) {
  const error = new Error(message)
  error.name = 'CaptureDecayPublicationContractError'
  error.code = code
  return error
}
