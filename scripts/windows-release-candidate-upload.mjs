#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSignedS3Request, getReleaseUploadS3Config } from './lib/release-upload-s3.mjs'
import {
  assertPrivateCandidateS3Config,
  buildWindowsCandidateStoragePlan,
  classifyCandidateObjectHead
} from './lib/windows-release-candidate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const config = assertPrivateCandidateS3Config(getReleaseUploadS3Config())
  const plan = await buildWindowsCandidateStoragePlan({
    ffmpegLicensePath: resolve(
      process.env.VIDEORC_WINDOWS_FFMPEG_LICENSE_PATH ??
        join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'LICENSE.txt')
    ),
    ffmpegSourcePath: resolve(
      process.env.VIDEORC_WINDOWS_FFMPEG_SOURCE_PATH ??
        join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'SOURCE.txt')
    ),
    manifest,
    manifestPath,
    releaseDir
  })

  console.log(`windows-release-candidate-upload: ${plan.candidateIdentity}`)
  for (const artifact of plan.artifacts) {
    const state = await headArtifact({ artifact, config })
    if (state === 'identical') {
      console.log(`windows-release-candidate-upload: identical ${artifact.objectKey}`)
      continue
    }
    await putArtifact({ artifact, config })
    classifyCandidateObjectHead({
      artifact,
      response: await signedFetch({ config, method: 'HEAD', objectKey: artifact.objectKey })
    })
    console.log(`windows-release-candidate-upload: stored ${artifact.objectKey}`)
  }
  console.log('windows-release-candidate-upload: PASS')
}

async function headArtifact({ artifact, config }) {
  return classifyCandidateObjectHead({
    artifact,
    response: await signedFetch({ config, method: 'HEAD', objectKey: artifact.objectKey })
  })
}

async function putArtifact({ artifact, config }) {
  // Transient storage-edge failures (HTTP 5xx, dropped connections) are
  // retried. A retried PUT is safe: If-None-Match keeps the object immutable,
  // and a HEAD before each retry detects that a "failed" attempt actually
  // landed the exact bytes (a 504 can arrive after the write completed).
  const maxAttempts = 5
  for (let attempt = 1; ; attempt += 1) {
    let status
    try {
      status = await putArtifactOnce({ artifact, config })
    } catch (error) {
      if (error?.code === 'candidate-storage-collision' || attempt >= maxAttempts) throw error
      status = `network error: ${error?.message ?? 'unknown'}`
    }
    if (status === 'stored') return
    if (attempt >= maxAttempts) {
      throw new Error(`candidate upload failed for ${artifact.objectKey}: ${status}`)
    }
    console.log(
      `windows-release-candidate-upload: retrying ${artifact.objectKey} after ${status} ` +
        `(attempt ${attempt + 1}/${maxAttempts})`
    )
    await new Promise((done) => setTimeout(done, 5000 * attempt))
    const state = await headArtifact({ artifact, config }).catch((error) => {
      if (error?.code === 'candidate-storage-collision') throw error
      return 'unknown'
    })
    if (state === 'identical') return
  }
}

async function putArtifactOnce({ artifact, config }) {
  const signed = buildSignedS3Request({
    additionalHeaders: { 'x-amz-meta-sha256': artifact.sha256 },
    config,
    method: 'PUT',
    objectKey: artifact.objectKey
  })
  const response = await fetch(signed.url, {
    body: createReadStream(artifact.path),
    duplex: 'half',
    headers: {
      ...signed.headers,
      'Content-Length': String(artifact.sizeBytes),
      'Content-Type': artifact.contentType,
      'If-None-Match': '*'
    },
    method: 'PUT',
    redirect: 'error'
  })
  if (response.status === 412) {
    const state = await headArtifact({ artifact, config })
    if (state === 'identical') return 'stored'
  }
  if (response.ok) return 'stored'
  if (response.status >= 500) return `HTTP ${response.status}`
  throw new Error(`candidate upload failed for ${artifact.objectKey}: HTTP ${response.status}`)
}

function signedFetch({ config, method, objectKey }) {
  const signed = buildSignedS3Request({ config, method, objectKey })
  // identity, or Cloudflare gzips text/plain responses on the fly and STRIPS
  // content-length — which made the post-upload verify read size 0 for the
  // .sha256 sidecar it had just written and report a false immutability
  // collision. Unsigned header, so it does not enter the SigV4 signature.
  return fetch(signed.url, {
    headers: { ...signed.headers, 'accept-encoding': 'identity' },
    method,
    redirect: 'error'
  })
}

main().catch((error) => {
  console.error(`windows-release-candidate-upload: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
