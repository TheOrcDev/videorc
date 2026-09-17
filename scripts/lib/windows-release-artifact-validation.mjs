import {
  assertWindowsAlphaReleaseManifest,
  updateFeedArtifactNameFromYml,
  updateFeedFileMetadataFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml
} from './windows-alpha-release.mjs'

export class WindowsReleaseValidationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WindowsReleaseValidationError'
    this.code = code
  }
}

export function validateWindowsReleaseFacts({
  actualSha256,
  actualSha512,
  actualSizeBytes,
  appSignature,
  appUpdateYml,
  expectedPublisher,
  expectedSourceCommit,
  feedYml,
  files,
  manifest,
  sha256FileText,
  signature
}) {
  assertWindowsAlphaReleaseManifest(manifest)
  const checks = []
  const requireCheck = (id, ok, message) => {
    if (!ok) {
      throw new WindowsReleaseValidationError(id, message)
    }
    checks.push({ id, ok: true })
  }

  requireCheck(
    'publisher-contract',
    Boolean(expectedPublisher) && manifest.publisherName === expectedPublisher,
    'release.json publisherName must exactly match VIDEORC_WINDOWS_PUBLISHER_NAME.'
  )
  requireCheck(
    'source-commit-contract',
    /^[a-f0-9]{40}$/i.test(expectedSourceCommit ?? '') &&
      manifest.sourceCommit === expectedSourceCommit,
    'release.json sourceCommit must exactly match the checked-out Git commit.'
  )
  requireCheck(
    'signature-status',
    signature?.status === 'Valid',
    `Installer Authenticode status must be Valid, got ${signature?.status ?? 'missing'}.`
  )
  requireCheck(
    'signature-publisher',
    signature?.publisher === expectedPublisher,
    `Installer signer must exactly match ${expectedPublisher}.`
  )
  requireCheck(
    'signature-timestamp',
    signature?.timestampPresent === true,
    'Installer signature must include a timestamp countersignature.'
  )
  requireCheck(
    'app-signature',
    appSignature?.status === 'Valid' &&
      appSignature?.publisher === expectedPublisher &&
      appSignature?.timestampPresent === true,
    'Packaged Videorc.exe must have a valid timestamped signature from the exact expected publisher.'
  )
  requireCheck(
    'artifact-sha256',
    actualSha256.toLowerCase() === manifest.sha256.toLowerCase(),
    'Installer SHA-256 does not match release.json.'
  )
  requireCheck(
    'artifact-size',
    actualSizeBytes === manifest.sizeBytes,
    'Installer byte size does not match release.json.'
  )
  requireCheck(
    'sha256-sidecar',
    sha256FileText.trim() === `${manifest.sha256}  ${manifest.filename}`,
    'Installer .sha256 sidecar does not exactly match release.json.'
  )
  requireCheck(
    'update-feed-artifact',
    updateFeedArtifactNameFromYml(feedYml) === manifest.filename,
    'latest.yml must reference the exact accepted installer filename.'
  )
  requireCheck(
    'update-feed-version',
    updateFeedVersionFromYml(feedYml) === manifest.bundleVersion,
    'latest.yml version must match release.json bundleVersion.'
  )
  const feedFile = updateFeedFileMetadataFromYml(feedYml, manifest.filename)
  requireCheck(
    'update-feed-sha512',
    typeof actualSha512 === 'string' &&
      updateFeedSha512FromYml(feedYml) === actualSha512 &&
      feedFile?.sha512 === actualSha512,
    'latest.yml top-level and files-entry SHA-512 values must match the installer.'
  )
  requireCheck(
    'update-feed-size',
    feedFile?.size === actualSizeBytes,
    'latest.yml files-entry byte size must match the installer.'
  )
  requireCheck(
    'baked-update-provider',
    hasExactWindowsAppUpdateConfig(appUpdateYml, expectedPublisher),
    'Packaged app-update.yml must use the branded updater route and exact pinned publisherName.'
  )
  for (const [name, present] of Object.entries(files)) {
    requireCheck(
      `file-${name}`,
      Boolean(present),
      `Missing required Windows release file: ${name}.`
    )
  }

  return { checks, ok: true }
}

export function hasExactWindowsAppUpdateConfig(ymlText, expectedPublisher) {
  return Boolean(
    expectedPublisher &&
    hasExactYamlScalar(ymlText, 'provider', 'generic') &&
    hasExactYamlScalar(ymlText, 'url', 'https://www.videorc.com/api/updates/') &&
    hasExactYamlStringOrSingleItemList(ymlText, 'publisherName', expectedPublisher)
  )
}

function hasExactYamlScalar(ymlText, field, expected) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(ymlText ?? '').match(
    new RegExp(`^${escaped}:[^\\S\\r\\n]*(.+?)[^\\S\\r\\n]*$`, 'm')
  )
  const value = match?.[1]?.trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
  return value === expected
}

function hasExactYamlStringOrSingleItemList(ymlText, field, expected) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = String(ymlText ?? '').split(/\r?\n/)
  const index = lines.findIndex((line) => new RegExp(`^${escaped}:`).test(line))
  if (index === -1) return false
  const scalar = lines[index].slice(lines[index].indexOf(':') + 1).trim()
  if (scalar) return unquoteYamlScalar(scalar) === expected

  const values = []
  for (const line of lines.slice(index + 1)) {
    if (line && !/^\s/.test(line)) break
    const match = /^\s+-\s+(.+?)\s*$/.exec(line)
    if (match) values.push(unquoteYamlScalar(match[1]))
  }
  return values.length === 1 && values[0] === expected
}

function unquoteYamlScalar(value) {
  return value.trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
}

export function formatWindowsReleaseValidationReport(result) {
  return [
    'windows-release-artifact: PASS',
    ...result.checks.map((check) => `[ok] ${check.id}`)
  ].join('\n')
}
