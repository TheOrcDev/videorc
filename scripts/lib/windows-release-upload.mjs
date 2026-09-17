import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import {
  assertWindowsAlphaReleaseManifest,
  formatSha256File,
  sha256File,
  sha512File,
  updateFeedArtifactNameFromYml,
  updateFeedFileMetadataFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml,
  WindowsAlphaReleaseError
} from './windows-alpha-release.mjs'

const CONTENT_TYPES = new Map([
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.json', 'application/json'],
  ['.sha256', 'text/plain; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.yml', 'text/yaml; charset=utf-8'],
  ['.blockmap', 'application/octet-stream']
])

export async function buildWindowsReleaseUploadPlan({
  changelogJsonPath = null,
  env = process.env,
  ffmpegLicensePath,
  ffmpegSourcePath,
  manifest,
  manifestPath,
  releaseDir
}) {
  const stage = releaseStage(env)
  assertWindowsAlphaReleaseManifest(manifest, { requireAccepted: stage === 'public' })
  if (stage === 'pilot' && manifest.acceptanceStatus !== 'pending') {
    throw new WindowsAlphaReleaseError(
      'invalid-pilot-acceptance-status',
      'Pilot publication requires the exact signed candidate manifest with acceptanceStatus=pending.'
    )
  }
  const prefix = exactObjectPrefix(
    env.VIDEORC_WINDOWS_RELEASE_UPLOAD_PREFIX,
    `releases/windows/${manifest.releaseId}`,
    'VIDEORC_WINDOWS_RELEASE_UPLOAD_PREFIX'
  )
  const latestManifestPrefix =
    stage === 'pilot'
      ? exactObjectPrefix(
          env.VIDEORC_WINDOWS_PILOT_LATEST_MANIFEST_PREFIX,
          'releases/windows/pilot',
          'VIDEORC_WINDOWS_PILOT_LATEST_MANIFEST_PREFIX'
        )
      : exactObjectPrefix(
          env.VIDEORC_WINDOWS_RELEASE_LATEST_MANIFEST_PREFIX,
          'releases/windows/latest',
          'VIDEORC_WINDOWS_RELEASE_LATEST_MANIFEST_PREFIX'
        )
  const updatesPrefix =
    stage === 'pilot'
      ? exactObjectPrefix(
          env.VIDEORC_WINDOWS_PILOT_UPDATES_PREFIX,
          'updates/windows/pilot',
          'VIDEORC_WINDOWS_PILOT_UPDATES_PREFIX'
        )
      : exactObjectPrefix(
          env.VIDEORC_WINDOWS_RELEASE_UPDATES_PREFIX,
          'updates/windows',
          'VIDEORC_WINDOWS_RELEASE_UPDATES_PREFIX'
        )
  const changelogPrefix = exactObjectPrefix(
    env.VIDEORC_RELEASE_CHANGELOG_PREFIX,
    'changelog',
    'VIDEORC_RELEASE_CHANGELOG_PREFIX'
  )
  const feedYmlPath = join(releaseDir, 'latest.yml')
  const feedYml = await readRequiredText(feedYmlPath, 'latest.yml')

  if (updateFeedArtifactNameFromYml(feedYml) !== manifest.filename) {
    throw new WindowsAlphaReleaseError(
      'update-feed-artifact-mismatch',
      `latest.yml must reference ${manifest.filename}.`
    )
  }
  if (updateFeedVersionFromYml(feedYml) !== manifest.bundleVersion) {
    throw new WindowsAlphaReleaseError(
      'update-feed-version-mismatch',
      `latest.yml version must be ${manifest.bundleVersion}.`
    )
  }

  const installerPath = join(releaseDir, manifest.filename)
  const installerSize = await requiredSize(installerPath, 'installer')
  const installerSha256 = await sha256File(installerPath)
  const installerSha512 = await sha512File(installerPath)
  if (installerSize !== manifest.sizeBytes || installerSha256 !== manifest.sha256) {
    throw new WindowsAlphaReleaseError(
      'installer-manifest-mismatch',
      'The installer byte size and SHA-256 must exactly match release.json immediately before upload.'
    )
  }
  const sha256Path = join(releaseDir, `${manifest.filename}.sha256`)
  const sha256Text = await readRequiredText(sha256Path, `${manifest.filename}.sha256`)
  if (sha256Text !== formatSha256File({ sha256: manifest.sha256, filename: manifest.filename })) {
    throw new WindowsAlphaReleaseError(
      'sha256-sidecar-mismatch',
      'The SHA-256 sidecar must exactly match the installer and release.json.'
    )
  }
  const feedFile = updateFeedFileMetadataFromYml(feedYml, manifest.filename)
  if (
    updateFeedSha512FromYml(feedYml) !== installerSha512 ||
    feedFile?.sha512 !== installerSha512 ||
    feedFile?.size !== installerSize
  ) {
    throw new WindowsAlphaReleaseError(
      'update-feed-integrity-mismatch',
      'latest.yml SHA-512 and byte size must exactly match the installer.'
    )
  }

  const artifacts = [
    artifact('installer', `${prefix}/${manifest.filename}`, installerPath, true),
    artifact('sha256', `${prefix}/${manifest.filename}.sha256`, sha256Path, true),
    ...(stage === 'public'
      ? [artifact('manifest', `${prefix}/release.json`, manifestPath, true)]
      : []),
    artifact('ffmpeg-license', `${prefix}/FFMPEG-LICENSE.txt`, ffmpegLicensePath, true),
    artifact('ffmpeg-source', `${prefix}/FFMPEG-SOURCE.txt`, ffmpegSourcePath, true),
    artifact('feed-installer', `${updatesPrefix}/${manifest.filename}`, installerPath, true),
    artifact(
      'feed-blockmap',
      `${updatesPrefix}/${manifest.filename}.blockmap`,
      join(releaseDir, `${manifest.filename}.blockmap`),
      true
    )
  ]

  if (stage === 'public' && changelogJsonPath) {
    artifacts.push(
      artifact('changelog', `${changelogPrefix}/changelog.json`, changelogJsonPath, false)
    )
  }

  // Mutable pointers are intentionally last. A failed upload can leave inert,
  // immutable objects behind, but must not advertise a feed or human download
  // before every referenced object and the changelog are already present.
  artifacts.push(
    artifact('feed-manifest', `${updatesPrefix}/latest.yml`, feedYmlPath, false),
    artifact('latest-manifest', `${latestManifestPrefix}/release.json`, manifestPath, false)
  )

  return {
    artifacts: await Promise.all(
      artifacts.map(async (item) => ({
        ...item,
        sha256: await sha256File(item.path),
        sizeBytes: await requiredSize(item.path, item.label)
      }))
    ),
    latestManifestPrefix,
    prefix,
    releaseId: manifest.releaseId,
    stage,
    updatesPrefix
  }
}

function artifact(label, objectKey, path, immutable) {
  return { contentType: contentType(path), immutable, label, objectKey, path: resolve(path) }
}

function contentType(path) {
  const name = basename(path)
  const extension = name.endsWith('.sha256')
    ? '.sha256'
    : name.slice(Math.max(0, name.lastIndexOf('.'))).toLowerCase()
  return CONTENT_TYPES.get(extension) ?? 'application/octet-stream'
}

function objectPrefix(value, fallback) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  const parts = text.split('/').filter(Boolean)
  if (
    parts.length === 0 ||
    parts.some(
      (part) => part === '.' || part === '..' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(part)
    )
  ) {
    throw new WindowsAlphaReleaseError(
      'invalid-upload-prefix',
      `Invalid release upload prefix: ${text}.`
    )
  }
  return parts.join('/')
}

function exactObjectPrefix(value, expected, variableName) {
  const prefix = objectPrefix(value, expected)
  if (prefix !== expected) {
    throw new WindowsAlphaReleaseError(
      'noncanonical-upload-prefix',
      `${variableName} must be ${expected}; got ${prefix}.`
    )
  }
  return prefix
}

function releaseStage(env) {
  const stage = env.VIDEORC_WINDOWS_RELEASE_STAGE?.trim() || 'public'
  if (stage !== 'pilot' && stage !== 'public') {
    throw new WindowsAlphaReleaseError(
      'invalid-release-stage',
      'VIDEORC_WINDOWS_RELEASE_STAGE must be pilot or public.'
    )
  }
  return stage
}

async function readRequiredText(path, label) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new WindowsAlphaReleaseError('missing-release-file', `Missing ${label} at ${path}.`)
  }
}

async function requiredSize(path, label) {
  try {
    const size = (await stat(path)).size
    if (size <= 0) {
      throw new Error('empty')
    }
    return size
  } catch {
    throw new WindowsAlphaReleaseError(
      `missing-artifact-${label}`,
      `Missing or empty Windows release artifact ${label} at ${path}.`
    )
  }
}
