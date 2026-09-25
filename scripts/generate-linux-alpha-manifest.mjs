#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildLinuxAlphaReleaseManifest,
  buildLinuxUpdateFeedYml,
  findLatestLinuxAppImage,
  formatSha256File,
  LINUX_ALPHA_UPDATE_FEED_NAME,
  sha256File,
  sha512File
} from './lib/linux-alpha-release.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(repoRoot, 'apps', 'desktop', 'release')

async function main() {
  const artifactPath = await resolveArtifactPath()
  if (!artifactPath) {
    throw new Error('No Linux x64 AppImage found under apps/desktop/release.')
  }

  const packageVersion = await readPackageVersion()
  const info = await stat(artifactPath)
  const sha256 = await sha256File(artifactPath)
  const sha512 = await sha512File(artifactPath)
  const manifest = buildLinuxAlphaReleaseManifest({
    artifactPath,
    packageVersion,
    sha256,
    sizeBytes: info.size,
    sourceCommit: currentCommit()
  })

  const outputDir = resolve(process.env.VIDEORC_RELEASE_MANIFEST_DIR ?? dirname(artifactPath))
  await mkdir(outputDir, { recursive: true })
  const manifestPath = join(outputDir, 'release.json')
  const shaPath = join(outputDir, `${manifest.filename}.sha256`)
  const feedPath = join(outputDir, LINUX_ALPHA_UPDATE_FEED_NAME)
  const feedYml = buildLinuxUpdateFeedYml({
    filename: manifest.filename,
    releaseDate: manifest.releasedAt,
    sha512,
    sizeBytes: manifest.sizeBytes,
    version: manifest.bundleVersion
  })

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(shaPath, formatSha256File({ sha256, filename: manifest.filename }))
  await writeFile(feedPath, feedYml)

  console.log(`linux-alpha-release-manifest: wrote ${relativeToRepo(manifestPath)}`)
  console.log(`linux-alpha-release-manifest: wrote ${relativeToRepo(shaPath)}`)
  console.log(`linux-alpha-release-manifest: wrote ${relativeToRepo(feedPath)}`)
  console.log(`linux-alpha-release-manifest: ${manifest.releaseId} ${manifest.filename}`)
}

async function resolveArtifactPath() {
  const explicit = process.env.VIDEORC_RELEASE_ARTIFACT
  if (explicit?.trim()) {
    return resolve(explicit)
  }
  return (await findLatestLinuxAppImage(releaseDir))?.path ?? null
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
  const explicit = process.env.VIDEORC_RELEASE_SOURCE_COMMIT?.trim()
  if (explicit) {
    if (!/^[a-f0-9]{40}$/.test(explicit)) {
      throw new Error(
        'VIDEORC_RELEASE_SOURCE_COMMIT must be a lowercase full 40-character Git SHA.'
      )
    }
    return explicit
  }
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
  console.error(`linux-alpha-release-manifest: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
