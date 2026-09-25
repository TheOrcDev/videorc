#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assessLinuxFfmpegCapabilities } from './lib/ffmpeg-linux-pin.mjs'
import { LINUX_ALPHA_UPDATE_FEED_NAME, sha256File, sha512File } from './lib/linux-alpha-release.mjs'
import {
  formatLinuxReleaseValidationReport,
  validateLinuxReleaseFacts
} from './lib/linux-release-artifact-validation.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  if (process.platform !== 'linux') {
    throw new Error(`Linux release validation must run on linux, got ${process.platform}.`)
  }
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const appImagePath = join(releaseDir, manifest.filename)
  const appImageInfo = await stat(appImagePath)
  const unpackedResources = join(releaseDir, 'linux-unpacked', 'resources')
  const unpackedApp = join(releaseDir, 'linux-unpacked', 'videorc')
  const bundledFfmpeg = join(unpackedResources, 'ffmpeg', 'bin', 'ffmpeg')

  const result = validateLinuxReleaseFacts({
    actualSha256: await sha256File(appImagePath),
    actualSha512: await sha512File(appImagePath),
    actualSizeBytes: appImageInfo.size,
    expectedSourceCommit: expectedSourceCommit(),
    feedYml: await readFile(join(releaseDir, LINUX_ALPHA_UPDATE_FEED_NAME), 'utf8'),
    ffmpegCapabilities: probeBundledFfmpeg(bundledFfmpeg),
    files: {
      appImage: existsSync(appImagePath),
      backend: existsSync(join(unpackedResources, 'videorc-backend')),
      ffmpeg: existsSync(bundledFfmpeg),
      ffmpegBuildConfig: existsSync(join(unpackedResources, 'ffmpeg', 'BUILD-CONFIG.txt')),
      ffmpegLicense: existsSync(join(unpackedResources, 'ffmpeg', 'LICENSE.txt')),
      ffmpegSource: existsSync(join(unpackedResources, 'ffmpeg', 'SOURCE.txt')),
      ffprobe: existsSync(join(unpackedResources, 'ffmpeg', 'bin', 'ffprobe')),
      unpackedApp: existsSync(unpackedApp)
    },
    manifest,
    sha256FileText: await readFile(join(releaseDir, `${manifest.filename}.sha256`), 'utf8')
  })

  console.log(formatLinuxReleaseValidationReport(result))
}

function probeBundledFfmpeg(executable) {
  if (!existsSync(executable)) {
    return { ok: false, problems: [`missing bundled ffmpeg at ${executable}`] }
  }
  const versionOutput = execFileSync(executable, ['-version'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const encodersOutput = execFileSync(executable, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return assessLinuxFfmpegCapabilities({ encodersOutput, versionOutput })
}

function currentCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  if (result.status !== 0 || !/^[a-f0-9]{40}$/i.test(result.stdout?.trim() ?? '')) {
    throw new Error('Unable to resolve the exact checked-out source commit.')
  }
  return result.stdout.trim()
}

function expectedSourceCommit() {
  const explicit = process.env.VIDEORC_RELEASE_SOURCE_COMMIT?.trim()
  if (explicit) {
    if (!/^[a-f0-9]{40}$/.test(explicit)) {
      throw new Error(
        'VIDEORC_RELEASE_SOURCE_COMMIT must be a lowercase full 40-character Git SHA.'
      )
    }
    return explicit
  }
  return currentCommit()
}

main().catch((error) => {
  console.error(`linux-release-artifact: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
