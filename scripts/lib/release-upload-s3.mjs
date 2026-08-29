import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { createReleaseUploadHttpsTransport } from './release-upload-https-transport.mjs'

const S3_ALGORITHM = 'AWS4-HMAC-SHA256'
const S3_PAYLOAD_HASH = 'UNSIGNED-PAYLOAD'
const S3_SERVICE = 's3'

export const MACOS_RELEASE_REPOSITORY = 'TheOrcDev/videorc'
export const MACOS_RELEASE_WORKFLOW_PATH = '.github/workflows/release-macos.yml'
export const MACOS_D3_PROMOTION_WORKFLOW_PATH =
  '.github/workflows/promote-macos-capture-decay-d3.yml'
export const MACOS_D3_PUBLICATION_RESERVATION_FILENAME =
  'capture-decay-d3-publication-reservation.json'
export const MACOS_D3_PUBLICATION_RESERVATION_PROFILE =
  'capture-decay-d3-publication-reservation-v3'

const MACOS_D3_PUBLICATION_RESERVATION_SCHEMA_VERSION = 3
const MAX_PUBLICATION_RESERVATION_BYTES = 1024 * 1024
const DEFAULT_REMOTE_BODY_READ_TIMEOUT_MS = 120_000

const DEFAULT_CONTENT_TYPES = new Map([
  ['.dmg', 'application/x-apple-diskimage'],
  ['.json', 'application/json'],
  ['.sha256', 'text/plain; charset=utf-8'],
  // electron-updater feed artifacts.
  ['.yml', 'text/yaml; charset=utf-8'],
  ['.zip', 'application/zip'],
  ['.blockmap', 'application/octet-stream']
])

export class ReleaseUploadConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReleaseUploadConfigError'
    this.code = code
  }
}

export class ReleaseUploadTransportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReleaseUploadTransportError'
    this.code = code
  }
}

export function getReleaseUploadS3Config(env = process.env) {
  const accessKeyId = requireCredentialEnv(env, [
    'VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID',
    'VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID'
  ])
  const secretAccessKey = requireCredentialEnv(env, [
    'VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY',
    'VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY'
  ])
  return {
    ...getReleaseUploadS3DestinationConfig(env),
    accessKeyId,
    secretAccessKey,
    sessionToken:
      nonEmpty(env.VIDEORC_RELEASE_UPLOAD_S3_SESSION_TOKEN) ??
      nonEmpty(env.VIDEORC_DOWNLOAD_S3_SESSION_TOKEN)
  }
}

// Destination planning is intentionally credential-free. The D3 candidate seal
// must bind the final bucket, routes, endpoint, and TLS policy before publication
// authority exists, while the uploader later consumes this exact same normalized
// object together with its write credentials.
export function getReleaseUploadS3DestinationConfig(env = process.env) {
  const endpointUrl = parseS3EndpointUrl(
    nonEmpty(env.VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL) ??
      nonEmpty(env.VIDEORC_DOWNLOAD_S3_ENDPOINT_URL)
  )

  return {
    bucket: requireEnv(env, ['VIDEORC_RELEASE_UPLOAD_S3_BUCKET', 'VIDEORC_DOWNLOAD_S3_BUCKET']),
    endpointUrl,
    forcePathStyle:
      envFlag(env.VIDEORC_RELEASE_UPLOAD_S3_FORCE_PATH_STYLE) ||
      envFlag(env.VIDEORC_DOWNLOAD_S3_FORCE_PATH_STYLE) ||
      Boolean(endpointUrl),
    region: requireEnv(env, ['VIDEORC_RELEASE_UPLOAD_S3_REGION', 'VIDEORC_DOWNLOAD_S3_REGION']),
    tlsPolicy: releaseUploadTlsPolicy(endpointUrl, env)
  }
}

export function normalizeReleaseUploadTlsPolicy(value) {
  const expectedKeys = ['allowedIssuerOrganizations', 'allowedSpkiSha256']
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !sameStrings(Object.keys(value).sort(), expectedKeys)
  ) {
    throw new ReleaseUploadConfigError(
      'invalid-tls-policy',
      'Release upload TLS policy must contain only issuer-organization and SPKI SHA-256 allowlists.'
    )
  }
  const allowedIssuerOrganizations = normalizeTlsPolicyEntries(
    value.allowedIssuerOrganizations,
    'TLS issuer organization',
    200
  )
  const allowedSpkiSha256 = normalizeTlsPolicyEntries(
    value.allowedSpkiSha256,
    'TLS SPKI SHA-256',
    64,
    (entry) => entry.toLowerCase()
  )
  for (const digest of allowedSpkiSha256) {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new ReleaseUploadConfigError(
        'invalid-tls-spki-policy',
        'Release upload TLS SPKI SHA-256 pins must be 64-character hexadecimal digests.'
      )
    }
  }
  if (allowedIssuerOrganizations.length === 0 && allowedSpkiSha256.length === 0) {
    throw new ReleaseUploadConfigError(
      'invalid-tls-policy',
      'Release upload TLS policy requires an issuer-organization or SPKI SHA-256 allowlist.'
    )
  }
  return { allowedIssuerOrganizations, allowedSpkiSha256 }
}

export async function buildReleaseUploadPlan({
  manifest,
  manifestPath,
  releaseDir,
  changelogJsonPath = null,
  env = process.env,
  exactPromotion = false
}) {
  const releaseId = requireManifestString(manifest, 'releaseId')
  const filename = requireManifestString(manifest, 'filename')
  // Versioned archive: the human dmg download (videorc-web 302s authenticated
  // users to a presigned URL here).
  const prefix = normalizeObjectPrefix(
    nonEmpty(env.VIDEORC_RELEASE_UPLOAD_PREFIX) ?? `releases/macos/${releaseId}`
  )
  // electron-updater feed: a STABLE prefix, overwritten each release, so the
  // videorc-web /api/updates/* route is a trivial 1:1 proxy — electron-updater
  // GETs latest-mac.yml then the bare zip filename it references, both here.
  const updatesPrefix = normalizeObjectPrefix(
    nonEmpty(env.VIDEORC_RELEASE_UPDATES_PREFIX) ?? 'updates/macos'
  )
  const zipFilename = macUpdateZipName(filename)
  const blockmapFilename = `${zipFilename}.blockmap`

  // The feed must be internally consistent before we publish it, or
  // electron-updater will 404 chasing a zip that isn't there.
  const feedYmlPath = join(releaseDir, 'latest-mac.yml')
  const feedYml = await readReleaseFile(
    feedYmlPath,
    'missing-update-feed-manifest',
    'latest-mac.yml'
  )
  const referencedZip = updateFeedZipNameFromYml(feedYml)
  if (referencedZip && referencedZip !== zipFilename) {
    throw new ReleaseUploadConfigError(
      'update-feed-zip-mismatch',
      `latest-mac.yml references ${referencedZip} but the release dmg implies ${zipFilename}. Remove stale artifacts and rebuild.`
    )
  }

  // The download page's manifest, at a STABLE key: videorc-web's
  // VIDEORC_DOWNLOAD_MANIFEST_OBJECT_KEY points here ONCE and every release
  // refreshes it — before this, the web download stayed pinned to whatever
  // versioned manifest the env was set to at launch (stuck on 0.9.0 while the
  // update feed served 0.9.3).
  const latestManifestPrefix = normalizeObjectPrefix(
    nonEmpty(env.VIDEORC_RELEASE_LATEST_MANIFEST_PREFIX) ?? 'releases/macos/latest'
  )

  const artifacts = [
    {
      contentType: contentTypeFor(filename),
      immutable: true,
      label: 'dmg',
      objectKey: `${prefix}/${filename}`,
      path: join(releaseDir, filename)
    },
    {
      contentType: contentTypeFor(`${filename}.sha256`),
      immutable: true,
      label: 'sha256',
      objectKey: `${prefix}/${filename}.sha256`,
      path: join(releaseDir, `${filename}.sha256`)
    },
    {
      contentType: contentTypeFor('release.json'),
      immutable: true,
      label: 'manifest',
      objectKey: `${prefix}/release.json`,
      path: manifestPath
    },
    {
      contentType: contentTypeFor(zipFilename),
      immutable: exactPromotion,
      label: 'feed-zip',
      objectKey: `${updatesPrefix}/${zipFilename}`,
      path: join(releaseDir, zipFilename)
    },
    {
      contentType: contentTypeFor(blockmapFilename),
      immutable: exactPromotion,
      label: 'feed-blockmap',
      objectKey: `${updatesPrefix}/${blockmapFilename}`,
      path: join(releaseDir, blockmapFilename)
    },
    {
      contentType: contentTypeFor('release.json'),
      immutable: false,
      label: 'latest-manifest',
      objectKey: `${latestManifestPrefix}/release.json`,
      path: manifestPath
    },
    {
      contentType: contentTypeFor('latest-mac.yml'),
      immutable: false,
      label: 'feed-manifest',
      objectKey: `${updatesPrefix}/latest-mac.yml`,
      path: feedYmlPath
    }
  ]

  if (changelogJsonPath) {
    artifacts.push({
      ...buildReleaseChangelogUploadRoute({ env }),
      path: changelogJsonPath
    })
  }

  return {
    artifacts: orderReleaseUploadArtifacts(
      await Promise.all(
        artifacts.map(async (artifact) => ({
          ...artifact,
          sizeBytes: await releaseFileSize(artifact.path, artifact.label)
        }))
      )
    ),
    prefix,
    updatesPrefix,
    releaseId
  }
}

export function buildReleaseChangelogUploadRoute({ env = process.env } = {}) {
  const changelogPrefix = normalizeObjectPrefix(
    nonEmpty(env.VIDEORC_RELEASE_CHANGELOG_PREFIX) ?? 'changelog'
  )
  return {
    contentType: contentTypeFor('changelog.json'),
    immutable: false,
    label: 'changelog',
    objectKey: `${changelogPrefix}/changelog.json`
  }
}

export function partitionReleaseUploadArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new ReleaseUploadConfigError(
      'invalid-upload-artifacts',
      'Release upload artifacts must be a non-empty array.'
    )
  }
  const immutableArtifacts = []
  const pointerArtifacts = []
  const objectKeys = new Set()
  for (const artifact of artifacts) {
    if (artifact?.immutable !== true && artifact?.immutable !== false) {
      throw new ReleaseUploadConfigError(
        'unclassified-upload-artifact',
        `Release upload artifact ${artifact?.label ?? '(unknown)'} must be classified as immutable or pointer.`
      )
    }
    const objectKey = requireS3ObjectKey(
      artifact.objectKey,
      `Release upload artifact ${artifact?.label ?? '(unknown)'} object key`
    )
    if (objectKeys.has(objectKey)) {
      throw new ReleaseUploadConfigError(
        'duplicate-upload-object-key',
        `Release upload plan repeats object key ${objectKey}.`
      )
    }
    objectKeys.add(objectKey)
    if (artifact.immutable) {
      immutableArtifacts.push(artifact)
    } else {
      pointerArtifacts.push(artifact)
    }
  }
  return { immutableArtifacts, pointerArtifacts }
}

export function orderReleaseUploadArtifacts(artifacts) {
  const { immutableArtifacts, pointerArtifacts } = partitionReleaseUploadArtifacts(artifacts)
  return [...immutableArtifacts, ...pointerArtifacts]
}

export function assertMacosD3ExactPromotionUploadRoutes({ artifacts, prefix, releaseManifest }) {
  const filename = requiredText(releaseManifest?.filename, 'sealed release filename')
  const sealedObjectKey = requireS3ObjectKey(
    releaseManifest?.objectKey,
    'sealed release object key'
  )
  const objectKeyParts = sealedObjectKey.split('/')
  if (objectKeyParts.at(-1) !== filename) {
    throw exactPromotionRouteMismatch(
      'The sealed release object key does not end in the sealed release filename.'
    )
  }
  const releasePrefix = objectKeyParts.slice(0, -1).join('/')
  if (prefix !== releasePrefix) {
    throw exactPromotionRouteMismatch(
      `Exact promotion prefix ${prefix ?? '(missing)'} does not match sealed release prefix ${releasePrefix}.`
    )
  }

  const zipFilename = macUpdateZipName(filename)
  const expectedRoutes = new Map([
    ['dmg', sealedObjectKey],
    ['sha256', `${sealedObjectKey}.sha256`],
    ['manifest', `${releasePrefix}/release.json`],
    ['feed-zip', `updates/macos/${zipFilename}`],
    ['feed-blockmap', `updates/macos/${zipFilename}.blockmap`],
    ['latest-manifest', 'releases/macos/latest/release.json'],
    ['feed-manifest', 'updates/macos/latest-mac.yml']
  ])
  const routeByLabel = new Map()
  for (const artifact of orderReleaseUploadArtifacts(artifacts)) {
    const label = requiredText(artifact?.label, 'exact-promotion artifact label')
    if (routeByLabel.has(label)) {
      throw exactPromotionRouteMismatch(`Exact promotion repeats upload label ${label}.`)
    }
    routeByLabel.set(label, artifact.objectKey)
  }
  if (routeByLabel.has('changelog')) {
    expectedRoutes.set('changelog', 'changelog/changelog.json')
  }
  if (routeByLabel.size !== expectedRoutes.size) {
    throw exactPromotionRouteMismatch(
      'Exact promotion contains a missing or unsupported public upload route.'
    )
  }
  for (const [label, expectedObjectKey] of expectedRoutes) {
    if (routeByLabel.get(label) !== expectedObjectKey) {
      throw exactPromotionRouteMismatch(
        `Exact promotion route ${label} must publish to ${expectedObjectKey}.`
      )
    }
  }
}

// electron-updater pulls the zip (not the dmg) for macOS updates; its name is the
// dmg name with a .zip extension (electron-builder's artifactName template).
export function macUpdateZipName(dmgFilename) {
  if (!String(dmgFilename).endsWith('.dmg')) {
    throw new ReleaseUploadConfigError(
      'invalid-dmg-filename',
      `Expected a .dmg release filename to derive the update zip, got ${dmgFilename}.`
    )
  }
  return `${dmgFilename.slice(0, -'.dmg'.length)}.zip`
}

// The primary update artifact electron-updater fetches, read from latest-mac.yml's
// top-level `path:` field. A tiny scan avoids pulling in a YAML dependency.
export function updateFeedZipNameFromYml(ymlText) {
  const match = String(ymlText).match(/^path:[^\S\r\n]*(.+?)[^\S\r\n]*$/m)
  return match ? match[1].trim() : null
}

export function exactMacosPromotionChangelogGeneratedAt(releaseManifest) {
  const releasedAt = requiredText(releaseManifest?.releasedAt, 'sealed release timestamp')
  const timestamp = Date.parse(releasedAt)
  if (!Number.isFinite(timestamp)) {
    throw new ReleaseUploadConfigError(
      'invalid-exact-promotion-timestamp',
      'The sealed release timestamp must be a valid ISO date-time.'
    )
  }
  return new Date(timestamp).toISOString()
}

export function buildSignedS3Request({
  additionalHeaders = {},
  config,
  method,
  objectKey,
  payloadSha256 = S3_PAYLOAD_HASH
}) {
  const date = new Date()
  const url = buildS3ObjectUrl(config, objectKey)
  const normalizedPayloadSha256 = normalizeS3PayloadSha256(payloadSha256)
  const signedAdditionalHeaders = normalizeAdditionalSignedHeaders(additionalHeaders)
  const checksumSha256 =
    normalizedPayloadSha256 === S3_PAYLOAD_HASH
      ? null
      : sha256Base64FromHex(normalizedPayloadSha256)
  const headers = {
    'x-amz-content-sha256': normalizedPayloadSha256,
    'x-amz-date': formatS3Date(date),
    ...(checksumSha256 ? { 'x-amz-checksum-sha256': checksumSha256 } : {}),
    ...signedAdditionalHeaders
  }
  if (config.sessionToken) {
    headers['x-amz-security-token'] = config.sessionToken
  }

  const canonicalHeaderEntries = [['host', url.host], ...Object.entries(headers)].sort(
    ([left], [right]) => left.localeCompare(right)
  )
  const canonicalHeaders = canonicalHeaderEntries
    .map(([key, value]) => `${key}:${value.trim()}\n`)
    .join('')
  const signedHeaders = canonicalHeaderEntries.map(([key]) => key).join(';')

  return {
    headers: {
      Authorization: buildS3AuthorizationHeader({
        canonicalHeaders,
        canonicalQuery: canonicalQuery(url.searchParams),
        config,
        date,
        method,
        pathname: url.pathname,
        payloadHash: normalizedPayloadSha256,
        signedHeaders
      }),
      'X-Amz-Content-Sha256': normalizedPayloadSha256,
      'X-Amz-Date': formatS3Date(date),
      ...(checksumSha256 ? { 'X-Amz-Checksum-Sha256': checksumSha256 } : {}),
      ...(config.sessionToken ? { 'X-Amz-Security-Token': config.sessionToken } : {}),
      ...signedAdditionalHeaders
    },
    url: url.toString()
  }
}

export function sha256Base64FromHex(sha256) {
  const normalized = requireSha256(sha256, 'payload SHA-256')
  return Buffer.from(normalized, 'hex').toString('base64')
}

function normalizeAdditionalSignedHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new ReleaseUploadConfigError(
      'invalid-signed-headers',
      'Additional S3 signed headers must be a plain object.'
    )
  }
  const normalized = {}
  const reserved = new Set([
    'authorization',
    'host',
    'x-amz-checksum-sha256',
    'x-amz-content-sha256',
    'x-amz-date',
    'x-amz-security-token'
  ])
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      throw new ReleaseUploadConfigError(
        'invalid-signed-header-name',
        `Invalid additional S3 signed header name: ${rawName}.`
      )
    }
    if (reserved.has(name)) {
      throw new ReleaseUploadConfigError(
        'reserved-signed-header',
        `Additional S3 signed headers may not override ${name}.`
      )
    }
    if (Object.hasOwn(normalized, name)) {
      throw new ReleaseUploadConfigError(
        'duplicate-signed-header',
        `Duplicate additional S3 signed header: ${name}.`
      )
    }
    if (typeof rawValue !== 'string' || /[\0\r\n]/.test(rawValue)) {
      throw new ReleaseUploadConfigError(
        'invalid-signed-header-value',
        `Additional S3 signed header ${name} must have a safe string value.`
      )
    }
    const value = rawValue.trim().replace(/[ \t]+/g, ' ')
    if (!value) {
      throw new ReleaseUploadConfigError(
        'invalid-signed-header-value',
        `Additional S3 signed header ${name} must not be empty.`
      )
    }
    normalized[name] = value
  }
  return normalized
}

export function createReleaseUploadS3Transport({ config }) {
  return createReleaseUploadHttpsTransport({
    tlsPolicy: normalizeReleaseUploadTlsPolicy(config?.tlsPolicy)
  })
}

export async function inspectReleaseUploadArtifact({
  artifact,
  bodyReadTimeoutMs = DEFAULT_REMOTE_BODY_READ_TIMEOUT_MS,
  config,
  transport = null
}) {
  validateHashedArtifact(artifact)
  requirePositiveInteger(bodyReadTimeoutMs, 'remote response body timeout')
  const activeTransport = transport ?? createReleaseUploadS3Transport({ config })
  const ownsTransport = transport === null
  try {
    const signed = buildSignedS3Request({
      additionalHeaders: { 'x-amz-checksum-mode': 'ENABLED' },
      config,
      method: 'GET',
      objectKey: artifact.objectKey
    })
    const response = await activeTransport.request(signed.url, {
      headers: { ...signed.headers, 'accept-encoding': 'identity' },
      method: 'GET'
    })
    if (response.status === 404) {
      await discardResponseBody(response)
      return { state: 'missing' }
    }
    if (!response.ok || !response.body) {
      await discardResponseBody(response)
      throw new ReleaseUploadTransportError(
        'remote-verification-failed',
        `Could not verify s3://${config.bucket}/${artifact.objectKey}: HTTP ${response.status}.`
      )
    }

    const envelope = remoteResponseEnvelope(response.headers)
    const body = await inspectBoundedResponseBody(response.body, {
      bodyReadTimeoutMs,
      maximumBytes: artifact.sizeBytes + 1,
      objectKey: artifact.objectKey
    })
    const bodyMatches =
      body.complete === true &&
      body.sizeBytes === artifact.sizeBytes &&
      body.sha256 === artifact.sha256
    const envelopeMatches = responseEnvelopeMatchesArtifact(envelope, artifact)
    return {
      ...envelope,
      sha256: body.sha256,
      sizeBytes: body.sizeBytes,
      state: bodyMatches && envelopeMatches ? 'identical' : 'different'
    }
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export async function verifyReleaseUploadArtifact(params) {
  const inspected = await inspectReleaseUploadArtifact(params)
  if (inspected.state !== 'identical') {
    throw new ReleaseUploadTransportError(
      'remote-artifact-mismatch',
      `Remote s3://${params.config.bucket}/${params.artifact.objectKey} does not match the local SHA-256 and byte size.`
    )
  }
  return inspected
}

export async function publishReleaseUploadArtifact({
  artifact,
  config,
  transport = null,
  verifyAfterPut = true
}) {
  validateHashedArtifact(artifact)
  if (artifact.body !== null && artifact.body !== undefined) {
    validateInlineArtifactBody(artifact, artifact.body)
  }
  const activeTransport = transport ?? createReleaseUploadS3Transport({ config })
  const ownsTransport = transport === null
  try {
    const current = await inspectReleaseUploadArtifact({
      artifact,
      config,
      transport: activeTransport
    })
    if (current.state === 'identical') {
      return publicationResult({
        action: artifact.immutable ? 'reused' : 'skipped',
        artifact,
        verification: current
      })
    }
    if (artifact.immutable && current.state === 'different') {
      const adopted = await adoptExistingMacosD3PublicationReservation({
        artifact,
        bodyReadTimeoutMs: DEFAULT_REMOTE_BODY_READ_TIMEOUT_MS,
        config,
        transport: activeTransport
      })
      if (adopted) return adopted
      throw immutableCollision(artifact, config)
    }

    const condition = buildReleasePutCondition({ artifact, current })
    const response = await putReleaseUploadArtifact({
      artifact,
      condition,
      config,
      transport: activeTransport
    })
    if ([409, 412].includes(response.status)) {
      const raced = await inspectReleaseUploadArtifact({
        artifact,
        config,
        transport: activeTransport
      })
      if (raced.state === 'identical') {
        return publicationResult({
          action: artifact.immutable ? 'reused' : 'skipped',
          artifact,
          verification: raced
        })
      }
      if (artifact.immutable) {
        const adopted = await adoptExistingMacosD3PublicationReservation({
          artifact,
          bodyReadTimeoutMs: DEFAULT_REMOTE_BODY_READ_TIMEOUT_MS,
          config,
          transport: activeTransport
        })
        if (adopted) return adopted
        throw immutableCollision(artifact, config)
      }
      throw new ReleaseUploadTransportError(
        'pointer-write-conflict',
        `Stable pointer s3://${config.bucket}/${artifact.objectKey} changed concurrently; retry from current remote state.`
      )
    }
    if (!response.ok) {
      throw new ReleaseUploadTransportError(
        'upload-failed',
        `Upload failed for s3://${config.bucket}/${artifact.objectKey}: HTTP ${response.status}.`
      )
    }

    const verification = verifyAfterPut
      ? await verifyReleaseUploadArtifact({ artifact, config, transport: activeTransport })
      : null
    return publicationResult({ action: 'uploaded', artifact, verification })
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export async function publishReleaseUploadPhases({
  artifacts,
  config,
  onPublished = () => {},
  publishArtifactImpl = publishReleaseUploadArtifact,
  reservationArtifactFactory = null,
  transport = null,
  verifyAfterPut = true
}) {
  const { immutableArtifacts, pointerArtifacts } = partitionReleaseUploadArtifacts(artifacts)
  const results = []
  const usesDefaultPublisher = publishArtifactImpl === publishReleaseUploadArtifact
  const activeTransport =
    transport ?? (usesDefaultPublisher ? createReleaseUploadS3Transport({ config }) : null)
  const ownsTransport = transport === null && activeTransport !== null
  try {
    const publish = async (artifact, phase) => {
      const result = await publishArtifactImpl({
        artifact,
        config,
        transport: activeTransport,
        verifyAfterPut
      })
      if (verifyAfterPut && result?.verification?.state !== 'identical') {
        throw new ReleaseUploadTransportError(
          'publication-not-verified',
          `Publication did not verify exact remote bytes for ${artifact.objectKey}.`
        )
      }
      const publishedArtifact = result?.publishedArtifact ?? artifact
      const entry = { artifact: publishedArtifact, phase, result }
      results.push(entry)
      await onPublished(entry)
    }

    for (const artifact of immutableArtifacts) await publish(artifact, 'immutable')
    if (reservationArtifactFactory) {
      const reservationArtifact = await reservationArtifactFactory()
      if (reservationArtifact?.immutable !== true) {
        throw new ReleaseUploadConfigError(
          'invalid-publication-reservation',
          'The D3 publication reservation must be an immutable artifact.'
        )
      }
      await publish(reservationArtifact, 'reservation')
    }
    for (const artifact of pointerArtifacts) await publish(artifact, 'pointer')
    return results
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export async function reverifyReleaseUploadPublication({
  artifacts,
  config,
  publicationResults,
  reservationArtifact,
  transport = null
}) {
  const { immutableArtifacts, pointerArtifacts } = partitionReleaseUploadArtifacts(artifacts)
  validateHashedArtifact(reservationArtifact)
  if (
    reservationArtifact.immutable !== true ||
    reservationArtifact.label !== 'd3-publication-reservation'
  ) {
    throw new ReleaseUploadConfigError(
      'invalid-publication-reservation',
      'Final D3 publication verification requires the immutable publication reservation.'
    )
  }
  const expected = [
    ...immutableArtifacts.map((artifact) => ({ artifact, phase: 'immutable' })),
    { artifact: reservationArtifact, phase: 'reservation' },
    ...pointerArtifacts.map((artifact) => ({ artifact, phase: 'pointer' }))
  ]
  const expectedObjectKeys = new Set(expected.map((entry) => entry.artifact.objectKey))
  if (expectedObjectKeys.size !== expected.length) {
    throw new ReleaseUploadConfigError(
      'duplicate-upload-object-key',
      'The final publication set repeats an artifact or reservation object key.'
    )
  }
  if (!Array.isArray(publicationResults) || publicationResults.length !== expected.length) {
    throw incompletePublicationResults()
  }
  const resultByObjectKey = new Map()
  for (const entry of publicationResults) {
    const objectKey = entry?.artifact?.objectKey
    if (typeof objectKey !== 'string' || resultByObjectKey.has(objectKey)) {
      throw incompletePublicationResults()
    }
    resultByObjectKey.set(objectKey, entry)
  }
  for (const expectedEntry of expected) {
    const actual = resultByObjectKey.get(expectedEntry.artifact.objectKey)
    if (
      !actual ||
      actual.phase !== expectedEntry.phase ||
      !samePublicationArtifact(actual.artifact, expectedEntry.artifact) ||
      actual.result?.verification?.state !== 'identical'
    ) {
      throw incompletePublicationResults()
    }
  }

  const activeTransport = transport ?? createReleaseUploadS3Transport({ config })
  const ownsTransport = transport === null
  try {
    const verified = []
    for (const expectedEntry of expected) {
      const current = resultByObjectKey.get(expectedEntry.artifact.objectKey)
      const verification = await verifyReleaseUploadArtifact({
        artifact: expectedEntry.artifact,
        config,
        transport: activeTransport
      })
      verified.push({
        artifact: expectedEntry.artifact,
        phase: expectedEntry.phase,
        result: { ...current.result, verification }
      })
    }
    return verified
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export function buildMacosD3PublicationReservationRoute({ config, prefix }) {
  const normalizedPrefix = requireS3ObjectKey(
    normalizeObjectPrefix(requiredText(prefix, 'release prefix')),
    'release prefix'
  )
  const objectKey = requireS3ObjectKey(
    `${normalizedPrefix}/${MACOS_D3_PUBLICATION_RESERVATION_FILENAME}`,
    'publication reservation object key'
  )
  const destination = {
    bucket: requiredText(config?.bucket, 'destination bucket'),
    endpointUrl: parseS3EndpointUrl(config?.endpointUrl),
    forcePathStyle: config?.forcePathStyle === true,
    region: requiredText(config?.region, 'destination region'),
    releasePrefix: normalizedPrefix,
    reservationObjectKey: objectKey,
    tlsPolicy: normalizeReleaseUploadTlsPolicy(config?.tlsPolicy)
  }
  return {
    artifact: {
      contentType: 'application/json',
      immutable: true,
      label: 'd3-publication-reservation',
      objectKey
    },
    document: {
      schemaVersion: MACOS_D3_PUBLICATION_RESERVATION_SCHEMA_VERSION,
      profile: MACOS_D3_PUBLICATION_RESERVATION_PROFILE,
      destination
    }
  }
}

export function buildMacosD3PublicationReservation({
  acceptedRecordSha256,
  artifacts,
  config,
  manifestSha256,
  prefix,
  publicationSourceCommit,
  releaseId,
  sealedCandidateArtifactSetSha256,
  sealedCandidateManifestSha256,
  workflow
}) {
  if (workflow?.repository !== MACOS_RELEASE_REPOSITORY) {
    throw new ReleaseUploadConfigError(
      'invalid-publication-repository',
      `The D3 reservation must be created by ${MACOS_RELEASE_REPOSITORY}.`
    )
  }
  if (workflow?.path !== MACOS_D3_PROMOTION_WORKFLOW_PATH) {
    throw new ReleaseUploadConfigError(
      'invalid-publication-workflow',
      `The D3 reservation must be created by ${MACOS_D3_PROMOTION_WORKFLOW_PATH}.`
    )
  }
  const runId = requirePositiveIntegerText(workflow?.runId, 'GitHub workflow run id')
  const sourceCommit = requireCommit(publicationSourceCommit, 'publication source commit')
  const acceptedDigest = requireSha256(acceptedRecordSha256, 'accepted-record SHA-256')
  const manifestDigest = requireSha256(manifestSha256, 'manifest SHA-256')
  const sealedManifestDigest = requireSha256(
    sealedCandidateManifestSha256,
    'sealed candidate manifest SHA-256'
  )
  const sealedArtifactSetDigest = requireSha256(
    sealedCandidateArtifactSetSha256,
    'sealed candidate artifact-set SHA-256'
  )
  const reservationRoute = buildMacosD3PublicationReservationRoute({ config, prefix })
  const artifactBindings = orderReleaseUploadArtifacts(artifacts)
    .map((artifact) => publicationArtifactBinding(artifact))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey))
  const manifestArtifact = artifactBindings.find((artifact) => artifact.label === 'manifest')
  if (manifestArtifact?.sha256 !== manifestDigest) {
    throw new ReleaseUploadConfigError(
      'reservation-manifest-mismatch',
      'The D3 reservation manifest hash does not match the versioned manifest artifact.'
    )
  }
  const document = {
    schemaVersion: reservationRoute.document.schemaVersion,
    profile: reservationRoute.document.profile,
    acceptedRecordSha256: acceptedDigest,
    sealedCandidateManifestSha256: sealedManifestDigest,
    sealedCandidateArtifactSetSha256: sealedArtifactSetDigest,
    workflow: {
      repository: MACOS_RELEASE_REPOSITORY,
      path: MACOS_D3_PROMOTION_WORKFLOW_PATH,
      runId,
      sourceCommit
    },
    release: {
      releaseId: requiredText(releaseId, 'release id'),
      manifestSha256: manifestDigest,
      artifacts: artifactBindings
    },
    destination: reservationRoute.document.destination
  }
  const body = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  return {
    artifact: {
      ...reservationRoute.artifact,
      body,
      sha256: sha256Hex(body),
      sizeBytes: body.byteLength
    },
    document
  }
}

export function buildReleasePutCondition({ artifact, current }) {
  if (artifact?.immutable === true || current?.state === 'missing') {
    return { 'if-none-match': '*' }
  }
  if (artifact?.immutable !== false || current?.state !== 'different') {
    throw new ReleaseUploadConfigError(
      'invalid-put-condition-state',
      'Release PUT conditions require a classified artifact and known remote state.'
    )
  }
  if (!current.etag) {
    throw new ReleaseUploadTransportError(
      'pointer-etag-missing',
      `Stable pointer ${artifact.objectKey} exists but did not provide the ETag required for a conditional update.`
    )
  }
  return { 'if-match': current.etag }
}

async function putReleaseUploadArtifact({ artifact, condition, config, transport }) {
  const signed = buildSignedS3Request({
    additionalHeaders: {
      ...condition,
      'x-amz-meta-videorc-sha256': artifact.sha256
    },
    config,
    method: 'PUT',
    objectKey: artifact.objectKey,
    payloadSha256: artifact.sha256
  })
  const inlineBody = artifact.body ?? null
  if (inlineBody !== null) validateInlineArtifactBody(artifact, inlineBody)
  const body = inlineBody ?? createReadStream(artifact.path)
  const response = await transport.request(signed.url, {
    body,
    headers: {
      ...signed.headers,
      'Content-Length': String(artifact.sizeBytes),
      'Content-Type': artifact.contentType
    },
    method: 'PUT'
  })
  await discardResponseBody(response)
  return response
}

async function adoptExistingMacosD3PublicationReservation({
  artifact,
  bodyReadTimeoutMs,
  config,
  transport
}) {
  if (artifact?.label !== 'd3-publication-reservation') return null
  const proposedDocument = canonicalPublicationReservationDocument(
    artifact.body,
    'proposed publication reservation'
  )
  const signed = buildSignedS3Request({
    additionalHeaders: { 'x-amz-checksum-mode': 'ENABLED' },
    config,
    method: 'GET',
    objectKey: artifact.objectKey
  })
  const response = await transport.request(signed.url, {
    headers: { ...signed.headers, 'accept-encoding': 'identity' },
    method: 'GET'
  })
  if (!response.ok || !response.body) {
    await discardResponseBody(response)
    throw new ReleaseUploadTransportError(
      'publication-reservation-read-failed',
      `Could not authenticate the existing publication reservation at s3://${config.bucket}/${artifact.objectKey}.`
    )
  }
  const envelope = remoteResponseEnvelope(response.headers)
  const body = await inspectBoundedResponseBody(response.body, {
    bodyReadTimeoutMs,
    maximumBytes: MAX_PUBLICATION_RESERVATION_BYTES + 1,
    objectKey: artifact.objectKey,
    retainBytes: true
  })
  const exactEnvelope =
    body.complete === true &&
    body.sizeBytes > 0 &&
    body.sizeBytes <= MAX_PUBLICATION_RESERVATION_BYTES &&
    envelope.contentLength === body.sizeBytes &&
    envelope.contentType === normalizeRemoteContentType(artifact.contentType) &&
    envelope.metadataSha256 === body.sha256 &&
    envelope.checksumSha256 === sha256Base64FromHex(body.sha256)
  if (!exactEnvelope || !body.bytes) {
    throw new ReleaseUploadTransportError(
      'publication-reservation-envelope',
      `Existing publication reservation s3://${config.bucket}/${artifact.objectKey} does not expose its exact authenticated response envelope.`
    )
  }
  const reservationDocument = canonicalPublicationReservationDocument(
    body.bytes,
    'existing publication reservation'
  )
  if (!sameStablePublicationReservation(reservationDocument, proposedDocument)) return null

  const publishedArtifact = {
    ...artifact,
    body: body.bytes,
    sha256: body.sha256,
    sizeBytes: body.sizeBytes
  }
  return {
    action: 'adopted',
    publishedArtifact,
    publisherWorkflow: { ...proposedDocument.workflow },
    reservationDocument,
    verification: {
      ...envelope,
      sha256: body.sha256,
      sizeBytes: body.sizeBytes,
      state: 'identical'
    }
  }
}

function publicationResult({ action, artifact, verification }) {
  if (artifact?.label !== 'd3-publication-reservation') return { action, verification }
  const reservationDocument = canonicalPublicationReservationDocument(
    artifact.body,
    'publication reservation'
  )
  return {
    action,
    publishedArtifact: artifact,
    publisherWorkflow: { ...reservationDocument.workflow },
    reservationDocument,
    verification
  }
}

function canonicalPublicationReservationDocument(bytes, label) {
  if (!(bytes instanceof Uint8Array)) {
    throw new ReleaseUploadConfigError(
      'invalid-publication-reservation',
      `${label} must retain its canonical inline bytes.`
    )
  }
  let text
  let document
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    document = JSON.parse(text)
  } catch {
    throw new ReleaseUploadConfigError(
      'invalid-publication-reservation',
      `${label} is not valid canonical UTF-8 JSON.`
    )
  }
  if (
    document?.schemaVersion !== MACOS_D3_PUBLICATION_RESERVATION_SCHEMA_VERSION ||
    document?.profile !== MACOS_D3_PUBLICATION_RESERVATION_PROFILE ||
    text !== `${JSON.stringify(document, null, 2)}\n`
  ) {
    throw new ReleaseUploadConfigError(
      'invalid-publication-reservation',
      `${label} must use ${MACOS_D3_PUBLICATION_RESERVATION_PROFILE} canonical JSON.`
    )
  }
  requirePositiveIntegerText(document?.workflow?.runId, `${label} creator workflow run id`)
  return document
}

function sameStablePublicationReservation(existing, proposed) {
  const stable = (document) => {
    const value = structuredClone(document)
    delete value.workflow.runId
    return value
  }
  return JSON.stringify(stable(existing)) === JSON.stringify(stable(proposed))
}

function publicationArtifactBinding(artifact) {
  validateHashedArtifact(artifact)
  return {
    immutable: artifact.immutable,
    label: requiredText(artifact.label, 'publication artifact label'),
    objectKey: requireS3ObjectKey(artifact.objectKey, 'publication artifact object key'),
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  }
}

function validateHashedArtifact(artifact) {
  if (artifact?.immutable !== true && artifact?.immutable !== false) {
    throw new ReleaseUploadConfigError(
      'unclassified-upload-artifact',
      `Release upload artifact ${artifact?.label ?? '(unknown)'} must be classified as immutable or pointer.`
    )
  }
  requireS3ObjectKey(artifact.objectKey, 'release object key')
  requiredText(artifact.contentType, 'release content type')
  requireSha256(artifact.sha256, 'release artifact SHA-256')
  if (
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0 ||
    artifact.sizeBytes === Number.MAX_SAFE_INTEGER
  ) {
    throw new ReleaseUploadConfigError(
      'invalid-artifact-size',
      `Release upload artifact ${artifact?.label ?? '(unknown)'} has an invalid byte size.`
    )
  }
}

function validateInlineArtifactBody(artifact, body) {
  if (!(body instanceof Uint8Array)) {
    throw new ReleaseUploadConfigError(
      'invalid-inline-artifact',
      `Inline release artifact ${artifact.label} must contain bytes.`
    )
  }
  if (body.byteLength !== artifact.sizeBytes || sha256Hex(body) !== artifact.sha256) {
    throw new ReleaseUploadConfigError(
      'inline-artifact-mismatch',
      `Inline release artifact ${artifact.label} does not match its declared byte size and SHA-256.`
    )
  }
}

function immutableCollision(artifact, config) {
  return new ReleaseUploadTransportError(
    'immutable-artifact-collision',
    `Existing immutable s3://${config.bucket}/${artifact.objectKey} does not match the local SHA-256 and byte size.`
  )
}

function remoteResponseEnvelope(headers) {
  if (!headers || typeof headers.get !== 'function') {
    throw new ReleaseUploadTransportError(
      'invalid-remote-response-headers',
      'Remote S3 object did not expose a readable response-header envelope.'
    )
  }
  return {
    contentType: normalizeRemoteContentType(headers.get('content-type')),
    contentLength: safeResponseContentLength(headers.get('content-length')),
    metadataSha256: safeResponseSha256(
      headers.get('x-amz-meta-videorc-sha256'),
      'remote SHA-256 metadata'
    ),
    checksumSha256: safeResponseChecksumSha256(headers.get('x-amz-checksum-sha256')),
    etag: safeResponseEtag(headers.get('etag'))
  }
}

function responseEnvelopeMatchesArtifact(envelope, artifact) {
  return (
    envelope.contentType === normalizeRemoteContentType(artifact.contentType) &&
    envelope.contentLength === artifact.sizeBytes &&
    envelope.metadataSha256 === artifact.sha256 &&
    envelope.checksumSha256 === sha256Base64FromHex(artifact.sha256)
  )
}

async function inspectBoundedResponseBody(
  body,
  { bodyReadTimeoutMs, maximumBytes, objectKey, retainBytes = false }
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new ReleaseUploadConfigError(
      'invalid-remote-body-bound',
      'Remote response body bound must be a positive safe integer.'
    )
  }
  const iterator = body?.[Symbol.asyncIterator]?.()
  if (!iterator || typeof iterator.next !== 'function') {
    throw new ReleaseUploadTransportError(
      'invalid-remote-response-body',
      `Remote S3 object ${objectKey} did not expose a readable response body.`
    )
  }
  const hash = createHash('sha256')
  const chunks = retainBytes ? [] : null
  const deadlineMs = Date.now() + bodyReadTimeoutMs
  let sizeBytes = 0
  try {
    while (true) {
      const remainingTimeMs = deadlineMs - Date.now()
      if (remainingTimeMs <= 0) throw remoteBodyTimeout(objectKey)
      const step = await readRemoteBodyStep(iterator, remainingTimeMs, objectKey)
      if (step.done) {
        return {
          bytes: chunks ? Buffer.concat(chunks) : null,
          complete: true,
          sha256: hash.digest('hex'),
          sizeBytes
        }
      }
      let chunk
      try {
        chunk = Buffer.from(step.value)
      } catch {
        throw new ReleaseUploadTransportError(
          'invalid-remote-response-body',
          `Remote S3 object ${objectKey} returned a non-byte body chunk.`
        )
      }
      const remaining = maximumBytes - sizeBytes
      if (chunk.byteLength >= remaining) {
        if (remaining > 0) {
          const boundedChunk = chunk.subarray(0, remaining)
          hash.update(boundedChunk)
          if (chunks) chunks.push(boundedChunk)
          sizeBytes += boundedChunk.byteLength
        }
        abortResponseBody(body, iterator)
        return { bytes: null, complete: false, sha256: null, sizeBytes }
      }
      hash.update(chunk)
      if (chunks) chunks.push(chunk)
      sizeBytes += chunk.byteLength
    }
  } catch (cause) {
    abortResponseBody(body, iterator, cause)
    throw cause
  }
}

async function readRemoteBodyStep(iterator, timeoutMs, objectKey) {
  let timeout
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(remoteBodyTimeout(objectKey)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function remoteBodyTimeout(objectKey) {
  return new ReleaseUploadTransportError(
    'remote-response-body-timeout',
    `Remote S3 object ${objectKey} did not finish its response body within the bounded read interval.`
  )
}

function abortResponseBody(body, iterator, cause = undefined) {
  try {
    body?.destroy?.()
  } catch {
    // Best-effort abort; the explicit transport is still closed by its owner.
  }
  try {
    Promise.resolve(iterator?.return?.()).catch(() => {})
  } catch {
    // Best-effort abort for custom async iterators.
  }
  try {
    Promise.resolve(body?.cancel?.(cause)).catch(() => {})
  } catch {
    // Best-effort abort for Web ReadableStreams.
  }
}

async function discardResponseBody(response) {
  if (!response?.body) return
  abortResponseBody(response.body)
}

function normalizeRemoteContentType(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new ReleaseUploadTransportError(
      'invalid-remote-content-type',
      'Remote S3 object returned an invalid Content-Type.'
    )
  }
  const contentType = value
    .trim()
    .toLowerCase()
    .replace(/[ \t]+/g, ' ')
  return contentType || null
}

function safeResponseContentLength(value) {
  if (value === null) return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new ReleaseUploadTransportError(
      'invalid-remote-content-length',
      'Remote S3 object returned an invalid Content-Length.'
    )
  }
  const sizeBytes = Number(text)
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new ReleaseUploadTransportError(
      'invalid-remote-content-length',
      'Remote S3 object returned an unsafe Content-Length.'
    )
  }
  return sizeBytes
}

function safeResponseSha256(value, label) {
  if (value === null) return null
  const digest = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ReleaseUploadTransportError(
      'invalid-remote-sha256-metadata',
      `Remote S3 object returned invalid ${label}.`
    )
  }
  return digest
}

function safeResponseChecksumSha256(value) {
  if (value === null) return null
  const checksum = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9+/]{43}=$/.test(checksum)) {
    throw new ReleaseUploadTransportError(
      'invalid-remote-checksum',
      'Remote S3 object returned an invalid SHA-256 checksum header.'
    )
  }
  return checksum
}

function safeResponseEtag(value) {
  if (value === null) return null
  const etag = value.trim()
  if (!etag || /[\0\r\n]/.test(etag)) {
    throw new ReleaseUploadTransportError(
      'invalid-remote-etag',
      'Remote S3 object returned an invalid ETag.'
    )
  }
  return etag
}

export function buildS3ObjectUrl(config, objectKey) {
  const encodedObjectKey = encodeS3ObjectKey(objectKey)

  if (!config.endpointUrl) {
    return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedObjectKey}`)
  }

  const url = new URL(parseS3EndpointUrl(config.endpointUrl))
  if (config.forcePathStyle) {
    url.pathname = `/${encodeS3PathSegment(config.bucket)}/${encodedObjectKey}`
  } else {
    url.hostname = `${config.bucket}.${url.hostname}`
    url.pathname = `/${encodedObjectKey}`
  }

  return url
}

function buildS3AuthorizationHeader(params) {
  const amzDate = formatS3Date(params.date)
  const dateStamp = formatS3DateStamp(params.date)
  const credentialScope = `${dateStamp}/${params.config.region}/${S3_SERVICE}/aws4_request`
  const canonicalRequest = [
    params.method,
    params.pathname,
    params.canonicalQuery,
    params.canonicalHeaders,
    params.signedHeaders,
    params.payloadHash
  ].join('\n')
  const stringToSign = [S3_ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join(
    '\n'
  )
  const signature = hmacSha256(getS3SigningKey(params.config, dateStamp), stringToSign, 'hex')

  return `${S3_ALGORITHM} Credential=${params.config.accessKeyId}/${credentialScope}, SignedHeaders=${params.signedHeaders}, Signature=${signature}`
}

function parseS3EndpointUrl(value) {
  if (!value) {
    return null
  }

  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error('Unsupported S3 endpoint URL protocol.')
    }

    return url.toString()
  } catch {
    throw new ReleaseUploadConfigError(
      'invalid-endpoint-url',
      'Release upload S3 endpoint URL must be a credential-free, host-only HTTPS URL without a bucket or other path.'
    )
  }
}

function releaseUploadTlsPolicy(endpointUrl, env) {
  const issuerEnvironment =
    nonEmpty(env.VIDEORC_RELEASE_UPLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS) ??
    nonEmpty(env.VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS)
  const spkiEnvironment =
    nonEmpty(env.VIDEORC_RELEASE_UPLOAD_S3_TLS_ALLOWED_SPKI_SHA256) ??
    nonEmpty(env.VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_SPKI_SHA256)
  let allowedIssuerOrganizations = parseTlsIssuerOrganizations(issuerEnvironment)
  const allowedSpkiSha256 = parseTlsSpkiSha256(spkiEnvironment)

  if (allowedIssuerOrganizations.length === 0 && allowedSpkiSha256.length === 0) {
    const hostname = endpointUrl ? new URL(endpointUrl).hostname.toLowerCase() : null
    if (hostname?.endsWith('.r2.cloudflarestorage.com')) {
      allowedIssuerOrganizations = ['Google Trust Services']
    } else if (endpointUrl === null) {
      allowedIssuerOrganizations = ['Amazon']
    } else {
      throw new ReleaseUploadConfigError(
        'missing-tls-policy',
        'A custom release S3 endpoint requires an explicit TLS issuer-organization or SPKI SHA-256 allowlist.'
      )
    }
  }

  return normalizeReleaseUploadTlsPolicy({ allowedIssuerOrganizations, allowedSpkiSha256 })
}

function parseTlsIssuerOrganizations(value) {
  if (value === null) return []
  const entries = commaSeparatedValues(value, 'TLS issuer organization')
  for (const entry of entries) {
    if (entry.length > 200 || /[\0\r\n]/.test(entry)) {
      throw new ReleaseUploadConfigError(
        'invalid-tls-issuer-policy',
        'Release upload TLS issuer organizations must be short single-line values.'
      )
    }
  }
  return entries
}

function parseTlsSpkiSha256(value) {
  if (value === null) return []
  const digests = commaSeparatedValues(value, 'TLS SPKI SHA-256').map((entry) => {
    const digest = entry.toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new ReleaseUploadConfigError(
        'invalid-tls-spki-policy',
        'Release upload TLS SPKI SHA-256 pins must be 64-character hexadecimal digests.'
      )
    }
    return digest
  })
  if (new Set(digests).size !== digests.length) {
    throw new ReleaseUploadConfigError(
      'invalid-tls-policy',
      'TLS SPKI SHA-256 allowlist must contain distinct digests.'
    )
  }
  return digests
}

function normalizeTlsPolicyEntries(value, label, maximumLength, map = (entry) => entry) {
  if (!Array.isArray(value)) {
    throw new ReleaseUploadConfigError('invalid-tls-policy', `${label} allowlist must be an array.`)
  }
  const entries = value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new ReleaseUploadConfigError(
        'invalid-tls-policy',
        `${label} allowlist entries must be strings.`
      )
    }
    const normalized = map(entry.trim())
    if (!normalized || normalized.length > maximumLength || /[\0\r\n]/.test(normalized)) {
      throw new ReleaseUploadConfigError(
        'invalid-tls-policy',
        `${label} allowlist entries must be bounded non-empty single-line values.`
      )
    }
    return normalized
  })
  if (new Set(entries).size !== entries.length) {
    throw new ReleaseUploadConfigError(
      'invalid-tls-policy',
      `${label} allowlist entries must be distinct.`
    )
  }
  return entries.sort(compareText)
}

function commaSeparatedValues(value, label) {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new ReleaseUploadConfigError(
      'invalid-tls-policy',
      `${label} allowlist must contain distinct comma-separated values.`
    )
  }
  return entries
}

/**
 * Credentials go into the Authorization header (and the signing key), so they
 * must be single-token printable ASCII.
 *
 * A credential copied out of a .env file with its trailing `# comment` attached
 * passes every earlier check and then fails deep inside fetch with
 * "Cannot convert argument to a ByteString because the character at index N has
 * a value of 8212" — an em dash in the comment, with nothing pointing at the
 * real cause. Reject it here, naming the variable and the reason.
 *
 * The value itself is never echoed.
 */
function requireCredentialEnv(env, names) {
  const value = requireEnv(env, names)
  const name = names.find((candidate) => nonEmpty(env[candidate])) ?? names[0]
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new ReleaseUploadConfigError(
      'invalid-credential',
      `${name} must be a single printable ASCII token. It contains whitespace or ` +
        'non-ASCII characters — a trailing "# comment" copied from a .env file is the usual cause.'
    )
  }
  return value
}

function requireEnv(env, names) {
  for (const name of names) {
    const value = nonEmpty(env[name])
    if (value) {
      return value
    }
  }

  throw new ReleaseUploadConfigError(
    `missing-${names
      .at(0)
      ?.toLowerCase()
      .replace(/^videorc_(release_upload_)?s3_/, '')
      .replaceAll('_', '-')}`,
    `Missing required release upload environment variable: ${names.join(' or ')}.`
  )
}

function requireManifestString(manifest, field) {
  const value = manifest?.[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReleaseUploadConfigError(
      `missing-manifest-${field}`,
      `release.json must include ${field}.`
    )
  }
  return value.trim()
}

async function readReleaseFile(path, code, label) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new ReleaseUploadConfigError(
      code,
      `Missing ${label} at ${path}. Run \`pnpm dist:release\` to build the dmg + update feed.`
    )
  }
}

async function releaseFileSize(path, label) {
  try {
    return (await stat(path)).size
  } catch {
    throw new ReleaseUploadConfigError(
      `missing-artifact-${label}`,
      `Missing release artifact "${label}" at ${path}. Run \`pnpm dist:release\` first.`
    )
  }
}

function normalizeObjectPrefix(prefix) {
  return requireS3ObjectKey(prefix.trim(), 'release upload prefix')
}

function contentTypeFor(filename) {
  const name = basename(filename)
  const extension = name.endsWith('.sha256')
    ? '.sha256'
    : name.slice(Math.max(0, name.lastIndexOf('.')))
  return DEFAULT_CONTENT_TYPES.get(extension) ?? 'application/octet-stream'
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${encodeS3PathSegment(key)}=${encodeS3PathSegment(value)}`)
    .join('&')
}

function encodeS3ObjectKey(objectKey) {
  return requireS3ObjectKey(objectKey, 'S3 object key')
    .split('/')
    .map(encodeS3PathSegment)
    .join('/')
}

function encodeS3PathSegment(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function formatS3Date(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function formatS3DateStamp(date) {
  return formatS3Date(date).slice(0, 8)
}

function getS3SigningKey(config, dateStamp) {
  const dateKey = hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp)
  const regionKey = hmacSha256(dateKey, config.region)
  const serviceKey = hmacSha256(regionKey, S3_SERVICE)
  return hmacSha256(serviceKey, 'aws4_request')
}

function normalizeS3PayloadSha256(value) {
  return value === S3_PAYLOAD_HASH ? value : requireSha256(value, 'S3 payload SHA-256')
}

function requireSha256(value, label) {
  const normalized = requiredText(value, label).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new ReleaseUploadConfigError('invalid-sha256', `${label} must be a 64-character hash.`)
  }
  return normalized
}

function requireCommit(value, label) {
  const normalized = requiredText(value, label).toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new ReleaseUploadConfigError('invalid-commit', `${label} must be a full Git commit.`)
  }
  return normalized
}

function requirePositiveIntegerText(value, label) {
  const normalized = requiredText(value, label)
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new ReleaseUploadConfigError(
      'invalid-positive-integer',
      `${label} must be a positive integer.`
    )
  }
  return normalized
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReleaseUploadConfigError(
      'invalid-positive-integer',
      `${label} must be a positive safe integer.`
    )
  }
  return value
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReleaseUploadConfigError('missing-required-text', `${label} is required.`)
  }
  return value.trim()
}

function requireS3ObjectKey(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReleaseUploadConfigError(
      'invalid-upload-object-key',
      `${label} must be a non-empty relative S3 object key.`
    )
  }
  const components = value.split('/')
  if (
    value !== value.trim() ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\0-\x1f\x7f]/.test(value) ||
    components.some(
      (component) =>
        !component || component.trim().length === 0 || component === '.' || component === '..'
    )
  ) {
    throw new ReleaseUploadConfigError(
      'invalid-upload-object-key',
      `${label} contains an empty, dot, traversal, or otherwise unsafe path component.`
    )
  }
  return value
}

function exactPromotionRouteMismatch(message) {
  return new ReleaseUploadConfigError('exact-promotion-route-mismatch', message)
}

function incompletePublicationResults() {
  return new ReleaseUploadConfigError(
    'incomplete-publication-results',
    'Final D3 publication verification requires the complete artifact and reservation result set.'
  )
}

function samePublicationArtifact(left, right) {
  return (
    left?.label === right?.label &&
    left?.objectKey === right?.objectKey &&
    left?.contentType === right?.contentType &&
    left?.immutable === right?.immutable &&
    left?.sha256 === right?.sha256 &&
    left?.sizeBytes === right?.sizeBytes
  )
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmacSha256(key, value, encoding) {
  const digest = createHmac('sha256', key).update(value).digest()
  return encoding === 'hex' ? digest.toString('hex') : digest
}

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 ? text : null
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameStrings(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}
