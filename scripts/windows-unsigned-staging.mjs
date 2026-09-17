#!/usr/bin/env node

import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createWindowsUnsignedStagingManifest,
  verifyWindowsUnsignedStagingManifest
} from './lib/windows-unsigned-staging.mjs'
import {
  buildWindowsAppUpdateYaml,
  readWindowsPublishConfig,
  updaterCacheDirNameFor
} from './lib/windows-app-update-config.mjs'

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

/**
 * electron-builder only emits resources/app-update.yml for nsis/appx packs, so
 * the `--win dir` unsigned pack leaves it out and the protected --prepackaged
 * build never recreates it. Write it here, before the manifest hashes the tree,
 * so the updater config travels inside the signed payload.
 */
async function ensureAppUpdateConfig() {
  const target = join(rootDir, 'resources', 'app-update.yml')
  try {
    await access(target)
    console.log('windows-unsigned-staging: app-update.yml already present')
    return
  } catch {
    // electron-builder did not write it; fall through and generate it.
  }
  const desktopDir = join(repoRoot, 'apps', 'desktop')
  const packageName = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8')).name
  const yaml = buildWindowsAppUpdateYaml({
    publish: readWindowsPublishConfig(join(desktopDir, 'electron-builder.windows-unsigned.cjs')),
    updaterCacheDirName: updaterCacheDirNameFor(packageName)
  })
  await writeFile(target, yaml, 'utf8')
  console.log('windows-unsigned-staging: generated resources/app-update.yml')
}

if (mode === '--write' || mode === '--write-signed') {
  if (mode === '--write') {
    await ensureAppUpdateConfig()
  }
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
