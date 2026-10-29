#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assessLinuxFfmpegCapabilities } from './lib/ffmpeg-linux-pin.mjs'
import {
  assertLinuxReleaseManifest,
  LINUX_UPDATE_FEED_NAME,
  sha256File,
  sha512File
} from './lib/linux-release.mjs'
import {
  withLinuxAppImagePayload,
  payloadFilePresent,
  assertLinuxX64Elf
} from './lib/linux-appimage-payload.mjs'
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import {
  buildFlagsProblems,
  fuseWireProblems,
  readPackagedBuildFlags
} from './lib/packaged-app-hardening.mjs'
import {
  formatLinuxReleaseValidationReport,
  linuxReleaseBuildIdentityProblems,
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
  assertLinuxReleaseManifest(manifest)
  const appImagePath = join(releaseDir, manifest.filename)
  const appImageInfo = await stat(appImagePath)
  const result = await withLinuxAppImagePayload(
    { artifactPath: appImagePath, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes },
    async (root) => {
      const executable = join(root, 'videorc')
      const required = {
        unpackedApp: ['videorc', true],
        appArchive: ['resources/app.asar', false],
        backend: ['resources/videorc-backend', true],
        ffmpeg: ['resources/ffmpeg/bin/ffmpeg', true],
        ffprobe: ['resources/ffmpeg/bin/ffprobe', true],
        ffmpegBuildConfig: ['resources/ffmpeg/BUILD-CONFIG.txt', false],
        ffmpegLicense: ['resources/ffmpeg/LICENSE.txt', false],
        ffmpegSource: ['resources/ffmpeg/SOURCE.txt', false]
      }
      const files = { appImage: true }
      for (const [name, [path, executable]] of Object.entries(required)) {
        files[name] = await payloadFilePresent(root, path, { executable })
        if (!files[name]) throw new Error(`AppImage payload missing or unsafe: ${path}`)
        if (executable) await assertLinuxX64Elf(join(root, path))
      }
      const buildFlags = readPackagedBuildFlags(executable)
      const hardeningProblems = [
        ...fuseWireProblems(await getCurrentFuseWire(executable), FuseV1Options),
        ...buildFlagsProblems(buildFlags),
        ...linuxReleaseBuildIdentityProblems(buildFlags, manifest)
      ]
      if (hardeningProblems.length) throw new Error(hardeningProblems.join('; '))
      return validateLinuxReleaseFacts({
        actualSha256: await sha256File(appImagePath),
        actualSha512: await sha512File(appImagePath),
        actualSizeBytes: appImageInfo.size,
        expectedSourceCommit: expectedSourceCommit(),
        feedYml: await readFile(join(releaseDir, LINUX_UPDATE_FEED_NAME), 'utf8'),
        ffmpegCapabilities: probeBundledFfmpeg(join(root, 'resources/ffmpeg/bin/ffmpeg')),
        files,
        manifest,
        sha256FileText: await readFile(join(releaseDir, `${manifest.filename}.sha256`), 'utf8')
      })
    }
  )

  console.log(formatLinuxReleaseValidationReport(result))
}

function probeBundledFfmpeg(executable) {
  if (!existsSync(executable)) {
    return { ok: false, problems: [`missing bundled ffmpeg at ${executable}`] }
  }
  const versionOutput = execFileSync(executable, ['-version'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 30_000,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const encodersOutput = execFileSync(executable, ['-hide_banner', '-encoders'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 30_000,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const listing = (flag) =>
    execFileSync(executable, ['-hide_banner', flag], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 30_000,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  const filtersOutput = listing('-filters')
  return assessLinuxFfmpegCapabilities({
    encodersOutput,
    filtersOutput,
    versionOutput,
    // The replay ring (plan 181): segment muxer, concat demuxer, aac_adtstoasc.
    muxersOutput: listing('-muxers'),
    demuxersOutput: listing('-demuxers'),
    bitstreamFiltersOutput: listing('-bsfs')
  })
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
