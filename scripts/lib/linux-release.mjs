import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

const DEFAULT_MINIMUM_LINUX = 'Ubuntu 24.04 LTS or later'
const knownIssuesUrlFor = (channel) => `https://www.videorc.com/linux-${channel}`
const CANONICAL_RELEASE_ORIGIN = 'https://www.videorc.com'
const APPIMAGE_NAME = /^Videorc-[A-Za-z0-9][A-Za-z0-9.+-]*-linux-x64\.AppImage$/
const RELEASE_ID = /^(\d+\.\d+\.\d+)-(alpha|beta)\.([1-9]\d*)$/

export const linuxPublicPrefix = (channel) => {
  if (!['alpha', 'beta'].includes(channel))
    throw new LinuxReleaseError('invalid-channel', 'Unknown Linux release channel.')
  return `releases/linux-${channel}`
}
export const LINUX_UPDATE_FEED_NAME = 'latest-linux.yml'

export function linuxAppImageFilename(bundleVersion) {
  return `Videorc-${bundleVersion}-linux-x64.AppImage`
}

export function assertLinuxAppImageArtifactNameTemplate(template) {
  const value = requireNonEmpty(template, 'linux artifactName')
  if (value.includes('${arch}')) {
    throw new LinuxReleaseError(
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
  const expected = linuxAppImageFilename('0.10.0')
  if (expanded !== expected) {
    throw new LinuxReleaseError(
      'linux-artifact-name-mismatch',
      `Linux artifactName must produce ${expected}, got ${expanded}.`
    )
  }
  return value
}

export class LinuxReleaseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LinuxReleaseError'
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
    throw new LinuxReleaseError(
      'invalid-appimage-filename',
      `Linux AppImage must be named Videorc-<version>-linux-x64.AppImage, got ${filename}.`
    )
  }
  return filename
}

export function parseLinuxReleaseId(releaseId) {
  const match = RELEASE_ID.exec(nonEmpty(releaseId) ?? '')
  if (!match) {
    throw new LinuxReleaseError(
      'invalid-release-id',
      'Linux releaseId must be <package version>-alpha.N or <package version>-beta.N.'
    )
  }
  if (!Number.isSafeInteger(Number(match[3])))
    throw new LinuxReleaseError('invalid-release-id', 'Invalid prerelease number.')
  return { bundleVersion: match[1], channel: match[2], prereleaseNumber: Number(match[3]) }
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

export function buildLinuxReleaseManifest({
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
  const parsed = parseLinuxReleaseId(releaseId)
  const displayVersion =
    nonEmpty(env.VIDEORC_RELEASE_DISPLAY_VERSION) ??
    `${parsed.bundleVersion} ${parsed.channel} ${parsed.prereleaseNumber}`
  const acceptanceStatus =
    nonEmpty(env.VIDEORC_LINUX_ACCEPTANCE_STATUS) ??
    nonEmpty(env.VIDEORC_RELEASE_ACCEPTANCE_STATUS) ??
    'pending'
  const acceptanceRecordUrl =
    nonEmpty(env.VIDEORC_LINUX_ACCEPTANCE_RECORD_URL) ??
    nonEmpty(env.VIDEORC_RELEASE_ACCEPTANCE_RECORD_URL)

  const manifest = {
    product: 'Videorc',
    channel: parsed.channel,
    releaseId,
    displayVersion,
    bundleVersion: packageVersion,
    platform: 'linux',
    architecture: 'x64',
    filename,
    objectKey: `${linuxPublicPrefix(parsed.channel)}/${releaseId}/${filename}`,
    sha256,
    sizeBytes,
    minimumOS:
      nonEmpty(env.VIDEORC_RELEASE_MINIMUM_LINUX) ??
      (parsed.channel === 'beta'
        ? 'Ubuntu 24.04 LTS GNOME/Wayland or Omarchy Hyprland/Wayland, x64'
        : DEFAULT_MINIMUM_LINUX),
    releasedAt,
    releaseNotesUrl:
      nonEmpty(env.VIDEORC_RELEASE_NOTES_URL) ??
      `${CANONICAL_RELEASE_ORIGIN}/releases/${releaseId}`,
    knownIssuesUrl:
      nonEmpty(env.VIDEORC_LINUX_KNOWN_ISSUES_URL) ?? knownIssuesUrlFor(parsed.channel),
    signingStatus: 'unsigned',
    acceptanceStatus,
    acceptanceRecordUrl,
    sourceCommit: nonEmpty(sourceCommit),
    stage: nonEmpty(env.VIDEORC_LINUX_RELEASE_STAGE) ?? 'candidate'
  }

  assertLinuxReleaseManifest(manifest)
  return manifest
}

export function assertLinuxReleaseManifest(manifest, { requireAccepted = false } = {}) {
  const releaseId = requireString(manifest, 'releaseId')
  const filename = assertLinuxAppImageFilename(requireString(manifest, 'filename'))
  if (manifest.filename !== filename) {
    throw new LinuxReleaseError(
      'invalid-manifest-filename',
      'release.json filename must be a bare AppImage filename without a directory or whitespace.'
    )
  }
  const parsed = parseLinuxReleaseId(releaseId)

  for (const [field, expected] of [
    ['product', 'Videorc'],
    ['channel', parsed.channel],
    ['platform', 'linux'],
    ['architecture', 'x64'],
    ['signingStatus', 'unsigned']
  ]) {
    if (manifest?.[field] !== expected) {
      throw new LinuxReleaseError(`invalid-${field}`, `release.json ${field} must be ${expected}.`)
    }
  }

  const displayVersion = requireString(manifest, 'displayVersion')
  const bundleVersion = requireString(manifest, 'bundleVersion')
  if (!/^\d+\.\d+\.\d+$/.test(bundleVersion)) {
    throw new LinuxReleaseError(
      'invalid-bundle-version',
      'release.json bundleVersion must be a three-part numeric version.'
    )
  }
  if (parsed.bundleVersion !== bundleVersion) {
    throw new LinuxReleaseError(
      'invalid-release-id',
      `release.json releaseId must start with ${bundleVersion}-${parsed.channel}.`
    )
  }
  if (
    displayVersion !== releaseId &&
    displayVersion.toLowerCase() !==
      `${bundleVersion} ${parsed.channel} ${parsed.prereleaseNumber}`.toLowerCase()
  ) {
    throw new LinuxReleaseError(
      'invalid-display-version',
      `release.json displayVersion must be ${releaseId} or ${bundleVersion} ${parsed.channel} ${parsed.prereleaseNumber}.`
    )
  }
  const expectedFilename = linuxAppImageFilename(bundleVersion)
  if (filename !== expectedFilename) {
    throw new LinuxReleaseError(
      'stale-appimage-filename',
      `release.json filename must be ${expectedFilename}. Remove stale artifacts and rebuild.`
    )
  }

  const releasedAt = requireString(manifest, 'releasedAt')
  if (!isCanonicalIsoTimestamp(releasedAt)) {
    throw new LinuxReleaseError(
      'invalid-released-at',
      'release.json releasedAt must be a canonical UTC ISO-8601 timestamp.'
    )
  }
  const minimumOS = requireString(manifest, 'minimumOS')
  if (!/Ubuntu 24\.04/i.test(minimumOS)) {
    throw new LinuxReleaseError(
      'invalid-minimum-linux',
      'release.json minimumOS must explicitly name Ubuntu 24.04.'
    )
  }
  if (
    parsed.channel === 'beta' &&
    !['GNOME', 'Wayland', 'Omarchy', 'Hyprland', 'x64'].every((term) => minimumOS.includes(term))
  ) {
    throw new LinuxReleaseError(
      'invalid-beta-platform-scope',
      'Linux Beta must name both supported Wayland desktops and x64.'
    )
  }

  const objectKey = assertIsolatedLinuxObjectKey(requireString(manifest, 'objectKey'))
  const expectedObjectKey = `${linuxPublicPrefix(parsed.channel)}/${releaseId}/${filename}`
  if (objectKey !== expectedObjectKey) {
    throw new LinuxReleaseError(
      'invalid-object-key',
      `release.json objectKey must be ${expectedObjectKey}.`
    )
  }

  const sha256 = requireString(manifest, 'sha256')
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new LinuxReleaseError(
      'invalid-sha256',
      'release.json sha256 must be a 64-character hexadecimal digest.'
    )
  }
  if (!Number.isSafeInteger(manifest?.sizeBytes) || manifest.sizeBytes <= 0) {
    throw new LinuxReleaseError(
      'invalid-size-bytes',
      'release.json sizeBytes must be a positive integer.'
    )
  }

  const releaseNotesUrl = requireHttpsUrl(manifest, 'releaseNotesUrl')
  const expectedReleaseNotesUrl = `${CANONICAL_RELEASE_ORIGIN}/releases/${releaseId}`
  if (releaseNotesUrl.toString() !== expectedReleaseNotesUrl) {
    throw new LinuxReleaseError(
      'invalid-release-notes-url',
      `release.json releaseNotesUrl must be ${expectedReleaseNotesUrl}.`
    )
  }
  const knownIssuesUrl = requireHttpsUrl(manifest, 'knownIssuesUrl')
  if (knownIssuesUrl.toString() !== knownIssuesUrlFor(parsed.channel)) {
    throw new LinuxReleaseError(
      'invalid-known-issues-url',
      `release.json knownIssuesUrl must be ${knownIssuesUrlFor(parsed.channel)}.`
    )
  }

  const sourceCommit = requireString(manifest, 'sourceCommit')
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) {
    throw new LinuxReleaseError(
      'invalid-source-commit',
      'release.json sourceCommit must be the full 40-character Git commit SHA.'
    )
  }

  const acceptanceStatus = requireString(manifest, 'acceptanceStatus')
  if (!['pending', 'pass', 'waived', 'failed'].includes(acceptanceStatus)) {
    throw new LinuxReleaseError(
      'invalid-acceptance-status',
      'release.json acceptanceStatus must be pending, pass, waived, or failed.'
    )
  }
  const acceptanceRecordUrl = optionalString(manifest?.acceptanceRecordUrl)
  if (acceptanceRecordUrl) {
    parseHttpsUrl(acceptanceRecordUrl, 'acceptanceRecordUrl')
  }
  if (parsed.channel === 'beta' && acceptanceStatus === 'waived') {
    throw new LinuxReleaseError(
      'beta-acceptance-not-pass',
      'Linux Beta cannot use an Alpha owner waiver.'
    )
  }
  const published = acceptanceStatus === 'pass' || acceptanceStatus === 'waived'
  if (
    parsed.channel === 'beta' &&
    published &&
    !new RegExp(
      `^https://github\\.com/TheOrcDev/videorc/blob/[a-f0-9]{40}/docs/acceptance/linux-beta/${releaseId.replaceAll('.', '\\.')}\\.json$`
    ).test(acceptanceRecordUrl ?? '')
  ) {
    throw new LinuxReleaseError(
      'invalid-beta-acceptance-url',
      'Linux Beta requires a commit-pinned acceptance record in this repository.'
    )
  }
  if ((requireAccepted || published) && !acceptanceRecordUrl) {
    throw new LinuxReleaseError(
      'missing-acceptance-record-url',
      'An accepted Linux release must include a dated HTTPS acceptanceRecordUrl.'
    )
  }
  if (requireAccepted && !published) {
    throw new LinuxReleaseError(
      'release-not-accepted',
      'Stable Linux promotion requires acceptanceStatus=pass or an owner waiver.'
    )
  }

  const stage = requireString(manifest, 'stage')
  if (!['candidate', 'pilot', 'public'].includes(stage)) {
    throw new LinuxReleaseError(
      'invalid-stage',
      'release.json stage must be candidate, pilot, or public.'
    )
  }
  if (stage === 'public' && !published) {
    throw new LinuxReleaseError(
      'public-stage-not-accepted',
      'release.json stage=public requires acceptanceStatus=pass or waived.'
    )
  }

  return manifest
}

export function buildLinuxUpdateFeedYml({ filename, releaseDate, sha512, sizeBytes, version }) {
  assertLinuxAppImageFilename(filename)
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new LinuxReleaseError(
      'invalid-update-version',
      `latest-linux.yml version must be a three-part numeric version, got ${version}.`
    )
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sha512 ?? '')) {
    throw new LinuxReleaseError(
      'invalid-update-sha512',
      'latest-linux.yml sha512 must be a base64 SHA-512 digest.'
    )
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new LinuxReleaseError(
      'invalid-update-size',
      'latest-linux.yml size must be a positive integer.'
    )
  }
  if (!isCanonicalIsoTimestamp(releaseDate)) {
    throw new LinuxReleaseError(
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
    throw new LinuxReleaseError(
      'invalid-update-feed-yaml',
      `latest-linux.yml must be strict YAML without duplicate keys: ${error?.message ?? 'parse error'}.`
    )
  }
  if (!isExactObject(feed, ['files', 'path', 'releaseDate', 'sha512', 'version'])) {
    throw new LinuxReleaseError(
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
    throw new LinuxReleaseError(
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
    throw new LinuxReleaseError(
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
    throw new LinuxReleaseError(
      'cross-platform-object-key',
      `Linux Alpha must never write macOS or Windows release keys, got ${key}.`
    )
  }
  if (/(^|\/)latest\.yml$/.test(key)) {
    throw new LinuxReleaseError(
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
    throw new LinuxReleaseError(`missing-${field}`, `release.json must include ${field}.`)
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
    throw new LinuxReleaseError(
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
    throw new LinuxReleaseError(`missing-${label.replaceAll(' ', '-')}`, `Missing ${label}.`)
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
