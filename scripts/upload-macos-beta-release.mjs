#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadChangelogEntries,
  mergeChangelogDocuments,
  requireChangelogEntryForRelease
} from './lib/changelog.mjs'
import {
  buildReleaseUploadPlan,
  buildSignedS3Request,
  getReleaseUploadS3Config
} from './lib/release-upload-s3.mjs'
import { readRemoteTextObject } from './lib/windows-release-publication.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultReleaseDir = join(repoRoot, 'apps', 'desktop', 'release')

async function main() {
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(defaultReleaseDir, 'release.json')
  )
  const releaseDir = resolve(process.env.VIDEORC_RELEASE_DIR ?? dirname(manifestPath))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const config = getReleaseUploadS3Config()
  const changelogJsonPath = await prepareChangelogUpload(manifest.releaseId, config)
  const plan = await buildReleaseUploadPlan({
    changelogJsonPath,
    manifest,
    manifestPath,
    releaseDir
  })

  console.log(
    `macos-beta-release-upload: uploading ${plan.releaseId} to s3://${config.bucket}/${plan.prefix}`
  )

  for (const artifact of plan.artifacts) {
    await uploadArtifact({ artifact, config })
    console.log(
      `macos-beta-release-upload: uploaded ${artifact.label} ${artifact.sizeBytes} bytes -> ${artifact.objectKey}`
    )
  }

  if (!envFlag(process.env.VIDEORC_RELEASE_UPLOAD_SKIP_VERIFY)) {
    for (const artifact of plan.artifacts) {
      await verifyArtifact({ artifact, config })
      console.log(`macos-beta-release-upload: verified ${artifact.objectKey}`)
    }
  }

  console.log('macos-beta-release-upload: PASS')
}

// Fail-closed: a release cannot ship without a user-facing changelog entry for
// its releaseId. VIDEORC_RELEASE_SKIP_CHANGELOG=1 is the emergency escape — it
// warns loudly and still publishes whatever entries DO validate.
async function prepareChangelogUpload(releaseId, config) {
  const skip = envFlag(process.env.VIDEORC_RELEASE_SKIP_CHANGELOG)
  let entries
  try {
    entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  } catch (error) {
    if (!skip) {
      throw error
    }
    console.warn(
      `macos-beta-release-upload: WARNING changelog invalid and VIDEORC_RELEASE_SKIP_CHANGELOG is set — shipping WITHOUT a changelog update (${error.message})`
    )
    return null
  }

  const { skipped } = requireChangelogEntryForRelease(entries, releaseId, { skip })
  if (skipped) {
    console.warn(
      `macos-beta-release-upload: WARNING no changelog entry for ${releaseId} and VIDEORC_RELEASE_SKIP_CHANGELOG is set — the website and What's New will not show this release`
    )
  }

  const outPath = join(repoRoot, 'dist', 'changelog', 'changelog.json')
  const remoteText = await readRemoteTextObject({
    config,
    objectKey: 'changelog/changelog.json'
  })
  const document = mergeChangelogDocuments({
    generatedAt: new Date().toISOString(),
    localEntries: entries,
    remoteDocument: parseRemoteChangelog(remoteText)
  })
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`)
  console.log(
    `macos-beta-release-upload: changelog compiled (${entries.length} entries, latest ${entries[0].version})`
  )
  return outPath
}

function parseRemoteChangelog(text) {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Published changelog/changelog.json is not valid JSON.')
  }
}

async function uploadArtifact({ artifact, config }) {
  const signed = buildSignedS3Request({
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
      'Content-Type': artifact.contentType
    },
    method: 'PUT'
  })

  if (!response.ok) {
    throw new Error(`upload failed for ${artifact.objectKey}: HTTP ${response.status}`)
  }
}

async function verifyArtifact({ artifact, config }) {
  const signed = buildSignedS3Request({
    config,
    method: 'HEAD',
    objectKey: artifact.objectKey
  })
  const response = await fetch(signed.url, {
    headers: signed.headers,
    method: 'HEAD'
  })

  if (!response.ok) {
    throw new Error(`verification failed for ${artifact.objectKey}: HTTP ${response.status}`)
  }

  const remoteSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(remoteSize) && remoteSize > 0 && remoteSize !== artifact.sizeBytes) {
    throw new Error(
      `verification failed for ${artifact.objectKey}: expected ${artifact.sizeBytes} bytes, got ${remoteSize}`
    )
  }
}

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

main().catch((error) => {
  console.error(`macos-beta-release-upload: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
