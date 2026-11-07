// Compatibility entry point for existing Alpha consumers. Beta callers use linux-release.mjs.
import {
  parseLinuxReleaseId,
  buildLinuxReleaseManifest,
  assertLinuxReleaseManifest,
  LinuxReleaseError
} from './linux-release.mjs'
export {
  assertLinuxAppImageArtifactNameTemplate,
  findLatestLinuxAppImage,
  assertLinuxAppImageFilename,
  sha256File,
  sha512File,
  formatSha256File,
  buildLinuxUpdateFeedYml,
  parseLinuxUpdateFeed,
  updateFeedArtifactNameFromYml,
  updateFeedVersionFromYml,
  updateFeedSha512FromYml,
  updateFeedFileMetadataFromYml,
  assertIsolatedLinuxObjectKey,
  LinuxReleaseError as LinuxAlphaReleaseError,
  linuxAppImageFilename as linuxAlphaAppImageFilename,
  LINUX_UPDATE_FEED_NAME as LINUX_ALPHA_UPDATE_FEED_NAME
} from './linux-release.mjs'
export const LINUX_ALPHA_PUBLIC_PREFIX = 'releases/linux-alpha'
export function parseLinuxAlphaReleaseId(value) {
  const parsed = parseLinuxReleaseId(value)
  if (parsed.channel !== 'alpha')
    throw new LinuxReleaseError('invalid-release-id', 'Expected a Linux Alpha release ID.')
  return { bundleVersion: parsed.bundleVersion, prereleaseNumber: parsed.prereleaseNumber }
}
export function assertLinuxAlphaReleaseManifest(manifest, options) {
  parseLinuxAlphaReleaseId(manifest?.releaseId)
  return assertLinuxReleaseManifest(manifest, options)
}
export function buildLinuxAlphaReleaseManifest(input) {
  const manifest = buildLinuxReleaseManifest(input)
  assertLinuxAlphaReleaseManifest(manifest)
  return manifest
}
