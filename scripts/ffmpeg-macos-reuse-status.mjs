#!/usr/bin/env node
// Read-only check for the owner's macOS release machine. It never rebuilds
// FFmpeg. scripts/build-ffmpeg-macos.sh already reuses vendor/ffmpeg/current
// when this check would pass; this command makes that reuse visible.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { probeCaptureClock, verifyCaptureClockManifest } from './ffmpeg-capture-clock.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = resolve(process.env.VIDEORC_FFMPEG_BUNDLE ?? join(repoRoot, 'vendor/ffmpeg/current'))
const sourceArchive = join(
  repoRoot,
  'vendor/ffmpeg/_src',
  `ffmpeg-${process.env.FFMPEG_VERSION ?? '8.1.1'}.tar.xz`
)
const rustTarget = join(repoRoot, 'target')
const patch = join(repoRoot, 'scripts/patches/avfoundation-capture-clock.patch')
const ffmpeg = join(bundle, 'bin/ffmpeg')
const ffprobe = join(bundle, 'bin/ffprobe')

function log(message) {
  console.log(`ffmpeg-macos-reuse-status: ${message}`)
}

if (!existsSync(ffmpeg) || !existsSync(ffprobe)) {
  log(`no reusable bundle at ${bundle}; pnpm ffmpeg:build:macos will compile from source.`)
  log('Keep vendor/ffmpeg/current and vendor/ffmpeg/_src between releases on this Mac.')
  process.exitCode = 1
  process.exit()
}

try {
  const fingerprint = verifyCaptureClockManifest(bundle, patch)
  const probe = probeCaptureClock(ffmpeg)
  let version = 'unknown'
  try {
    version = execFileSync(ffmpeg, ['-version'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .split('\n')[0]
      .trim()
  } catch {
    version = 'ffmpeg -version failed'
  }
  log(`reusable bundle at ${bundle}`)
  log(version)
  log(`capture clock protocol ${probe.protocol}; patch ${fingerprint}`)
  log(
    existsSync(sourceArchive)
      ? `source archive present at ${sourceArchive}`
      : `source archive absent; a rebuild would re-download ${process.env.FFMPEG_VERSION ?? '8.1.1'}`
  )
  log(
    existsSync(rustTarget)
      ? `Rust target/ present; leave it in place so package:backend:macos can incrementally link`
      : 'Rust target/ is cold; the first backend compile of this checkout will take longer'
  )
} catch (error) {
  log(`bundle is not reusable: ${error.message}`)
  log('pnpm ffmpeg:build:macos will rebuild. Do not set FFMPEG_REBUILD=1 unless the pin or patch changed.')
  process.exitCode = 1
}
