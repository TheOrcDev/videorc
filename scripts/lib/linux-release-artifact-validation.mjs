import {
  assertLinuxAlphaReleaseManifest,
  updateFeedArtifactNameFromYml,
  updateFeedFileMetadataFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml
} from './linux-alpha-release.mjs'

export class LinuxReleaseValidationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LinuxReleaseValidationError'
    this.code = code
  }
}

export function validateLinuxReleaseFacts({
  actualSha256,
  actualSha512,
  actualSizeBytes,
  expectedSourceCommit,
  feedYml,
  ffmpegCapabilities,
  files,
  manifest,
  sha256FileText
}) {
  assertLinuxAlphaReleaseManifest(manifest)
  const checks = []
  const requireCheck = (id, ok, message) => {
    if (!ok) {
      throw new LinuxReleaseValidationError(id, message)
    }
    checks.push({ id, ok: true })
  }

  requireCheck(
    'source-commit-contract',
    /^[a-f0-9]{40}$/i.test(expectedSourceCommit ?? '') &&
      manifest.sourceCommit === expectedSourceCommit,
    'release.json sourceCommit must exactly match the checked-out Git commit.'
  )
  requireCheck(
    'candidate-stage',
    manifest.stage === 'candidate',
    'A stored Linux Alpha candidate must have stage=candidate.'
  )
  requireCheck(
    'unsigned-contract',
    manifest.signingStatus === 'unsigned',
    'Linux Alpha AppImage releases are unsigned.'
  )
  requireCheck(
    'artifact-sha256',
    actualSha256.toLowerCase() === manifest.sha256.toLowerCase(),
    'AppImage SHA-256 does not match release.json.'
  )
  requireCheck(
    'artifact-size',
    actualSizeBytes === manifest.sizeBytes,
    'AppImage byte size does not match release.json.'
  )
  requireCheck(
    'sha256-sidecar',
    sha256FileText.trim() === `${manifest.sha256}  ${manifest.filename}`,
    'AppImage .sha256 sidecar does not exactly match release.json.'
  )
  requireCheck(
    'update-feed-artifact',
    updateFeedArtifactNameFromYml(feedYml) === manifest.filename,
    'latest-linux.yml must reference the exact AppImage filename.'
  )
  requireCheck(
    'update-feed-version',
    updateFeedVersionFromYml(feedYml) === manifest.bundleVersion,
    'latest-linux.yml version must match release.json bundleVersion.'
  )
  const feedFile = updateFeedFileMetadataFromYml(feedYml, manifest.filename)
  requireCheck(
    'update-feed-sha512',
    typeof actualSha512 === 'string' &&
      updateFeedSha512FromYml(feedYml) === actualSha512 &&
      feedFile?.sha512 === actualSha512,
    'latest-linux.yml top-level and files-entry SHA-512 values must match the AppImage.'
  )
  requireCheck(
    'update-feed-size',
    feedFile?.size === actualSizeBytes,
    'latest-linux.yml files-entry byte size must match the AppImage.'
  )
  requireCheck(
    'ffmpeg-lgpl',
    ffmpegCapabilities?.ok === true,
    `Bundled Linux FFmpeg failed the LGPL VAAPI/OpenH264 contract: ${(
      ffmpegCapabilities?.problems ?? ['missing capability report']
    ).join('; ')}.`
  )
  for (const [name, present] of Object.entries(files)) {
    requireCheck(`file-${name}`, Boolean(present), `Missing required Linux release file: ${name}.`)
  }

  return { checks, ok: true }
}

export function formatLinuxReleaseValidationReport(result) {
  return ['linux-release-artifact: PASS', ...result.checks.map((check) => `[ok] ${check.id}`)].join(
    '\n'
  )
}
