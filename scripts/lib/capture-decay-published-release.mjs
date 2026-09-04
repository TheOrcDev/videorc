import { CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE } from './capture-decay-publication-attestation.mjs'
import { assertCaptureDecayD3PublicationReceipt } from './capture-decay-release-acceptance.mjs'
import {
  createReleaseUploadS3Transport,
  getReleaseUploadS3Config,
  inspectReleaseUploadArtifact,
  normalizeReleaseUploadTlsPolicy,
  sha256Base64FromHex
} from './release-upload-s3.mjs'

const PUBLIC_ROUTE_READ_PROTOCOL = 's3-sigv4-get'
const PUBLIC_ROUTE_READ_S3_PREFIX = 'VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_'
const WRITER_S3_CREDENTIAL_NAMES = Object.freeze([
  'VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID',
  'VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY',
  'VIDEORC_RELEASE_UPLOAD_S3_SESSION_TOKEN',
  'VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID',
  'VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY',
  'VIDEORC_DOWNLOAD_S3_SESSION_TOKEN'
])

export class CaptureDecayD3PublishedReleaseError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CaptureDecayD3PublishedReleaseError'
    this.code = code
  }
}

export function getCaptureDecayD3PublicRouteReadS3Config(env = process.env) {
  const writerCredentials = WRITER_S3_CREDENTIAL_NAMES.filter((name) =>
    hasEnvironmentValue(env[name])
  )
  if (writerCredentials.length > 0) {
    throw publishedReleaseError(
      'publication-route-writer-credentials',
      `D3 satisfaction refuses publication-writer credentials: ${writerCredentials.join(', ')}.`
    )
  }

  const readEnvironment = {}
  for (const suffix of [
    'ACCESS_KEY_ID',
    'BUCKET',
    'ENDPOINT_URL',
    'FORCE_PATH_STYLE',
    'REGION',
    'SECRET_ACCESS_KEY',
    'SESSION_TOKEN',
    'TLS_ALLOWED_ISSUER_ORGANIZATIONS',
    'TLS_ALLOWED_SPKI_SHA256'
  ]) {
    readEnvironment[`VIDEORC_RELEASE_UPLOAD_S3_${suffix}`] =
      env[`${PUBLIC_ROUTE_READ_S3_PREFIX}${suffix}`]
  }
  try {
    return getReleaseUploadS3Config(readEnvironment)
  } catch (cause) {
    throw new CaptureDecayD3PublishedReleaseError(
      'publication-route-read-credentials',
      'D3 satisfaction requires dedicated read-only public-route S3 credentials.',
      { cause }
    )
  }
}

export async function verifyCaptureDecayD3PublishedReleaseRoutes(
  { config = null, publicationReceipt },
  {
    createTransport = createReleaseUploadS3Transport,
    inspectArtifact = inspectReleaseUploadArtifact,
    now = () => new Date()
  } = {}
) {
  const activeConfig = config ?? getCaptureDecayD3PublicRouteReadS3Config()
  const receipt = assertCaptureDecayD3PublicationReceipt(publicationReceipt)
  const destination = receipt.destinationBinding.document.destination
  assertPublicationDestination(activeConfig, destination)
  const artifacts = publicationRouteArtifacts(receipt)
  const transport = createTransport({ config: activeConfig })
  const routes = []
  try {
    for (const artifact of artifacts) {
      const verification = await inspectArtifact({ artifact, config: activeConfig, transport })
      if (
        verification?.state !== 'identical' ||
        verification?.sha256 !== artifact.sha256 ||
        verification?.sizeBytes !== artifact.sizeBytes
      ) {
        throw publishedReleaseError(
          'publication-route-mismatch',
          `Current public route ${artifact.label} at s3://${activeConfig.bucket}/${artifact.objectKey} is missing or does not contain its exact receipt-bound bytes.`
        )
      }
      if (!Object.hasOwn(verification, 'etag')) {
        throw publishedReleaseError(
          'publication-route-etag',
          `Current public route ${artifact.label} did not return its remote ETag field.`
        )
      }
      const etag = normalizeEtag(verification.etag, artifact.label)
      const envelope = assertReceiptBoundResponseEnvelope(verification, artifact)
      routes.push({
        label: artifact.label,
        objectKey: artifact.objectKey,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        state: 'identical',
        etag,
        ...envelope
      })
    }
  } finally {
    transport.close()
  }

  return {
    profile: CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE,
    verifiedAt: isoTimestamp(now(), 'public-route verification time'),
    readProtocol: PUBLIC_ROUTE_READ_PROTOCOL,
    destination: { ...destination },
    routes
  }
}

function publicationRouteArtifacts(receipt) {
  const artifactsByLabel = new Map(
    receipt.release.artifacts.map((artifact) => [artifact.label, artifact])
  )
  artifactsByLabel.set('d3-publication-reservation', {
    label: 'd3-publication-reservation',
    objectKey: receipt.reservation.objectKey,
    sha256: receipt.reservation.sha256,
    sizeBytes: receipt.reservation.sizeBytes,
    contentType: 'application/json',
    immutable: true
  })
  return receipt.destinationBinding.document.uploadPlan.map((route) => {
    const artifact = artifactsByLabel.get(route.label)
    if (!artifact || artifact.objectKey !== route.objectKey) {
      throw publishedReleaseError(
        'publication-route-plan',
        `Publication receipt does not bind exact bytes for public route ${route.label}.`
      )
    }
    return artifact
  })
}

function assertPublicationDestination(config, expected) {
  const actual = {
    bucket: config?.bucket,
    endpointUrl: config?.endpointUrl ?? null,
    forcePathStyle: config?.forcePathStyle === true,
    region: config?.region,
    tlsPolicy: normalizePublicationTlsPolicy(config?.tlsPolicy)
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw publishedReleaseError(
      'publication-route-destination',
      'Authenticated public-route reads must use the exact preaccepted publication destination.'
    )
  }
}

function assertReceiptBoundResponseEnvelope(verification, artifact) {
  const expected = {
    contentType: artifact.contentType,
    contentLength: artifact.sizeBytes,
    metadataSha256: artifact.sha256,
    checksumSha256: sha256Base64FromHex(artifact.sha256)
  }
  for (const [field, value] of Object.entries(expected)) {
    if (verification?.[field] !== value) {
      throw publishedReleaseError(
        'publication-route-envelope',
        `Current public route ${artifact.label} did not return its exact receipt-bound ${field} evidence.`
      )
    }
  }
  return expected
}

function normalizePublicationTlsPolicy(value) {
  try {
    return normalizeReleaseUploadTlsPolicy(value)
  } catch (cause) {
    const error = publishedReleaseError(
      'publication-route-destination',
      `Authenticated public-route reads require the receipt-bound TLS policy (${cause?.message ?? 'invalid policy'}).`
    )
    error.cause = cause
    throw error
  }
}

function normalizeEtag(value, label) {
  if (value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw publishedReleaseError(
      'publication-route-etag',
      `Current public route ${label} returned an invalid ETag.`
    )
  }
  return value
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw publishedReleaseError('publication-route-time', `${label} must be an ISO timestamp.`)
  }
  const normalized = date.toISOString()
  if (value instanceof Date ? value.toISOString() !== normalized : String(value) !== normalized) {
    throw publishedReleaseError('publication-route-time', `${label} must be an ISO timestamp.`)
  }
  return normalized
}

function hasEnvironmentValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined
}

function publishedReleaseError(code, message) {
  return new CaptureDecayD3PublishedReleaseError(code, message)
}
