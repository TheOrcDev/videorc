import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

import { sha256File } from './beta-release-manifest.mjs'
import { buildCaptureDecayD3DestinationBinding } from './capture-decay-publication-attestation.mjs'
import { validateMacosUpdateFeed } from './macos-d3-sealed-candidate.mjs'
import {
  assertMacosD3ExactPromotionUploadRoutes,
  buildMacosD3PublicationReservationRoute,
  buildReleaseChangelogUploadRoute,
  buildReleaseUploadPlan,
  getReleaseUploadS3DestinationConfig
} from './release-upload-s3.mjs'

export async function deriveMacosD3DestinationBindingFromRelease({
  env = process.env,
  includeChangelog = true,
  manifestPath,
  releaseDir
}) {
  const directory = resolve(requiredText(releaseDir, 'release directory'))
  const releaseManifestPath = resolve(
    manifestPath
      ? requiredText(manifestPath, 'release manifest path')
      : join(directory, 'release.json')
  )
  const manifestBytes = await readRegularFile(releaseManifestPath, 'release manifest')
  const manifest = parseReleaseManifest(manifestBytes)
  const plan = await buildReleaseUploadPlan({
    env,
    exactPromotion: true,
    manifest,
    manifestPath: releaseManifestPath,
    releaseDir: directory
  })
  await assertBuiltReleaseConsistency({ manifest, manifestBytes, plan, releaseManifestPath })

  const artifacts = [
    ...plan.artifacts,
    ...(includeChangelog ? [buildReleaseChangelogUploadRoute({ env })] : [])
  ]
  assertMacosD3ExactPromotionUploadRoutes({
    artifacts,
    prefix: plan.prefix,
    releaseManifest: manifest
  })

  const config = getReleaseUploadS3DestinationConfig(env)
  const reservation = buildMacosD3PublicationReservationRoute({
    config,
    prefix: plan.prefix
  })
  const destinationBinding = buildCaptureDecayD3DestinationBinding({
    artifacts,
    config,
    reservation
  })
  return {
    destinationBinding,
    release: {
      releaseId: plan.releaseId,
      manifestPath: releaseManifestPath,
      releaseDir: directory
    }
  }
}

async function assertBuiltReleaseConsistency({
  manifest,
  manifestBytes,
  plan,
  releaseManifestPath
}) {
  const artifacts = new Map(plan.artifacts.map((artifact) => [artifact.label, artifact]))
  const dmg = requiredArtifact(artifacts, 'dmg')
  const sidecar = requiredArtifact(artifacts, 'sha256')
  const zip = requiredArtifact(artifacts, 'feed-zip')
  const blockmap = requiredArtifact(artifacts, 'feed-blockmap')
  const feed = requiredArtifact(artifacts, 'feed-manifest')

  const [dmgInfo, sidecarBytes, zipInfo, blockmapInfo, feedBytes] = await Promise.all([
    regularFileInfo(dmg.path, 'DMG'),
    readRegularFile(sidecar.path, 'DMG checksum sidecar'),
    regularFileInfo(zip.path, 'update ZIP'),
    regularFileInfo(blockmap.path, 'update ZIP blockmap'),
    readRegularFile(feed.path, 'macOS update feed')
  ])
  if (dmgInfo.size !== manifest.sizeBytes || (await sha256File(dmg.path)) !== manifest.sha256) {
    throw planError('release-dmg-mismatch', 'release.json does not match the built DMG bytes.')
  }
  const expectedSidecar = `${manifest.sha256}  ${manifest.filename}\n`
  if (sidecarBytes.toString('utf8') !== expectedSidecar) {
    throw planError(
      'release-checksum-mismatch',
      'The DMG checksum sidecar does not exactly match release.json and the built DMG.'
    )
  }
  if (zipInfo.size <= 0 || blockmapInfo.size <= 0) {
    throw planError(
      'release-feed-artifact-empty',
      'The update ZIP and blockmap must both be non-empty regular files.'
    )
  }
  const zipSha512 = await hashFile(zip.path, 'sha512', 'base64')
  validateBuiltMacosUpdateFeed(feedBytes.toString('utf8'), {
    bundleVersion: manifest.bundleVersion,
    dmgFilename: manifest.filename,
    dmgSha512: await hashFile(dmg.path, 'sha512', 'base64'),
    dmgSizeBytes: dmgInfo.size,
    zipFilename: basename(zip.path),
    zipSha512,
    zipSizeBytes: zipInfo.size
  })

  const manifestAfter = await readRegularFile(releaseManifestPath, 'release manifest')
  if (!manifestAfter.equals(manifestBytes)) {
    throw planError(
      'release-manifest-mutated',
      'release.json changed while the D3 destination plan was being derived.'
    )
  }
}

function validateBuiltMacosUpdateFeed(
  feedText,
  { bundleVersion, dmgFilename, dmgSha512, dmgSizeBytes, zipFilename, zipSha512, zipSizeBytes }
) {
  let feed
  try {
    feed = loadYaml(feedText, { schema: JSON_SCHEMA })
  } catch (cause) {
    throw planErrorWithCause('release-feed-yaml', 'latest-mac.yml is not strict valid YAML.', cause)
  }
  assertExactKeys(feed, ['files', 'path', 'releaseDate', 'sha512', 'version'], 'update feed')
  if (!Array.isArray(feed.files) || ![1, 2].includes(feed.files.length)) {
    throw planError(
      'release-feed-files',
      'latest-mac.yml must list the exact update ZIP and at most the built DMG.'
    )
  }
  if (feed.files.length === 1) {
    validateMacosUpdateFeed(feedText, {
      bundleVersion,
      zipFilename,
      zipSha512,
      zipSizeBytes
    })
    return
  }

  const expected = new Map([
    [zipFilename, { sha512: zipSha512, size: zipSizeBytes }],
    [dmgFilename, { sha512: dmgSha512, size: dmgSizeBytes }]
  ])
  const seen = new Set()
  for (const file of feed.files) {
    assertExactKeys(file, ['sha512', 'size', 'url'], 'update feed file')
    const filename = safeFilename(file.url, 'update feed file URL')
    const binding = expected.get(filename)
    if (
      !binding ||
      seen.has(filename) ||
      file.sha512 !== binding.sha512 ||
      file.size !== binding.size
    ) {
      throw planError(
        'release-feed-files',
        'latest-mac.yml contains a duplicate, unexpected, or byte-mismatched update artifact.'
      )
    }
    seen.add(filename)
  }
  if (
    !seen.has(zipFilename) ||
    !seen.has(dmgFilename) ||
    feed.version !== bundleVersion ||
    feed.path !== zipFilename ||
    feed.sha512 !== zipSha512 ||
    !Number.isFinite(Date.parse(feed.releaseDate))
  ) {
    throw planError(
      'release-feed-mismatch',
      'latest-mac.yml does not bind the built ZIP, optional DMG, version, and release date.'
    )
  }

  // Reuse the sealed publication validator for the single-ZIP feed that the
  // staging command will canonically derive from this already-verified input.
  validateMacosUpdateFeed(
    [
      `version: ${bundleVersion}`,
      'files:',
      `  - url: ${zipFilename}`,
      `    sha512: '${zipSha512}'`,
      `    size: ${zipSizeBytes}`,
      `path: ${zipFilename}`,
      `sha512: '${zipSha512}'`,
      `releaseDate: '${new Date(feed.releaseDate).toISOString()}'`,
      ''
    ].join('\n'),
    { bundleVersion, zipFilename, zipSha512, zipSizeBytes }
  )
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw planError('release-feed-schema', `${label} must be one mapping.`)
  }
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw planError('release-feed-schema', `${label} contains missing or unsupported fields.`)
  }
}

function safeFilename(value, label) {
  const filename = requiredText(value, label)
  if (
    basename(filename) !== filename ||
    filename === '.' ||
    filename === '..' ||
    /[\\/\0\r\n]/.test(filename)
  ) {
    throw planError('release-feed-filename', `${label} must be one safe relative filename.`)
  }
  return filename
}

function parseReleaseManifest(bytes) {
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw planError('release-manifest-json', 'release.json is not valid JSON.')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw planError('release-manifest-json', 'release.json must contain one JSON object.')
  }
  for (const field of ['releaseId', 'filename', 'objectKey', 'bundleVersion']) {
    requiredText(manifest[field], `release manifest ${field}`)
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')) {
    throw planError('release-manifest-sha256', 'release.json must contain a lowercase SHA-256.')
  }
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) {
    throw planError(
      'release-manifest-size',
      'release.json must contain a positive safe-integer DMG size.'
    )
  }
  return manifest
}

function requiredArtifact(artifacts, label) {
  const artifact = artifacts.get(label)
  if (!artifact) throw planError('release-artifact-missing', `Missing ${label} release artifact.`)
  return artifact
}

async function readRegularFile(path, label) {
  await regularFileInfo(path, label)
  try {
    return await readFile(path)
  } catch (cause) {
    throw planErrorWithCause('release-file-read', `Could not read ${label}.`, cause)
  }
}

async function regularFileInfo(path, label) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('not a regular file')
    }
    return info
  } catch (cause) {
    throw planErrorWithCause(
      'release-file-type',
      `${label} must be a directly addressed regular file.`,
      cause
    )
  }
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  return hash.digest(encoding)
}

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw planError('release-plan-value', `${label} is required.`)
  return text
}

function planError(code, message) {
  const error = new Error(message)
  error.name = 'MacosD3DestinationPlanError'
  error.code = code
  return error
}

function planErrorWithCause(code, message, cause) {
  const error = planError(code, message)
  error.cause = cause
  return error
}
