#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadChangelogEntries,
  mergeChangelogDocuments,
  requireChangelogEntryForRelease
} from './lib/changelog.mjs'
import { buildSignedS3Request, getReleaseUploadS3Config } from './lib/release-upload-s3.mjs'
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
  validateArtifactImmediatelyBeforeUpload({ manifestPath })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const trustedDesktopPackage = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')
  )
  const acceptedReleaseIds = await loadValidatedWindowsAcceptanceHistory(
    join(repoRoot, 'docs', 'acceptance', 'windows-alpha')
  )
  const config = getReleaseUploadS3Config()
  const changelogJsonPath =
    (process.env.VIDEORC_WINDOWS_RELEASE_STAGE?.trim() || 'public') === 'public'
      ? await prepareChangelog(manifest.releaseId, config)
      : null
  const plan = await buildWindowsReleaseUploadPlan({
    changelogJsonPath,
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
  const nextFeedYml = await readFile(join(releaseDir, 'latest.yml'), 'utf8')
  const currentFeedYml = await readRemoteTextObject({
    config,
    objectKey: `${plan.updatesPrefix}/latest.yml`
  })
  const transition = assertWindowsFeedTransition({
    acceptedReleaseIds,
    currentFeedYml,
    nextFeedYml,
    stage: plan.stage,
    trustedCurrentVersion: trustedDesktopPackage.version
  })

  console.log(
    `windows-alpha-release-upload: ${plan.stage} ${plan.releaseId} (${transition.kind}) to s3://${config.bucket}/${plan.prefix}`
  )
  for (const artifact of plan.artifacts) {
    const result = artifact.immutable
      ? await inspectRemoteArtifact({ artifact, config })
      : { state: 'mutable' }
    if (result.state === 'identical') {
      console.log(
        `windows-alpha-release-upload: reused exact immutable ${artifact.label} -> ${artifact.objectKey}`
      )
    } else {
      await uploadArtifact({ artifact, config })
      console.log(
        `windows-alpha-release-upload: uploaded ${artifact.label} -> ${artifact.objectKey}`
      )
    }
    await inspectRemoteArtifact({ artifact, config })
    console.log(`windows-alpha-release-upload: verified SHA-256 ${artifact.objectKey}`)
  }
  console.log('windows-alpha-release-upload: PASS')
}

async function prepareChangelog(releaseId, config) {
  const entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  requireChangelogEntryForRelease(entries, releaseId, { requiredPlatform: 'windows' })
  const outPath = join(repoRoot, 'dist', 'changelog', 'changelog.json')
  const remoteText = await readRemoteTextObject({
    config,
    objectKey: 'changelog/changelog.json'
  })
  const remoteDocument = parseRemoteChangelog(remoteText)
  const document = mergeChangelogDocuments({
    generatedAt: new Date().toISOString(),
    localEntries: entries,
    remoteDocument
  })
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`)
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
  const signed = buildSignedS3Request({ config, method: 'PUT', objectKey: artifact.objectKey })
  const response = await fetch(signed.url, {
    body: createReadStream(artifact.path),
    duplex: 'half',
    headers: {
      ...signed.headers,
      'Content-Length': String(artifact.sizeBytes),
      'Content-Type': artifact.contentType,
      ...(artifact.immutable ? { 'If-None-Match': '*' } : {})
    },
    method: 'PUT'
  })
  if (!response.ok) {
    throw new Error(`upload failed for ${artifact.objectKey}: HTTP ${response.status}`)
  }
}

function validateArtifactImmediatelyBeforeUpload({ manifestPath }) {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'validate-windows-release-artifact.mjs')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VIDEORC_RELEASE_DIR: releaseDir,
        VIDEORC_RELEASE_MANIFEST_PATH: manifestPath
      },
      stdio: 'inherit'
    }
  )
  if (result.status !== 0) {
    throw new Error(
      `release artifact validation failed immediately before upload (exit ${result.status ?? 'unknown'}).`
    )
  }
}

main().catch((error) => {
  console.error(`windows-alpha-release-upload: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
