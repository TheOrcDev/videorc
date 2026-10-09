#!/usr/bin/env node

// Stores the deb/rpm distro packages under the same immutable private Linux
// Alpha candidate prefix as the AppImage (plan 071). The manifest (release.json)
// and latest-linux.yml stay AppImage-only, so this script uploads ONLY the
// deb/rpm objects built by the release lane:
//
//   candidates/linux-alpha/<releaseId>/<sourceCommit>/Videorc-<version>-linux-x64.deb
//   candidates/linux-alpha/<releaseId>/<sourceCommit>/Videorc-<version>-linux-x64.rpm
//
// Everything reuses the AppImage uploader's S3 + origin machinery: the same
// candidate checks, immutable PUT (If-None-Match: * + x-amz-meta-sha256) and
// collision refusal. Defaults to VIDEORC_RELEASE_DIR/_MANIFEST_PATH like its
// sibling uploader; the package paths default to the same release dir and can
// be overridden via VIDEORC_LINUX_DEB_PATH / VIDEORC_LINUX_RPM_PATH.

import { releaseControllerEnabled } from './lib/release-coordinator.mjs'

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
import { linuxDistPackageFilename } from './lib/linux-dist-package.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  if (await releaseControllerEnabled())
    throw new Error(
      'Linux public publication requires a controller finalizer before cutover. Its private candidate workflow remains supported.'
    )
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.stage !== 'candidate') {
    throw new Error(
      `linux-dist-package-upload refuses stage=${manifest.stage}; this lane stores private candidates only.`
    )
  }

  const distPackagePaths = {
    deb: resolve(
      process.env.VIDEORC_LINUX_DEB_PATH ??
        join(releaseDir, linuxDistPackageFilename(manifest.bundleVersion, 'deb'))
    ),
    rpm: resolve(
      process.env.VIDEORC_LINUX_RPM_PATH ??
        join(releaseDir, linuxDistPackageFilename(manifest.bundleVersion, 'rpm'))
    )
  }

  const { origins, primaryName } = resolveReleaseUploadOrigins()
  const plan = await buildLinuxCandidateStoragePlan({
    distPackagePaths,
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
  const distArtifacts = plan.artifacts.filter((artifact) =>
    ['deb', 'rpm'].includes(artifact.label)
  )
  if (distArtifacts.length === 0) {
    throw new Error('No deb/rpm objects in the Linux candidate storage plan.')
  }

  console.log(`linux-dist-package-upload: ${plan.candidateIdentity}`)
  console.log(`linux-dist-package-upload: prefix ${plan.prefix}`)
  console.log(
    `linux-dist-package-upload: origins ${origins.map((origin) => origin.name).join(', ')} (primary ${primaryName})`
  )

  for (const origin of origins) {
    const config = assertPrivateLinuxCandidateS3Config(origin.config)
    for (const artifact of distArtifacts) {
      const state = await headArtifact({ artifact, config })
      if (state === 'identical') {
        console.log(`linux-dist-package-upload: identical ${origin.name} ${artifact.objectKey}`)
        continue
      }
      await putArtifact({ artifact, config })
      classifyLinuxCandidateObjectHead({
        artifact,
        response: await signedFetch({ config, method: 'HEAD', objectKey: artifact.objectKey })
      })
      console.log(`linux-dist-package-upload: stored ${origin.name} ${artifact.objectKey}`)
    }
  }
  console.log('linux-dist-package-upload: PASS')
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
  console.error(`linux-dist-package-upload: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})