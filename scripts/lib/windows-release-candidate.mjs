import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import {
  assertWindowsAlphaReleaseManifest,
  sha256File,
  sha512File,
  updateFeedArtifactNameFromYml,
  updateFeedFileMetadataFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml
} from './windows-alpha-release.mjs'
import { hasExactWindowsAppUpdateConfig } from './windows-release-artifact-validation.mjs'

const CANDIDATE_ROOT = 'candidates/windows'
const MAX_DOWNLOAD_BYTES = Object.freeze({
  blockmap: 256 * 1024 * 1024,
  'ffmpeg-license': 2 * 1024 * 1024,
  'ffmpeg-source': 2 * 1024 * 1024,
  installer: 1024 * 1024 * 1024,
  manifest: 64 * 1024,
  sha256: 1024,
  'update-feed': 1024 * 1024,
  'validation-app': 1024 * 1024 * 1024,
  'validation-app-update': 64 * 1024,
  'validation-backend': 512 * 1024 * 1024,
  'validation-ffmpeg': 512 * 1024 * 1024,
  'validation-ffmpeg-license': 2 * 1024 * 1024,
  'validation-ffmpeg-source': 2 * 1024 * 1024,
  'validation-ffprobe': 512 * 1024 * 1024
})

const CONTENT_TYPES = Object.freeze({
  blockmap: 'application/octet-stream',
  'ffmpeg-license': 'text/plain; charset=utf-8',
  'ffmpeg-source': 'text/plain; charset=utf-8',
  installer: 'application/vnd.microsoft.portable-executable',
  manifest: 'application/json',
  sha256: 'text/plain; charset=utf-8',
  'update-feed': 'text/yaml; charset=utf-8',
  'validation-app': 'application/vnd.microsoft.portable-executable',
  'validation-app-update': 'text/yaml; charset=utf-8',
  'validation-backend': 'application/vnd.microsoft.portable-executable',
  'validation-ffmpeg': 'application/vnd.microsoft.portable-executable',
  'validation-ffmpeg-license': 'text/plain; charset=utf-8',
  'validation-ffmpeg-source': 'text/plain; charset=utf-8',
  'validation-ffprobe': 'application/vnd.microsoft.portable-executable'
})

export class WindowsReleaseCandidateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WindowsReleaseCandidateError'
    this.code = code
  }
}

export function assertWindowsCandidateCoordinates({ releaseId, sourceCommit, installerSha256 }) {
  if (!/^\d+\.\d+\.\d+-alpha\.1$/.test(releaseId ?? '')) {
    throw new WindowsReleaseCandidateError(
      'invalid-release-id',
      'Candidate releaseId must be a three-part numeric version followed by exactly -alpha.1; bump the numeric package version for every candidate.'
    )
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) {
    throw new WindowsReleaseCandidateError(
      'invalid-source-commit',
      'Candidate sourceCommit must be a lowercase full 40-character Git SHA.'
    )
  }
  if (installerSha256 !== undefined && !/^[a-f0-9]{64}$/.test(installerSha256 ?? '')) {
    throw new WindowsReleaseCandidateError(
      'invalid-installer-sha256',
      'Candidate installer SHA-256 must be 64 lowercase hexadecimal characters.'
    )
  }
  return { installerSha256, releaseId, sourceCommit }
}

export function windowsCandidatePrefix({ releaseId, sourceCommit }) {
  assertWindowsCandidateCoordinates({ releaseId, sourceCommit })
  return `${CANDIDATE_ROOT}/${releaseId}/${sourceCommit}`
}

export function windowsCandidateIdentity({ releaseId, sourceCommit, installerSha256 }) {
  assertWindowsCandidateCoordinates({ releaseId, sourceCommit, installerSha256 })
  return `windows:${releaseId}:${sourceCommit}:sha256:${installerSha256}`
}

export function assertPrivateCandidateS3Config(config) {
  if (config?.endpointUrl && new URL(config.endpointUrl).protocol !== 'https:') {
    throw new WindowsReleaseCandidateError(
      'insecure-candidate-storage-endpoint',
      'Private candidate storage requires an HTTPS S3 endpoint.'
    )
  }
  return config
}

export function classifyCandidateObjectHead({ artifact, response }) {
  if (response.status === 404) return 'missing'
  if (!response.ok) {
    throw new WindowsReleaseCandidateError(
      'candidate-storage-head-failed',
      `Candidate storage HEAD failed for ${artifact.objectKey}: HTTP ${response.status}.`
    )
  }
  const remoteSize = Number(response.headers.get('content-length'))
  const remoteSha256 = response.headers.get('x-amz-meta-sha256')?.trim().toLowerCase()
  if (remoteSize !== artifact.sizeBytes || remoteSha256 !== artifact.sha256) {
    throw new WindowsReleaseCandidateError(
      'candidate-storage-collision',
      `Immutable candidate object already exists with different bytes: ${artifact.objectKey}.`
    )
  }
  return 'identical'
}

export function assertCandidateDownloadHeaders({ descriptor, response }) {
  if (!response.ok) {
    throw new WindowsReleaseCandidateError(
      'candidate-download-failed',
      `Candidate download failed for ${descriptor.objectKey}: HTTP ${response.status}.`
    )
  }
  const contentLengthHeader = response.headers.get('content-length')
  const contentLength = Number(contentLengthHeader)
  if (
    !contentLengthHeader ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > descriptor.maxBytes
  ) {
    throw new WindowsReleaseCandidateError(
      'candidate-download-size',
      `Candidate object ${descriptor.objectKey} has a missing or unsafe Content-Length.`
    )
  }
  const metadataSha256 = response.headers.get('x-amz-meta-sha256')?.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(metadataSha256 ?? '')) {
    throw new WindowsReleaseCandidateError(
      'candidate-download-metadata',
      `Candidate object ${descriptor.objectKey} is missing immutable SHA-256 metadata.`
    )
  }
  return { contentLength, metadataSha256 }
}

export function assertPendingWindowsCandidateManifest(
  manifest,
  { releaseId, sourceCommit, installerSha256 } = {}
) {
  assertWindowsAlphaReleaseManifest(manifest)
  assertWindowsCandidateCoordinates({
    releaseId: releaseId ?? manifest.releaseId,
    sourceCommit: sourceCommit ?? manifest.sourceCommit,
    installerSha256: installerSha256 ?? manifest.sha256
  })

  requireEqual(manifest.releaseId, releaseId, 'candidate-release-id', 'releaseId')
  requireEqual(manifest.sourceCommit, sourceCommit, 'candidate-source-commit', 'sourceCommit')
  requireEqual(manifest.sha256, installerSha256, 'candidate-installer-sha256', 'installer SHA-256')
  if (manifest.acceptanceStatus !== 'pending' || manifest.acceptanceRecordUrl) {
    throw new WindowsReleaseCandidateError(
      'candidate-not-pending',
      'A stored Windows candidate must have acceptanceStatus=pending and no acceptanceRecordUrl.'
    )
  }
  return manifest
}

export function windowsCandidateObjectDescriptors(manifest) {
  assertPendingWindowsCandidateManifest(manifest)
  const prefix = windowsCandidatePrefix(manifest)
  return [
    descriptor('installer', manifest.filename, `${prefix}/${manifest.filename}`),
    descriptor('sha256', `${manifest.filename}.sha256`, `${prefix}/${manifest.filename}.sha256`),
    descriptor(
      'blockmap',
      `${manifest.filename}.blockmap`,
      `${prefix}/${manifest.filename}.blockmap`
    ),
    descriptor('update-feed', 'latest.yml', `${prefix}/latest.yml`),
    descriptor('manifest', 'release.json', `${prefix}/release.json`),
    descriptor('ffmpeg-license', 'FFMPEG-LICENSE.txt', `${prefix}/FFMPEG-LICENSE.txt`),
    descriptor('ffmpeg-source', 'FFMPEG-SOURCE.txt', `${prefix}/FFMPEG-SOURCE.txt`),
    descriptor('validation-app', 'win-unpacked/Videorc.exe', `${prefix}/win-unpacked/Videorc.exe`),
    descriptor(
      'validation-app-update',
      'win-unpacked/resources/app-update.yml',
      `${prefix}/win-unpacked/resources/app-update.yml`
    ),
    descriptor(
      'validation-backend',
      'win-unpacked/resources/videorc-backend.exe',
      `${prefix}/win-unpacked/resources/videorc-backend.exe`
    ),
    descriptor(
      'validation-ffmpeg',
      'win-unpacked/resources/ffmpeg/bin/ffmpeg.exe',
      `${prefix}/win-unpacked/resources/ffmpeg/bin/ffmpeg.exe`
    ),
    descriptor(
      'validation-ffprobe',
      'win-unpacked/resources/ffmpeg/bin/ffprobe.exe',
      `${prefix}/win-unpacked/resources/ffmpeg/bin/ffprobe.exe`
    ),
    descriptor(
      'validation-ffmpeg-license',
      'win-unpacked/resources/ffmpeg/LICENSE.txt',
      `${prefix}/win-unpacked/resources/ffmpeg/LICENSE.txt`
    ),
    descriptor(
      'validation-ffmpeg-source',
      'win-unpacked/resources/ffmpeg/SOURCE.txt',
      `${prefix}/win-unpacked/resources/ffmpeg/SOURCE.txt`
    )
  ]
}

export async function buildWindowsCandidateStoragePlan({
  ffmpegLicensePath,
  ffmpegSourcePath,
  manifest,
  manifestPath,
  releaseDir
}) {
  assertPendingWindowsCandidateManifest(manifest)
  const feedYml = await requiredText(join(releaseDir, 'latest.yml'), 'latest.yml')
  assertFeedMatchesManifest({ feedYml, manifest })

  const paths = new Map([
    ['installer', join(releaseDir, manifest.filename)],
    ['sha256', join(releaseDir, `${manifest.filename}.sha256`)],
    ['blockmap', join(releaseDir, `${manifest.filename}.blockmap`)],
    ['update-feed', join(releaseDir, 'latest.yml')],
    ['manifest', manifestPath],
    ['ffmpeg-license', ffmpegLicensePath],
    ['ffmpeg-source', ffmpegSourcePath],
    ['validation-app', join(releaseDir, 'win-unpacked', 'Videorc.exe')],
    ['validation-app-update', join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml')],
    ['validation-backend', join(releaseDir, 'win-unpacked', 'resources', 'videorc-backend.exe')],
    [
      'validation-ffmpeg',
      join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ],
    [
      'validation-ffprobe',
      join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'bin', 'ffprobe.exe')
    ],
    [
      'validation-ffmpeg-license',
      join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'LICENSE.txt')
    ],
    [
      'validation-ffmpeg-source',
      join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'SOURCE.txt')
    ]
  ])
  const artifacts = await Promise.all(
    windowsCandidateObjectDescriptors(manifest).map(async (item) => {
      const path = resolve(paths.get(item.label))
      const sizeBytes = await requiredSize(path, item.label)
      return { ...item, path, sha256: await sha256File(path), sizeBytes }
    })
  )

  const installer = artifacts.find((artifact) => artifact.label === 'installer')
  if (installer.sha256 !== manifest.sha256 || installer.sizeBytes !== manifest.sizeBytes) {
    throw new WindowsReleaseCandidateError(
      'candidate-installer-mismatch',
      'Candidate installer bytes must exactly match release.json SHA-256 and sizeBytes.'
    )
  }
  const sidecar = await requiredText(paths.get('sha256'), 'installer SHA-256 sidecar')
  if (sidecar.trim() !== `${manifest.sha256}  ${manifest.filename}`) {
    throw new WindowsReleaseCandidateError(
      'candidate-sidecar-mismatch',
      'Candidate SHA-256 sidecar must exactly match release.json.'
    )
  }
  assertFeedMatchesManifest({
    feedYml,
    installerSha512: await sha512File(installer.path),
    installerSizeBytes: installer.sizeBytes,
    manifest
  })

  return {
    artifacts,
    candidateIdentity: windowsCandidateIdentity({
      installerSha256: manifest.sha256,
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit
    }),
    prefix: windowsCandidatePrefix(manifest),
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit
  }
}

export function validateDownloadedWindowsCandidate({
  actualInstallerSha256,
  actualInstallerSha512,
  actualInstallerSizeBytes,
  appUpdateYml,
  appSignature,
  expectedInstallerSha256,
  expectedPublisher,
  expectedReleaseId,
  expectedSourceCommit,
  feedYml,
  manifest,
  requiredFileSizes,
  sha256FileText,
  signature
}) {
  assertPendingWindowsCandidateManifest(manifest, {
    installerSha256: expectedInstallerSha256,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit
  })
  const checks = []
  const requireCheck = (id, ok, message) => {
    if (!ok) throw new WindowsReleaseCandidateError(id, message)
    checks.push({ id, ok: true })
  }

  requireCheck(
    'publisher-contract',
    Boolean(expectedPublisher) && manifest.publisherName === expectedPublisher,
    'Candidate publisherName must exactly match VIDEORC_WINDOWS_PUBLISHER_NAME.'
  )
  requireCheck(
    'app-update-publisher-contract',
    hasExactWindowsAppUpdateConfig(appUpdateYml, expectedPublisher),
    'Downloaded app-update.yml must use the branded updater route and exact pinned publisherName.'
  )
  requireCheck(
    'signature-status',
    signature?.status === 'Valid',
    `Candidate Authenticode status must be Valid, got ${signature?.status ?? 'missing'}.`
  )
  requireCheck(
    'signature-publisher',
    signature?.publisher === expectedPublisher,
    'Candidate Authenticode publisher does not match the expected publisher.'
  )
  requireCheck(
    'signature-timestamp',
    signature?.timestampPresent === true,
    'Candidate Authenticode signature must include a timestamp countersignature.'
  )
  requireCheck(
    'app-signature-status',
    appSignature?.status === 'Valid',
    `Packaged Videorc.exe Authenticode status must be Valid, got ${appSignature?.status ?? 'missing'}.`
  )
  requireCheck(
    'app-signature-publisher',
    appSignature?.publisher === expectedPublisher,
    'Packaged Videorc.exe Authenticode publisher does not match the expected publisher.'
  )
  requireCheck(
    'app-signature-timestamp',
    appSignature?.timestampPresent === true,
    'Packaged Videorc.exe Authenticode signature must include a timestamp countersignature.'
  )
  requireCheck(
    'installer-sha256',
    actualInstallerSha256 === expectedInstallerSha256 && actualInstallerSha256 === manifest.sha256,
    'Downloaded installer SHA-256 does not match the dispatch input and release.json.'
  )
  requireCheck(
    'installer-size',
    actualInstallerSizeBytes === manifest.sizeBytes,
    'Downloaded installer size does not match release.json.'
  )
  requireCheck(
    'sha256-sidecar',
    sha256FileText.trim() === `${manifest.sha256}  ${manifest.filename}`,
    'Downloaded SHA-256 sidecar does not exactly match release.json.'
  )
  assertFeedMatchesManifest({
    feedYml,
    installerSha512: actualInstallerSha512,
    installerSizeBytes: actualInstallerSizeBytes,
    manifest
  })
  checks.push({ id: 'update-feed', ok: true })
  for (const [name, size] of Object.entries(requiredFileSizes)) {
    requireCheck(
      `file-${name}`,
      Number.isSafeInteger(size) && size > 0,
      `Downloaded candidate file ${name} is missing or empty.`
    )
  }

  return {
    candidateIdentity: windowsCandidateIdentity({
      installerSha256: manifest.sha256,
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit
    }),
    checks,
    ok: true
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
    throw new WindowsReleaseCandidateError(
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

function assertFeedMatchesManifest({ feedYml, installerSha512, installerSizeBytes, manifest }) {
  if (updateFeedArtifactNameFromYml(feedYml) !== manifest.filename) {
    throw new WindowsReleaseCandidateError(
      'candidate-feed-artifact-mismatch',
      `Candidate latest.yml must reference ${manifest.filename}.`
    )
  }
  if (updateFeedVersionFromYml(feedYml) !== manifest.bundleVersion) {
    throw new WindowsReleaseCandidateError(
      'candidate-feed-version-mismatch',
      `Candidate latest.yml version must be ${manifest.bundleVersion}.`
    )
  }
  if (installerSha512 !== undefined || installerSizeBytes !== undefined) {
    const feedFile = updateFeedFileMetadataFromYml(feedYml, manifest.filename)
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(installerSha512 ?? '') ||
      updateFeedSha512FromYml(feedYml) !== installerSha512 ||
      feedFile?.sha512 !== installerSha512 ||
      feedFile?.size !== installerSizeBytes
    ) {
      throw new WindowsReleaseCandidateError(
        'candidate-feed-integrity-mismatch',
        'Candidate latest.yml SHA-512 and byte size must exactly match the installer.'
      )
    }
  }
}

function requireEqual(actual, expected, code, label) {
  if (expected !== undefined && actual !== expected) {
    throw new WindowsReleaseCandidateError(code, `Candidate ${label} does not match the input.`)
  }
}

async function requiredText(path, label) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new WindowsReleaseCandidateError(
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
    throw new WindowsReleaseCandidateError(
      `missing-candidate-${label}`,
      `Missing or empty candidate file ${label} at ${path}.`
    )
  }
}
