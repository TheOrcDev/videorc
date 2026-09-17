#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadChangelogEntries,
  mergeChangelogDocuments,
  requireChangelogEntryForRelease
} from './lib/changelog.mjs'
import { getReleaseUploadS3Config } from './lib/release-upload-s3.mjs'
import { loadValidatedWindowsAcceptanceHistory } from './lib/windows-acceptance-history.mjs'
import { buildWindowsReleaseUploadPlan } from './lib/windows-release-upload.mjs'
import {
  assertWindowsFeedTransition,
  inspectRemoteArtifact,
  readRemoteTextObject
} from './lib/windows-release-publication.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const trustedDesktopPackage = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')
  )
  const acceptedReleaseIds = await loadValidatedWindowsAcceptanceHistory(
    join(repoRoot, 'docs', 'acceptance', 'windows-alpha')
  )
  const config = getReleaseUploadS3Config()
  const entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  requireChangelogEntryForRelease(entries, manifest.releaseId, {
    requiredPlatform: 'windows'
  })
  const plan = await buildWindowsReleaseUploadPlan({
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
  if (plan.stage === 'public') {
    const publishedChangelogText = await readRemoteTextObject({
      config,
      objectKey: 'changelog/changelog.json'
    })
    mergeChangelogDocuments({
      generatedAt: new Date().toISOString(),
      localEntries: entries,
      remoteDocument: parseRemoteChangelog(publishedChangelogText)
    })
  }
  const currentFeedYml = await readRemoteTextObject({
    config,
    objectKey: `${plan.updatesPrefix}/latest.yml`
  })
  const transition = assertWindowsFeedTransition({
    acceptedReleaseIds,
    currentFeedYml,
    nextFeedYml: await readFile(join(releaseDir, 'latest.yml'), 'utf8'),
    stage: plan.stage,
    trustedCurrentVersion: trustedDesktopPackage.version
  })
  let existingImmutableCount = 0
  for (const artifact of plan.artifacts.filter((item) => item.immutable)) {
    const remote = await inspectRemoteArtifact({ artifact, config })
    if (remote.state === 'identical') existingImmutableCount += 1
  }

  console.log('windows-release-upload-preflight: PASS')
  console.log(`[ok] S3 access key (${config.accessKeyId ? 'present' : 'missing'})`)
  console.log(`[ok] S3 bucket (${config.bucket ? 'present' : 'missing'})`)
  console.log(`[ok] ${plan.stage} release ${plan.releaseId}`)
  console.log(`[ok] ${plan.stage} feed transition (${transition.kind})`)
  console.log(`[ok] ${existingImmutableCount} existing immutable objects match exactly`)
  console.log(`[ok] ${plan.artifacts.length} required upload objects`)
}

function parseRemoteChangelog(text) {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Published changelog/changelog.json is not valid JSON.')
  }
}

main().catch((error) => {
  console.error(`windows-release-upload-preflight: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
