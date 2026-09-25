import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

const DEFAULT_MINIMUM_LINUX = 'Ubuntu 24.04 LTS or later'
const DEFAULT_KNOWN_ISSUES_URL = 'https://www.videorc.com/linux-alpha'
const CANONICAL_RELEASE_ORIGIN = 'https://www.videorc.com'
const APPIMAGE_NAME = /^Videorc-[A-Za-z0-9][A-Za-z0-9.+-]*-linux-x64\.AppImage$/
const RELEASE_ID = /^(\d+\.\d+\.\d+)-alpha\.(\d+)$/

export const LINUX_ALPHA_PUBLIC_PREFIX = 'releases/linux-alpha'
export const LINUX_ALPHA_UPDATE_FEED_NAME = 'latest-linux.yml'

export function linuxAlphaAppImageFilename(bundleVersion) {
  return `Videorc-${bundleVersion}-linux-x64.AppImage`
}

export function assertLinuxAppImageArtifactNameTemplate(template) {
  const value = requireNonEmpty(template, 'linux artifactName')
  if (value.includes('${arch}')) {
    throw new LinuxAlphaReleaseError(
      'linux-artifact-name-uses-arch',
      'Linux artifactName must hardcode x64. electron-builder expands ${arch} to x86_64 for AppImage.'
    )
  }
  const expanded = expandElectronBuilderArtifactName(value, {
    arch: 'x86_64',
    ext: 'AppImage',
    os: 'linux',
    productName: 'Videorc',
    version: '0.10.0'
  })
  const expected = linuxAlphaAppImageFilename('0.10.0')
  if (expanded !== expected) {
    throw new LinuxAlphaReleaseError(
      'linux-artifact-name-mismatch',
      `Linux artifactName must produce ${expected}, got ${expanded}.`
    )
  }
  return value
}

export class LinuxAlphaReleaseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LinuxAlphaReleaseError'
    this.code = code
  }
}

export async function findLatestLinuxAppImage(releaseDir) {
  const entries = await readdir(releaseDir, { withFileTypes: true })
  const candidates = []

  for (const entry of entries) {
    if (!entry.isFile() || !APPIMAGE_NAME.test(entry.name)) {
      continue
    }
    const path = join(releaseDir, entry.name)
    const info = await stat(path)
    candidates.push({ path, mtimeMs: info.mtimeMs, sizeBytes: info.size })
  }

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs).at(0) ?? null
}

export function assertLinuxAppImageFilename(artifactPath) {
  const filename = basename(artifactPath)
  if (!APPIMAGE_NAME.test(filename)) {
    throw new LinuxAlphaReleaseError(
      'invalid-appimage-filename',
      `Linux AppImage must be named Videorc-<version>-linux-x64.AppImage, got ${filename}.`
    )
  }
  return filename
}

export function parseLinuxAlphaReleaseId(releaseId) {
  const match = RELEASE_ID.exec(nonEmpty(releaseId) ?? '')
  if (!match) {
    throw new LinuxAlphaReleaseError(
      'invalid-release-id',
      'Linux Alpha releaseId must be <package version>-alpha.N.'
    )
  }
  return { bundleVersion: match[1], prereleaseNumber: Number(match[2]) }
}

export async function sha256File(path) {
  return hashFile(path, 'sha256', 'hex')
}

export async function sha512File(path) {
  return hashFile(path, 'sha512', 'base64')
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest(encoding)
}

export function formatSha256File({ sha256, filename }) {
  return `${sha256}  ${filename}\n`
}

export function buildLinuxAlphaReleaseManifest({
  artifactPath,
  packageVersion,
  sha256,
  sizeBytes,
  sourceCommit,
  releasedAt = new Date().toISOString(),
  env = process.env
}) {
  const filename = assertLinuxAppImageFilename(artifactPath)
  const releaseId = nonEmpty(env.VIDEORC_RELEASE_ID) ?? `${packageVersion}-alpha.1`
  const parsed = parseLinuxAlphaReleaseId(releaseId)
  const displayVersion =
    nonEmpty(env.VIDEORC_RELEASE_DISPLAY_VERSION) ??
    `${parsed.bundleVersion} alpha ${parsed.prereleaseNumber}`
  const acceptanceStatus =
    nonEmpty(env.VIDEORC_LINUX_ACCEPTANCE_STATUS) ??
    nonEmpty(env.VIDEORC_RELEASE_ACCEPTANCE_STATUS) ??
    'pending'
  const acceptanceRecordUrl =
    nonEmpty(env.VIDEORC_LINUX_ACCEPTANCE_RECORD_URL) ??
    nonEmpty(env.VIDEORC_RELEASE_ACCEPTANCE_RECORD_URL)

  const manifest = {
    product: 'Videorc',
    channel: 'alpha',
    releaseId,
    displayVersion,
    bundleVersion: packageVersion,
    platform: 'linux',
    architecture: 'x64',
    filename,
    objectKey: `${LINUX_ALPHA_PUBLIC_PREFIX}/${releaseId}/${filename}`,
    sha256,
    sizeBytes,
    minimumOS: nonEmpty(env.VIDEORC_RELEASE_MINIMUM_LINUX) ?? DEFAULT_MINIMUM_LINUX,
    releasedAt,
    releaseNotesUrl:
      nonEmpty(env.VIDEORC_RELEASE_NOTES_URL) ??
      `${CANONICAL_RELEASE_ORIGIN}/releases/${releaseId}`,
    knownIssuesUrl: nonEmpty(env.VIDEORC_LINUX_KNOWN_ISSUES_URL) ?? DEFAULT_KNOWN_ISSUES_URL,
    signingStatus: 'unsigned',
    acceptanceStatus,
    acceptanceRecordUrl,
    sourceCommit: nonEmpty(sourceCommit),
    stage: nonEmpty(env.VIDEORC_LINUX_RELEASE_STAGE) ?? 'candidate'
  }

  assertLinuxAlphaReleaseManifest(manifest)
  return manifest
}

export function assertLinuxAlphaReleaseManifest(manifest, { requireAccepted = false } = {}) {
  const releaseId = requireString(manifest, 'releaseId')
  const filename = assertLinuxAppImageFilename(requireString(manifest, 'filename'))
  const parsed = parseLinuxAlphaReleaseId(releaseId)

  for (const [field, expected] of [
    ['product', 'Videorc'],
    ['channel', 'alpha'],
    ['platform', 'linux'],
    ['architecture', 'x64'],
    ['signingStatus', 'unsigned']
  ]) {
    if (manifest?.[field] !== expected) {
      throw new LinuxAlphaReleaseError(
        `invalid-${field}`,
        `release.json ${field} must be ${expected}.`
      )
    }
  }

  const displayVersion = requireString(manifest, 'displayVersion')
  const bundleVersion = requireString(manifest, 'bundleVersion')
  if (!/^\d+\.\d+\.\d+$/.test(bundleVersion)) {
    throw new LinuxAlphaReleaseError(
      'invalid-bundle-version',
      'release.json bundleVersion must be a three-part numeric version.'
    )
  }
  if (parsed.bundleVersion !== bundleVersion) {
    throw new LinuxAlphaReleaseError(
      'invalid-release-id',
      `release.json releaseId must start with ${bundleVersion}-alpha.`
    )
  }
  if (
    displayVersion !== releaseId &&
    displayVersion.toLowerCase() !==
      `${bundleVersion} alpha ${parsed.prereleaseNumber}`.toLowerCase()
  ) {
    throw new LinuxAlphaReleaseError(
      'invalid-display-version',
      `release.json displayVersion must be ${releaseId} or ${bundleVersion} Alpha ${parsed.prereleaseNumber}.`
    )
  }
  const expectedFilename = linuxAlphaAppImageFilename(bundleVersion)
  if (filename !== expectedFilename) {
    throw new LinuxAlphaReleaseError(
      'stale-appimage-filename',
      `release.json filename must be ${expectedFilename}. Remove stale artifacts and rebuild.`
    )
  }

  const releasedAt = requireString(manifest, 'releasedAt')
  if (!isCanonicalIsoTimestamp(releasedAt)) {
    throw new LinuxAlphaReleaseError(
      'invalid-released-at',
      'release.json releasedAt must be a canonical UTC ISO-8601 timestamp.'
    )
  }
  const minimumOS = requireString(manifest, 'minimumOS')
  if (!/Ubuntu 24\.04/i.test(minimumOS)) {
    throw new LinuxAlphaReleaseError(
      'invalid-minimum-linux',
      'release.json minimumOS must explicitly name Ubuntu 24.04.'
    )
  }

  const objectKey = assertIsolatedLinuxObjectKey(requireString(manifest, 'objectKey'))
  const expectedObjectKey = `${LINUX_ALPHA_PUBLIC_PREFIX}/${releaseId}/${filename}`
  if (objectKey !== expectedObjectKey) {
    throw new LinuxAlphaReleaseError(
      'invalid-object-key',
      `release.json objectKey must be ${expectedObjectKey}.`
    )
  }

  const sha256 = requireString(manifest, 'sha256')
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new LinuxAlphaReleaseError(
      'invalid-sha256',
      'release.json sha256 must be a 64-character hexadecimal digest.'
    )
  }
  if (!Number.isSafeInteger(manifest?.sizeBytes) || manifest.sizeBytes <= 0) {
    throw new LinuxAlphaReleaseError(
      'invalid-size-bytes',
      'release.json sizeBytes must be a positive integer.'
    )
  }

  const releaseNotesUrl = requireHttpsUrl(manifest, 'releaseNotesUrl')
  const expectedReleaseNotesUrl = `${CANONICAL_RELEASE_ORIGIN}/releases/${releaseId}`
  if (releaseNotesUrl.toString() !== expectedReleaseNotesUrl) {
    throw new LinuxAlphaReleaseError(
      'invalid-release-notes-url',
      `release.json releaseNotesUrl must be ${expectedReleaseNotesUrl}.`
    )
  }
  const knownIssuesUrl = requireHttpsUrl(manifest, 'knownIssuesUrl')
  if (knownIssuesUrl.toString() !== DEFAULT_KNOWN_ISSUES_URL) {
    throw new LinuxAlphaReleaseError(
      'invalid-known-issues-url',
      `release.json knownIssuesUrl must be ${DEFAULT_KNOWN_ISSUES_URL}.`
    )
  }

  const sourceCommit = requireString(manifest, 'sourceCommit')
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) {
    throw new LinuxAlphaReleaseError(
      'invalid-source-commit',
      'release.json sourceCommit must be the full 40-character Git commit SHA.'
    )
  }

  const acceptanceStatus = requireString(manifest, 'acceptanceStatus')
  if (!['pending', 'pass', 'waived', 'failed'].includes(acceptanceStatus)) {
    throw new LinuxAlphaReleaseError(
      'invalid-acceptance-status',
      'release.json acceptanceStatus must be pending, pass, waived, or failed.'
    )
  }
  const acceptanceRecordUrl = optionalString(manifest?.acceptanceRecordUrl)
  if (acceptanceRecordUrl) {
    parseHttpsUrl(acceptanceRecordUrl, 'acceptanceRecordUrl')
  }
  const published = acceptanceStatus === 'pass' || acceptanceStatus === 'waived'
  if ((requireAccepted || published) && !acceptanceRecordUrl) {
    throw new LinuxAlphaReleaseError(
      'missing-acceptance-record-url',
      'An accepted Linux release must include a dated HTTPS acceptanceRecordUrl.'
    )
  }
  if (requireAccepted && !published) {
    throw new LinuxAlphaReleaseError(
      'release-not-accepted',
      'Stable Linux promotion requires acceptanceStatus=pass or an owner waiver.'
    )
  }

  const stage = requireString(manifest, 'stage')
  if (!['candidate', 'pilot', 'public'].includes(stage)) {
    throw new LinuxAlphaReleaseError(
      'invalid-stage',
      'release.json stage must be candidate, pilot, or public.'
    )
  }
  if (stage === 'public' && !published) {
    throw new LinuxAlphaReleaseError(
      'public-stage-not-accepted',
      'release.json stage=public requires acceptanceStatus=pass or waived.'
    )
  }

  return manifest
}

export function buildLinuxUpdateFeedYml({ filename, releaseDate, sha512, sizeBytes, version }) {
  assertLinuxAppImageFilename(filename)
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-version',
      `latest-linux.yml version must be a three-part numeric version, got ${version}.`
    )
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sha512 ?? '')) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-sha512',
      'latest-linux.yml sha512 must be a base64 SHA-512 digest.'
    )
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-size',
      'latest-linux.yml size must be a positive integer.'
    )
  }
  if (!isCanonicalIsoTimestamp(releaseDate)) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-release-date',
      'latest-linux.yml releaseDate must be a canonical UTC ISO-8601 timestamp.'
    )
  }

  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${filename}`,
    `    sha512: ${sha512}`,
    `    size: ${sizeBytes}`,
    `path: ${filename}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
  parseLinuxUpdateFeed(yml)
  return yml
}

export function parseLinuxUpdateFeed(ymlText) {
  let feed
  try {
    feed = loadYaml(String(ymlText), { json: false, schema: JSON_SCHEMA })
  } catch (error) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-feed-yaml',
      `latest-linux.yml must be strict YAML without duplicate keys: ${error?.message ?? 'parse error'}.`
    )
  }
  if (!isExactObject(feed, ['files', 'path', 'releaseDate', 'sha512', 'version'])) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-feed-schema',
      'latest-linux.yml must contain only version, one files entry, path, sha512, and releaseDate.'
    )
  }
  if (
    typeof feed.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(feed.version) ||
    typeof feed.path !== 'string' ||
    !APPIMAGE_NAME.test(feed.path) ||
    typeof feed.sha512 !== 'string' ||
    !isCanonicalIsoTimestamp(feed.releaseDate) ||
    !Array.isArray(feed.files) ||
    feed.files.length !== 1
  ) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-feed-schema',
      'latest-linux.yml must be a canonical single-AppImage Linux x64 update feed.'
    )
  }
  const file = feed.files[0]
  if (
    !isExactObject(file, ['sha512', 'size', 'url']) ||
    file.url !== feed.path ||
    file.sha512 !== feed.sha512 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(file.sha512 ?? '') ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0
  ) {
    throw new LinuxAlphaReleaseError(
      'invalid-update-feed-file',
      'latest-linux.yml must contain exactly one relative AppImage with matching SHA-512 and positive byte size.'
    )
  }
  return feed
}

export function updateFeedArtifactNameFromYml(ymlText) {
  return tryParseLinuxUpdateFeed(ymlText)?.path ?? null
}

export function updateFeedVersionFromYml(ymlText) {
  return tryParseLinuxUpdateFeed(ymlText)?.version ?? null
}

export function updateFeedSha512FromYml(ymlText) {
  return tryParseLinuxUpdateFeed(ymlText)?.sha512 ?? null
}

export function updateFeedFileMetadataFromYml(ymlText, artifactName) {
  const feed = tryParseLinuxUpdateFeed(ymlText)
  return feed?.files[0]?.url === artifactName ? feed.files[0] : null
}

export function assertIsolatedLinuxObjectKey(objectKey) {
  const key = requireNonEmpty(objectKey, 'object key')
  const forbidden = [
    'releases/macos',
    'releases/windows',
    'candidates/macos',
    'candidates/windows',
    'updates/macos',
    'updates/windows',
    'latest-mac.yml'
  ]
  if (forbidden.some((pattern) => key.includes(pattern))) {
    throw new LinuxAlphaReleaseError(
      'cross-platform-object-key',
      `Linux Alpha must never write macOS or Windows release keys, got ${key}.`
    )
  }
  if (/(^|\/)latest\.yml$/.test(key)) {
    throw new LinuxAlphaReleaseError(
      'cross-platform-object-key',
      'Linux Alpha must use latest-linux.yml, never the Windows latest.yml feed name.'
    )
  }
  return key
}

function expandElectronBuilderArtifactName(template, vars) {
  return template
    .replaceAll('${productName}', vars.productName)
    .replaceAll('${version}', vars.version)
    .replaceAll('${os}', vars.os)
    .replaceAll('${arch}', vars.arch)
    .replaceAll('${ext}', vars.ext)
}

function tryParseLinuxUpdateFeed(ymlText) {
  try {
    return parseLinuxUpdateFeed(ymlText)
  } catch {
    return null
  }
}

function requireString(object, field) {
  const value = optionalString(object?.[field])
  if (!value) {
    throw new LinuxAlphaReleaseError(`missing-${field}`, `release.json must include ${field}.`)
  }
  return value
}

function requireHttpsUrl(object, field) {
  return parseHttpsUrl(requireString(object, field), field)
}

function parseHttpsUrl(value, field) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('unsafe URL')
    }
    return url
  } catch {
    throw new LinuxAlphaReleaseError(
      `invalid-${field}`,
      `release.json ${field} must be a credential-free HTTPS URL.`
    )
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function nonEmpty(value) {
  return optionalString(value)
}

function requireNonEmpty(value, label) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new LinuxAlphaReleaseError(`missing-${label.replaceAll(' ', '-')}`, `Missing ${label}.`)
  }
  return normalized
}

function isCanonicalIsoTimestamp(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isExactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
