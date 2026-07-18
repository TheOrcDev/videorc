import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

const DEFAULT_MINIMUM_WINDOWS = 'Windows 11 or later'
const DEFAULT_KNOWN_ISSUES_URL = 'https://www.videorc.com/windows-alpha'
const CANONICAL_RELEASE_ORIGIN = 'https://www.videorc.com'

export class WindowsAlphaReleaseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WindowsAlphaReleaseError'
    this.code = code
  }
}

export async function findLatestWindowsInstaller(releaseDir) {
  const entries = await readdir(releaseDir, { withFileTypes: true })
  const candidates = []

  for (const entry of entries) {
    if (!entry.isFile() || !/^Videorc-[A-Za-z0-9][A-Za-z0-9.+-]*-win-x64\.exe$/.test(entry.name)) {
      continue
    }
    const path = join(releaseDir, entry.name)
    const info = await stat(path)
    candidates.push({ path, mtimeMs: info.mtimeMs, sizeBytes: info.size })
  }

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs).at(0) ?? null
}

export function assertWindowsInstallerFilename(artifactPath) {
  const filename = basename(artifactPath)
  if (!/^Videorc-[A-Za-z0-9][A-Za-z0-9.+-]*-win-x64\.exe$/.test(filename)) {
    throw new WindowsAlphaReleaseError(
      'invalid-installer-filename',
      `Windows installer must be named Videorc-<version>-win-x64.exe, got ${filename}.`
    )
  }
  return filename
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

export function buildWindowsAlphaReleaseManifest({
  artifactPath,
  packageVersion,
  publisherName,
  sha256,
  sizeBytes,
  sourceCommit,
  releasedAt = new Date().toISOString(),
  env = process.env
}) {
  const filename = assertWindowsInstallerFilename(artifactPath)
  const releaseId = nonEmpty(env.VIDEORC_RELEASE_ID) ?? `${packageVersion}-alpha.1`
  const displayVersion =
    nonEmpty(env.VIDEORC_RELEASE_DISPLAY_VERSION) ?? `${packageVersion} alpha 1`
  const acceptanceStatus =
    nonEmpty(env.VIDEORC_WINDOWS_ACCEPTANCE_STATUS) ??
    nonEmpty(env.VIDEORC_RELEASE_ACCEPTANCE_STATUS) ??
    'pending'
  const acceptanceRecordUrl =
    nonEmpty(env.VIDEORC_WINDOWS_ACCEPTANCE_RECORD_URL) ??
    nonEmpty(env.VIDEORC_RELEASE_ACCEPTANCE_RECORD_URL)
  const minimumOS = nonEmpty(env.VIDEORC_RELEASE_MINIMUM_WINDOWS) ?? DEFAULT_MINIMUM_WINDOWS

  const manifest = {
    product: 'Videorc',
    channel: 'alpha',
    releaseId,
    displayVersion,
    bundleVersion: packageVersion,
    platform: 'windows',
    architecture: 'x64',
    filename,
    objectKey: `releases/windows/${releaseId}/${filename}`,
    sha256,
    sizeBytes,
    minimumOS,
    // Keep the platform-specific alias while web clients migrate to the
    // platform-neutral manifest field.
    minimumWindows: minimumOS,
    releasedAt,
    releaseNotesUrl:
      nonEmpty(env.VIDEORC_RELEASE_NOTES_URL) ??
      `${CANONICAL_RELEASE_ORIGIN}/releases/${releaseId}`,
    knownIssuesUrl: nonEmpty(env.VIDEORC_WINDOWS_KNOWN_ISSUES_URL) ?? DEFAULT_KNOWN_ISSUES_URL,
    signingStatus: 'signed',
    publisherName: nonEmpty(publisherName),
    acceptanceStatus,
    acceptanceRecordUrl,
    sourceCommit: nonEmpty(sourceCommit)
  }

  assertWindowsAlphaReleaseManifest(manifest)
  return manifest
}

export function assertWindowsAlphaReleaseManifest(manifest, { requireAccepted = false } = {}) {
  const releaseId = requireString(manifest, 'releaseId')
  const filename = assertWindowsInstallerFilename(requireString(manifest, 'filename'))

  for (const [field, expected] of [
    ['product', 'Videorc'],
    ['channel', 'alpha'],
    ['platform', 'windows'],
    ['architecture', 'x64'],
    ['signingStatus', 'signed']
  ]) {
    if (manifest?.[field] !== expected) {
      throw new WindowsAlphaReleaseError(
        `invalid-${field}`,
        `release.json ${field} must be ${expected}.`
      )
    }
  }

  const displayVersion = requireString(manifest, 'displayVersion')
  const bundleVersion = requireString(manifest, 'bundleVersion')
  if (!/^\d+\.\d+\.\d+$/.test(bundleVersion)) {
    throw new WindowsAlphaReleaseError(
      'invalid-bundle-version',
      'release.json bundleVersion must be a three-part numeric version.'
    )
  }
  const expectedReleaseId = `${bundleVersion}-alpha.1`
  if (releaseId !== expectedReleaseId) {
    throw new WindowsAlphaReleaseError(
      'invalid-release-id',
      `release.json releaseId must be ${expectedReleaseId}; every candidate or correction must bump the numeric package version.`
    )
  }
  if (
    displayVersion !== releaseId &&
    displayVersion.toLowerCase() !== `${bundleVersion} alpha 1`.toLowerCase()
  ) {
    throw new WindowsAlphaReleaseError(
      'invalid-display-version',
      `release.json displayVersion must be ${releaseId} or ${bundleVersion} Alpha 1.`
    )
  }
  const expectedFilename = `Videorc-${bundleVersion}-win-x64.exe`
  if (filename !== expectedFilename) {
    throw new WindowsAlphaReleaseError(
      'stale-installer-filename',
      `release.json filename must be ${expectedFilename}. Remove stale artifacts and rebuild.`
    )
  }
  requireString(manifest, 'publisherName')
  const releasedAt = requireString(manifest, 'releasedAt')
  if (!isCanonicalIsoTimestamp(releasedAt)) {
    throw new WindowsAlphaReleaseError(
      'invalid-released-at',
      'release.json releasedAt must be a canonical UTC ISO-8601 timestamp.'
    )
  }
  const minimumOS = requireString(manifest, 'minimumOS')
  const minimumWindows = requireString(manifest, 'minimumWindows')
  if (minimumOS !== minimumWindows || !/Windows 11/i.test(minimumOS)) {
    throw new WindowsAlphaReleaseError(
      'invalid-minimum-windows',
      'release.json minimumOS and minimumWindows must match and explicitly name Windows 11.'
    )
  }

  const objectKey = requireString(manifest, 'objectKey')
  const expectedObjectKey = `releases/windows/${releaseId}/${filename}`
  if (objectKey !== expectedObjectKey) {
    throw new WindowsAlphaReleaseError(
      'invalid-object-key',
      `release.json objectKey must be ${expectedObjectKey}.`
    )
  }

  const sha256 = requireString(manifest, 'sha256')
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new WindowsAlphaReleaseError(
      'invalid-sha256',
      'release.json sha256 must be a 64-character hexadecimal digest.'
    )
  }
  if (!Number.isSafeInteger(manifest?.sizeBytes) || manifest.sizeBytes <= 0) {
    throw new WindowsAlphaReleaseError(
      'invalid-size-bytes',
      'release.json sizeBytes must be a positive integer.'
    )
  }

  const releaseNotesUrl = requireHttpsUrl(manifest, 'releaseNotesUrl')
  const expectedReleaseNotesUrl = `${CANONICAL_RELEASE_ORIGIN}/releases/${releaseId}`
  if (releaseNotesUrl.toString() !== expectedReleaseNotesUrl) {
    throw new WindowsAlphaReleaseError(
      'invalid-release-notes-url',
      `release.json releaseNotesUrl must be ${expectedReleaseNotesUrl}.`
    )
  }
  const knownIssuesUrl = requireHttpsUrl(manifest, 'knownIssuesUrl')
  if (knownIssuesUrl.toString() !== DEFAULT_KNOWN_ISSUES_URL) {
    throw new WindowsAlphaReleaseError(
      'invalid-known-issues-url',
      `release.json knownIssuesUrl must be ${DEFAULT_KNOWN_ISSUES_URL}.`
    )
  }

  const sourceCommit = requireString(manifest, 'sourceCommit')
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) {
    throw new WindowsAlphaReleaseError(
      'invalid-source-commit',
      'release.json sourceCommit must be the full 40-character Git commit SHA.'
    )
  }

  const acceptanceStatus = requireString(manifest, 'acceptanceStatus')
  if (!['pending', 'pass', 'failed'].includes(acceptanceStatus)) {
    throw new WindowsAlphaReleaseError(
      'invalid-acceptance-status',
      'release.json acceptanceStatus must be pending, pass, or failed.'
    )
  }
  const acceptanceRecordUrl = optionalString(manifest?.acceptanceRecordUrl)
  if (acceptanceRecordUrl) {
    parseHttpsUrl(acceptanceRecordUrl, 'acceptanceRecordUrl')
  }
  if ((requireAccepted || acceptanceStatus === 'pass') && !acceptanceRecordUrl) {
    throw new WindowsAlphaReleaseError(
      'missing-acceptance-record-url',
      'An accepted Windows release must include a dated HTTPS acceptanceRecordUrl.'
    )
  }
  if (requireAccepted && acceptanceStatus !== 'pass') {
    throw new WindowsAlphaReleaseError(
      'release-not-accepted',
      'Stable Windows promotion requires acceptanceStatus=pass.'
    )
  }

  return manifest
}

export function updateFeedArtifactNameFromYml(ymlText) {
  return tryParseWindowsUpdateFeed(ymlText)?.path ?? null
}

export function updateFeedVersionFromYml(ymlText) {
  return tryParseWindowsUpdateFeed(ymlText)?.version ?? null
}

export function updateFeedSha512FromYml(ymlText) {
  return tryParseWindowsUpdateFeed(ymlText)?.sha512 ?? null
}

export function updateFeedFileMetadataFromYml(ymlText, artifactName) {
  const feed = tryParseWindowsUpdateFeed(ymlText)
  return feed?.files[0]?.url === artifactName ? feed.files[0] : null
}

export function parseWindowsUpdateFeed(ymlText) {
  let feed
  try {
    feed = loadYaml(String(ymlText), { json: false, schema: JSON_SCHEMA })
  } catch (error) {
    throw new WindowsAlphaReleaseError(
      'invalid-update-feed-yaml',
      `latest.yml must be strict YAML without duplicate keys: ${error?.message ?? 'parse error'}.`
    )
  }
  if (!isExactObject(feed, ['files', 'path', 'releaseDate', 'sha512', 'version'])) {
    throw new WindowsAlphaReleaseError(
      'invalid-update-feed-schema',
      'latest.yml must contain only version, one files entry, path, sha512, and releaseDate.'
    )
  }
  if (
    typeof feed.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(feed.version) ||
    typeof feed.path !== 'string' ||
    !/^Videorc-\d+\.\d+\.\d+-win-x64\.exe$/.test(feed.path) ||
    typeof feed.sha512 !== 'string' ||
    !isCanonicalIsoTimestamp(feed.releaseDate) ||
    !Array.isArray(feed.files) ||
    feed.files.length !== 1
  ) {
    throw new WindowsAlphaReleaseError(
      'invalid-update-feed-schema',
      'latest.yml must be a canonical single-installer Windows x64 update feed.'
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
    throw new WindowsAlphaReleaseError(
      'invalid-update-feed-file',
      'latest.yml must contain exactly one relative installer with matching SHA-512 and positive byte size.'
    )
  }
  return feed
}

function tryParseWindowsUpdateFeed(ymlText) {
  try {
    return parseWindowsUpdateFeed(ymlText)
  } catch {
    return null
  }
}

export function compareNumericVersions(left, right) {
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new WindowsAlphaReleaseError(
        'invalid-update-version',
        `Updater version must be a three-part numeric version, got ${value}.`
      )
    }
    return value.split('.').map(Number)
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1
    }
  }
  return 0
}

function requireString(object, field) {
  const value = optionalString(object?.[field])
  if (!value) {
    throw new WindowsAlphaReleaseError(`missing-${field}`, `release.json must include ${field}.`)
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
    throw new WindowsAlphaReleaseError(
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

function unquoteYamlScalar(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
