import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import {
  assertIsolatedLinuxObjectKey,
  assertLinuxAlphaReleaseManifest,
  LINUX_ALPHA_UPDATE_FEED_NAME,
  sha256File,
  sha512File,
  updateFeedArtifactNameFromYml,
  updateFeedFileMetadataFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml
} from './linux-alpha-release.mjs'

const CANDIDATE_ROOT = 'candidates/linux-alpha'
const MAX_DOWNLOAD_BYTES = Object.freeze({
  appimage: 2 * 1024 * 1024 * 1024,
  'ffmpeg-license': 2 * 1024 * 1024,
  'ffmpeg-source': 2 * 1024 * 1024,
  manifest: 64 * 1024,
  sha256: 1024,
  'update-feed': 1024 * 1024
})

const CONTENT_TYPES = Object.freeze({
  appimage: 'application/vnd.appimage',
  'ffmpeg-license': 'text/plain; charset=utf-8',
  'ffmpeg-source': 'text/plain; charset=utf-8',
  manifest: 'application/json',
  sha256: 'text/plain; charset=utf-8',
  'update-feed': 'text/yaml; charset=utf-8'
})

export class LinuxReleaseCandidateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LinuxReleaseCandidateError'
    this.code = code
  }
}

export function assertLinuxCandidateCoordinates({ releaseId, sourceCommit, appImageSha256 }) {
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(releaseId ?? '')) {
    throw new LinuxReleaseCandidateError(
      'invalid-release-id',
      'Candidate releaseId must be a three-part numeric version followed by -alpha.N.'
    )
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) {
    throw new LinuxReleaseCandidateError(
      'invalid-source-commit',
      'Candidate sourceCommit must be a lowercase full 40-character Git SHA.'
    )
  }
  if (appImageSha256 !== undefined && !/^[a-f0-9]{64}$/.test(appImageSha256 ?? '')) {
    throw new LinuxReleaseCandidateError(
      'invalid-appimage-sha256',
      'Candidate AppImage SHA-256 must be 64 lowercase hexadecimal characters.'
    )
  }
  return { appImageSha256, releaseId, sourceCommit }
}

export function linuxCandidatePrefix({ releaseId, sourceCommit }) {
  assertLinuxCandidateCoordinates({ releaseId, sourceCommit })
  return `${CANDIDATE_ROOT}/${releaseId}/${sourceCommit}`
}

export function linuxCandidateIdentity({ releaseId, sourceCommit, appImageSha256 }) {
  assertLinuxCandidateCoordinates({ releaseId, sourceCommit, appImageSha256 })
  return `linux:${releaseId}:${sourceCommit}:sha256:${appImageSha256}`
}

export function assertPrivateLinuxCandidateS3Config(config) {
  if (config?.endpointUrl && new URL(config.endpointUrl).protocol !== 'https:') {
    throw new LinuxReleaseCandidateError(
      'insecure-candidate-storage-endpoint',
      'Private Linux candidate storage requires an HTTPS S3 endpoint.'
    )
  }
  return config
}

export function classifyLinuxCandidateObjectHead({ artifact, response }) {
  if (response.status === 404) return 'missing'
  if (!response.ok) {
    throw new LinuxReleaseCandidateError(
      'candidate-storage-head-failed',
      `Candidate storage HEAD failed for ${artifact.objectKey}: HTTP ${response.status}.`
    )
  }
  const contentLength = response.headers.get('content-length')
  const remoteSha256 = response.headers.get('x-amz-meta-sha256')?.trim().toLowerCase()
  const sizeMismatch = contentLength !== null && Number(contentLength) !== artifact.sizeBytes
  if (sizeMismatch || remoteSha256 !== artifact.sha256) {
    throw new LinuxReleaseCandidateError(
      'candidate-storage-collision',
      `Immutable candidate object already exists with different bytes: ${artifact.objectKey} ` +
        `(remote sha256=${remoteSha256 ?? 'missing'}, size=${contentLength ?? 'missing'}; ` +
        `expected sha256=${artifact.sha256}, size=${artifact.sizeBytes}).`
    )
  }
  return 'identical'
}

export function assertPendingLinuxCandidateManifest(
  manifest,
  { releaseId, sourceCommit, appImageSha256 } = {}
) {
  assertLinuxAlphaReleaseManifest(manifest)
  assertLinuxCandidateCoordinates({
    releaseId: releaseId ?? manifest.releaseId,
    sourceCommit: sourceCommit ?? manifest.sourceCommit,
    appImageSha256: appImageSha256 ?? manifest.sha256
  })

  requireEqual(manifest.releaseId, releaseId, 'candidate-release-id', 'releaseId')
  requireEqual(manifest.sourceCommit, sourceCommit, 'candidate-source-commit', 'sourceCommit')
  requireEqual(manifest.sha256, appImageSha256, 'candidate-appimage-sha256', 'AppImage SHA-256')
  if (manifest.acceptanceStatus !== 'pending' || manifest.acceptanceRecordUrl) {
    throw new LinuxReleaseCandidateError(
      'candidate-not-pending',
      'A stored Linux candidate must have acceptanceStatus=pending and no acceptanceRecordUrl.'
    )
  }
  if (manifest.stage !== 'candidate') {
    throw new LinuxReleaseCandidateError(
      'candidate-not-private',
      'A stored Linux candidate must have stage=candidate.'
    )
  }
  return manifest
}

export function linuxCandidateObjectDescriptors(manifest) {
  assertPendingLinuxCandidateManifest(manifest)
  const prefix = linuxCandidatePrefix(manifest)
  const descriptors = [
    descriptor('appimage', manifest.filename, `${prefix}/${manifest.filename}`),
    descriptor('sha256', `${manifest.filename}.sha256`, `${prefix}/${manifest.filename}.sha256`),
    descriptor(
      'update-feed',
      LINUX_ALPHA_UPDATE_FEED_NAME,
      `${prefix}/${LINUX_ALPHA_UPDATE_FEED_NAME}`
    ),
    descriptor('manifest', 'release.json', `${prefix}/release.json`),
    descriptor('ffmpeg-license', 'FFMPEG-LICENSE.txt', `${prefix}/FFMPEG-LICENSE.txt`),
    descriptor('ffmpeg-source', 'FFMPEG-SOURCE.txt', `${prefix}/FFMPEG-SOURCE.txt`)
  ]
  for (const item of descriptors) {
    assertIsolatedLinuxObjectKey(item.objectKey)
    if (!item.objectKey.startsWith(`${prefix}/`)) {
      throw new LinuxReleaseCandidateError(
        'candidate-prefix-escape',
        `Candidate object left the Linux Alpha prefix: ${item.objectKey}.`
      )
    }
  }
  return descriptors
}

export async function buildLinuxCandidateStoragePlan({
  ffmpegLicensePath,
  ffmpegSourcePath,
  manifest,
  manifestPath,
  releaseDir
}) {
  assertPendingLinuxCandidateManifest(manifest)
  const feedYml = await requiredText(
    join(releaseDir, LINUX_ALPHA_UPDATE_FEED_NAME),
    LINUX_ALPHA_UPDATE_FEED_NAME
  )
  assertFeedMatchesManifest({ feedYml, manifest })

  const paths = new Map([
    ['appimage', join(releaseDir, manifest.filename)],
    ['sha256', join(releaseDir, `${manifest.filename}.sha256`)],
    ['update-feed', join(releaseDir, LINUX_ALPHA_UPDATE_FEED_NAME)],
    ['manifest', manifestPath],
    ['ffmpeg-license', ffmpegLicensePath],
    ['ffmpeg-source', ffmpegSourcePath]
  ])
  const artifacts = await Promise.all(
    linuxCandidateObjectDescriptors(manifest).map(async (item) => {
      const path = resolve(paths.get(item.label))
      const sizeBytes = await requiredSize(path, item.label)
      return { ...item, path, sha256: await sha256File(path), sizeBytes }
    })
  )

  const appImage = artifacts.find((artifact) => artifact.label === 'appimage')
  if (appImage.sha256 !== manifest.sha256 || appImage.sizeBytes !== manifest.sizeBytes) {
    throw new LinuxReleaseCandidateError(
      'candidate-appimage-mismatch',
      'Candidate AppImage bytes must exactly match release.json SHA-256 and sizeBytes.'
    )
  }
  const sidecar = await requiredText(paths.get('sha256'), 'AppImage SHA-256 sidecar')
  if (sidecar.trim() !== `${manifest.sha256}  ${manifest.filename}`) {
    throw new LinuxReleaseCandidateError(
      'candidate-sidecar-mismatch',
      'Candidate SHA-256 sidecar must exactly match release.json.'
    )
  }
  assertFeedMatchesManifest({
    feedYml,
    appImageSha512: await sha512File(appImage.path),
    appImageSizeBytes: appImage.sizeBytes,
    manifest
  })

  return {
    artifacts,
    candidateIdentity: linuxCandidateIdentity({
      appImageSha256: manifest.sha256,
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit
    }),
    prefix: linuxCandidatePrefix(manifest),
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit
  }
}

function descriptor(label, relativePath, objectKey) {
  const pathSegments = relativePath.split('/')
  if (
    pathSegments.length === 0 ||
    pathSegments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(segment)
    )
  ) {
    throw new LinuxReleaseCandidateError(
      'unsafe-candidate-filename',
      `Unsafe candidate relative path: ${relativePath}.`
    )
  }
  return {
    contentType: CONTENT_TYPES[label],
    filename: basename(relativePath),
    label,
    maxBytes: MAX_DOWNLOAD_BYTES[label],
    objectKey,
    relativePath
  }
}

function assertFeedMatchesManifest({ feedYml, appImageSha512, appImageSizeBytes, manifest }) {
  if (updateFeedArtifactNameFromYml(feedYml) !== manifest.filename) {
    throw new LinuxReleaseCandidateError(
      'candidate-feed-artifact-mismatch',
      `Candidate latest-linux.yml must reference ${manifest.filename}.`
    )
  }
  if (updateFeedVersionFromYml(feedYml) !== manifest.bundleVersion) {
    throw new LinuxReleaseCandidateError(
      'candidate-feed-version-mismatch',
      `Candidate latest-linux.yml version must be ${manifest.bundleVersion}.`
    )
  }
  if (appImageSha512 !== undefined || appImageSizeBytes !== undefined) {
    const feedFile = updateFeedFileMetadataFromYml(feedYml, manifest.filename)
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(appImageSha512 ?? '') ||
      updateFeedSha512FromYml(feedYml) !== appImageSha512 ||
      feedFile?.sha512 !== appImageSha512 ||
      feedFile?.size !== appImageSizeBytes
    ) {
      throw new LinuxReleaseCandidateError(
        'candidate-feed-integrity-mismatch',
        'Candidate latest-linux.yml SHA-512 and byte size must exactly match the AppImage.'
      )
    }
  }
}

function requireEqual(actual, expected, code, label) {
  if (expected !== undefined && actual !== expected) {
    throw new LinuxReleaseCandidateError(code, `Candidate ${label} does not match the input.`)
  }
}

async function requiredText(path, label) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new LinuxReleaseCandidateError(
      'missing-candidate-file',
      `Missing candidate ${label} at ${path}.`
    )
  }
}

async function requiredSize(path, label) {
  try {
    const size = (await stat(path)).size
    if (size <= 0) throw new Error('empty')
    return size
  } catch {
    throw new LinuxReleaseCandidateError(
      `missing-candidate-${label}`,
      `Missing or empty candidate file ${label} at ${path}.`
    )
  }
}
