#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { buildSignedS3Request, getReleaseUploadS3Config } from './lib/release-upload-s3.mjs'
import {
  assertCandidateDownloadHeaders,
  assertPendingWindowsCandidateManifest,
  assertPrivateCandidateS3Config,
  WindowsReleaseCandidateError,
  windowsCandidateObjectDescriptors,
  windowsCandidatePrefix
} from './lib/windows-release-candidate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  const expected = {
    installerSha256: requiredEnv('VIDEORC_RELEASE_EXPECTED_SHA256'),
    releaseId: requiredEnv('VIDEORC_RELEASE_ID'),
    sourceCommit: requiredEnv('VIDEORC_RELEASE_SOURCE_COMMIT')
  }
  const config = assertPrivateCandidateS3Config(getReleaseUploadS3Config())
  const prefix = windowsCandidatePrefix(expected)
  await mkdir(releaseDir, { recursive: true })

  const manifestDescriptor = {
    filename: 'release.json',
    label: 'manifest',
    maxBytes: 64 * 1024,
    objectKey: `${prefix}/release.json`
  }
  const { bytes: manifestBytes } = await fetchCandidateBytes({
    config,
    descriptor: manifestDescriptor
  })
  let manifest
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
  } catch {
    throw new WindowsReleaseCandidateError(
      'candidate-manifest-json',
      'Private candidate release.json is not valid UTF-8 JSON.'
    )
  }
  assertPendingWindowsCandidateManifest(manifest, expected)
  await writeExclusive(join(releaseDir, 'release.json'), manifestBytes)

  for (const descriptor of windowsCandidateObjectDescriptors(manifest)) {
    if (descriptor.label === 'manifest') continue
    const destination = join(releaseDir, descriptor.relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await downloadCandidateFile({ config, descriptor, destination })
  }

  const downloadedManifest = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'))
  assertPendingWindowsCandidateManifest(downloadedManifest, expected)
  console.log(
    `windows-release-candidate-download: PASS (${manifest.releaseId} ${manifest.sourceCommit})`
  )
}

async function fetchCandidateBytes({ config, descriptor }) {
  const response = await signedGet({ config, descriptor })
  const headers = assertCandidateDownloadHeaders({ descriptor, response })
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== headers.contentLength) {
    throw new WindowsReleaseCandidateError(
      'candidate-download-truncated',
      `Candidate object ${descriptor.objectKey} was truncated during download.`
    )
  }
  assertDownloadedSha({ bytes, descriptor, expectedSha256: headers.metadataSha256 })
  return { bytes, headers }
}

async function downloadCandidateFile({ config, descriptor, destination }) {
  await requireMissingDestination(destination)
  const response = await signedGet({ config, descriptor })
  const headers = assertCandidateDownloadHeaders({ descriptor, response })
  if (!response.body) {
    throw new WindowsReleaseCandidateError(
      'candidate-download-body',
      `Candidate object ${descriptor.objectKey} returned no body.`
    )
  }
  const temporary = `${destination}.part`
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }))
    const bytes = await readFile(temporary)
    if (bytes.byteLength !== headers.contentLength) {
      throw new WindowsReleaseCandidateError(
        'candidate-download-truncated',
        `Candidate object ${descriptor.objectKey} was truncated during download.`
      )
    }
    assertDownloadedSha({ bytes, descriptor, expectedSha256: headers.metadataSha256 })
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function signedGet({ config, descriptor }) {
  const signed = buildSignedS3Request({
    config,
    method: 'GET',
    objectKey: descriptor.objectKey
  })
  return fetch(signed.url, { headers: signed.headers, method: 'GET', redirect: 'error' })
}

function assertDownloadedSha({ bytes, descriptor, expectedSha256 }) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedSha256) {
    throw new WindowsReleaseCandidateError(
      'candidate-download-sha256',
      `Candidate object ${descriptor.objectKey} failed SHA-256 metadata verification.`
    )
  }
}

async function writeExclusive(destination, bytes) {
  await requireMissingDestination(destination)
  const temporary = `${destination}.part`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function requireMissingDestination(destination) {
  try {
    await access(destination)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new WindowsReleaseCandidateError(
    'candidate-download-destination-exists',
    `Refusing to replace existing candidate file ${destination}.`
  )
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

main().catch((error) => {
  console.error(
    `windows-release-candidate-download: FAIL (${error?.message ?? 'unexpected error'})`
  )
  process.exit(1)
})
