#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveReleaseUploadOrigins } from './lib/release-upload-origins.mjs'
import { buildSignedS3Request } from './lib/release-upload-s3.mjs'
import {
  assertPrivateLinuxCandidateS3Config,
  buildLinuxCandidateStoragePlan,
  classifyLinuxCandidateObjectHead
} from './lib/linux-release-candidate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.stage !== 'candidate') {
    throw new Error(
      `Linux Alpha upload refuses stage=${manifest.stage}; this lane stores private candidates only.`
    )
  }
  const { origins, primaryName } = resolveReleaseUploadOrigins()
  const plan = await buildLinuxCandidateStoragePlan({
    ffmpegLicensePath: resolve(
      process.env.VIDEORC_LINUX_FFMPEG_LICENSE_PATH ??
        join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'LICENSE.txt')
    ),
    ffmpegSourcePath: resolve(
      process.env.VIDEORC_LINUX_FFMPEG_SOURCE_PATH ??
        join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'SOURCE.txt')
    ),
    manifest,
    manifestPath,
    releaseDir
  })

  console.log(`linux-alpha-release-upload: ${plan.candidateIdentity}`)
  console.log(`linux-alpha-release-upload: prefix ${plan.prefix}`)
  console.log(
    `linux-alpha-release-upload: origins ${origins.map((origin) => origin.name).join(', ')} (primary ${primaryName})`
  )

  for (const origin of origins) {
    const config = assertPrivateLinuxCandidateS3Config(origin.config)
    for (const artifact of plan.artifacts) {
      const state = await headArtifact({ artifact, config })
      if (state === 'identical') {
        console.log(`linux-alpha-release-upload: identical ${origin.name} ${artifact.objectKey}`)
        continue
      }
      await putArtifact({ artifact, config })
      classifyLinuxCandidateObjectHead({
        artifact,
        response: await signedFetch({ config, method: 'HEAD', objectKey: artifact.objectKey })
      })
      console.log(`linux-alpha-release-upload: stored ${origin.name} ${artifact.objectKey}`)
    }
  }
  console.log('linux-alpha-release-upload: PASS')
}

async function headArtifact({ artifact, config }) {
  return classifyLinuxCandidateObjectHead({
    artifact,
    response: await signedFetch({ config, method: 'HEAD', objectKey: artifact.objectKey })
  })
}

async function putArtifact({ artifact, config }) {
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
    if (state === 'identical') return
  }
  if (!response.ok) {
    throw new Error(`candidate upload failed for ${artifact.objectKey}: HTTP ${response.status}`)
  }
}

function signedFetch({ config, method, objectKey }) {
  const signed = buildSignedS3Request({ config, method, objectKey })
  return fetch(signed.url, {
    headers: { ...signed.headers, 'accept-encoding': 'identity' },
    method,
    redirect: 'error'
  })
}

main().catch((error) => {
  console.error(`linux-alpha-release-upload: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
