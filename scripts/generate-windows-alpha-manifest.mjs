#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildWindowsAlphaReleaseManifest,
  findLatestWindowsInstaller,
  formatSha256File,
  sha256File
} from './lib/windows-alpha-release.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(repoRoot, 'apps', 'desktop', 'release')

async function main() {
  const artifactPath = await resolveArtifactPath()
  if (!artifactPath) {
    throw new Error('No Windows NSIS installer found under apps/desktop/release.')
  }

  const packageVersion = await readPackageVersion()
  const info = await stat(artifactPath)
  const sha256 = await sha256File(artifactPath)
  const manifest = buildWindowsAlphaReleaseManifest({
    artifactPath,
    packageVersion,
    publisherName: process.env.VIDEORC_WINDOWS_PUBLISHER_NAME,
    sha256,
    sizeBytes: info.size,
    sourceCommit: currentCommit()
  })

  const outputDir = resolve(process.env.VIDEORC_RELEASE_MANIFEST_DIR ?? dirname(artifactPath))
  await mkdir(outputDir, { recursive: true })
  const manifestPath = join(outputDir, 'release.json')
  const shaPath = join(outputDir, `${manifest.filename}.sha256`)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(shaPath, formatSha256File({ sha256, filename: manifest.filename }))

  console.log(`windows-alpha-release-manifest: wrote ${relativeToRepo(manifestPath)}`)
  console.log(`windows-alpha-release-manifest: wrote ${relativeToRepo(shaPath)}`)
  console.log(`windows-alpha-release-manifest: ${manifest.releaseId} ${manifest.filename}`)
}

async function resolveArtifactPath() {
  const explicit = process.env.VIDEORC_RELEASE_ARTIFACT
  if (explicit?.trim()) {
    return resolve(explicit)
  }
  return (await findLatestWindowsInstaller(releaseDir))?.path ?? null
}

async function readPackageVersion() {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')
  )
  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error('apps/desktop/package.json must include a version.')
  }
  return packageJson.version.trim()
}

function currentCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('Unable to resolve the source Git commit.')
  }
  return result.stdout.trim()
}

function relativeToRepo(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path
}

main().catch((error) => {
  console.error(`windows-alpha-release-manifest: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
