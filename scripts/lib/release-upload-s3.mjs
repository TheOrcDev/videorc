import { createHash, createHmac } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const S3_ALGORITHM = 'AWS4-HMAC-SHA256'
const S3_PAYLOAD_HASH = 'UNSIGNED-PAYLOAD'
const S3_SERVICE = 's3'

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

export function getReleaseUploadS3Config(env = process.env) {
  const endpointUrl = parseS3EndpointUrl(
    nonEmpty(env.VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL) ??
      nonEmpty(env.VIDEORC_DOWNLOAD_S3_ENDPOINT_URL)
  )

  return {
    accessKeyId: requireEnv(env, [
      'VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID',
      'VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID'
    ]),
    bucket: requireEnv(env, ['VIDEORC_RELEASE_UPLOAD_S3_BUCKET', 'VIDEORC_DOWNLOAD_S3_BUCKET']),
    endpointUrl,
    forcePathStyle:
      envFlag(env.VIDEORC_RELEASE_UPLOAD_S3_FORCE_PATH_STYLE) ||
      envFlag(env.VIDEORC_DOWNLOAD_S3_FORCE_PATH_STYLE) ||
      Boolean(endpointUrl),
    region: requireEnv(env, ['VIDEORC_RELEASE_UPLOAD_S3_REGION', 'VIDEORC_DOWNLOAD_S3_REGION']),
    secretAccessKey: requireEnv(env, [
      'VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY',
      'VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY'
    ]),
    sessionToken:
      nonEmpty(env.VIDEORC_RELEASE_UPLOAD_S3_SESSION_TOKEN) ??
      nonEmpty(env.VIDEORC_DOWNLOAD_S3_SESSION_TOKEN)
  }
}

export async function buildReleaseUploadPlan({
  manifest,
  manifestPath,
  releaseDir,
  changelogJsonPath = null,
  env = process.env
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

  // Public changelog: a STABLE prefix like the update feed, overwritten each
  // release — consumed by videorc-web (/changelog) and the desktop What's New.
  const changelogPrefix = normalizeObjectPrefix(
    nonEmpty(env.VIDEORC_RELEASE_CHANGELOG_PREFIX) ?? 'changelog'
  )
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
      label: 'dmg',
      objectKey: `${prefix}/${filename}`,
      path: join(releaseDir, filename)
    },
    {
      contentType: contentTypeFor(`${filename}.sha256`),
      label: 'sha256',
      objectKey: `${prefix}/${filename}.sha256`,
      path: join(releaseDir, `${filename}.sha256`)
    },
    {
      contentType: contentTypeFor('release.json'),
      label: 'manifest',
      objectKey: `${prefix}/release.json`,
      path: manifestPath
    },
    {
      contentType: contentTypeFor('release.json'),
      label: 'latest-manifest',
      objectKey: `${latestManifestPrefix}/release.json`,
      path: manifestPath
    },
    {
      contentType: contentTypeFor('latest-mac.yml'),
      label: 'feed-manifest',
      objectKey: `${updatesPrefix}/latest-mac.yml`,
      path: feedYmlPath
    },
    {
      contentType: contentTypeFor(zipFilename),
      label: 'feed-zip',
      objectKey: `${updatesPrefix}/${zipFilename}`,
      path: join(releaseDir, zipFilename)
    },
    {
      contentType: contentTypeFor(blockmapFilename),
      label: 'feed-blockmap',
      objectKey: `${updatesPrefix}/${blockmapFilename}`,
      path: join(releaseDir, blockmapFilename)
    }
  ]

  if (changelogJsonPath) {
    artifacts.push({
      contentType: contentTypeFor('changelog.json'),
      label: 'changelog',
      objectKey: `${changelogPrefix}/changelog.json`,
      path: changelogJsonPath
    })
  }

  return {
    artifacts: await Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        sizeBytes: await releaseFileSize(artifact.path, artifact.label)
      }))
    ),
    prefix,
    updatesPrefix,
    releaseId
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

export function buildSignedS3Request({ additionalHeaders = {}, config, method, objectKey }) {
  const date = new Date()
  const url = buildS3ObjectUrl(config, objectKey)
  const signedAdditionalHeaders = normalizeAdditionalSignedHeaders(additionalHeaders)
  const headers = {
    'x-amz-content-sha256': S3_PAYLOAD_HASH,
    'x-amz-date': formatS3Date(date),
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
        signedHeaders
      }),
      'X-Amz-Content-Sha256': S3_PAYLOAD_HASH,
      'X-Amz-Date': formatS3Date(date),
      ...(config.sessionToken ? { 'X-Amz-Security-Token': config.sessionToken } : {}),
      ...signedAdditionalHeaders
    },
    url: url.toString()
  }
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

export function buildS3ObjectUrl(config, objectKey) {
  const encodedObjectKey = encodeS3ObjectKey(objectKey)

  if (!config.endpointUrl) {
    return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedObjectKey}`)
  }

  const url = new URL(config.endpointUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  if (config.forcePathStyle) {
    url.pathname = `${basePath}/${encodeS3PathSegment(config.bucket)}/${encodedObjectKey}`
  } else {
    url.hostname = `${config.bucket}.${url.hostname}`
    url.pathname = `${basePath}/${encodedObjectKey}`
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
    S3_PAYLOAD_HASH
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
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Unsupported S3 endpoint URL protocol.')
    }

    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    throw new ReleaseUploadConfigError(
      'invalid-endpoint-url',
      'Release upload S3 endpoint URL must be a credential-free HTTPS URL.'
    )
  }
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
  return prefix
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
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
  return objectKey.split('/').map(encodeS3PathSegment).join('/')
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
