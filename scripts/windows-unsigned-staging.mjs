#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createWindowsUnsignedStagingManifest,
  verifyWindowsUnsignedStagingManifest
} from './lib/windows-unsigned-staging.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const releaseDir = join(repoRoot, 'apps', 'desktop', 'release')
const rootDir = join(releaseDir, 'win-unpacked')
const mode = process.argv[2]
const signedMode = mode === '--write-signed' || mode === '--verify-signed'
const manifestPath = join(
  releaseDir,
  signedMode ? 'windows-signed-staging.json' : 'windows-unsigned-staging.json'
)
const releaseId = process.env.VIDEORC_RELEASE_ID?.trim()
const sourceCommit = process.env.VIDEORC_RELEASE_SOURCE_COMMIT?.trim()
const publisherName = process.env.VIDEORC_WINDOWS_PUBLISHER_NAME?.trim()

if (mode === '--write' || mode === '--write-signed') {
  const manifest = await createWindowsUnsignedStagingManifest({
    publisherName,
    releaseId,
    rootDir,
    sourceCommit
  })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
  console.log(`windows-unsigned-staging: WROTE ${manifest.files.length} files`)
} else if (mode === '--verify' || mode === '--verify-signed') {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = await verifyWindowsUnsignedStagingManifest({
    expectedPublisherName: publisherName,
    expectedReleaseId: releaseId,
    expectedSourceCommit: sourceCommit,
    manifest,
    rootDir
  })
  console.log(`windows-unsigned-staging: PASS (${result.fileCount} files)`)
} else {
  throw new Error(
    'Usage: windows-unsigned-staging.mjs --write|--verify|--write-signed|--verify-signed'
  )
}
