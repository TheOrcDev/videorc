// Asserts the Windows packaging inputs exist before electron-builder runs,
// because electron-builder's behavior on a missing extraResources source is
// not a reliable loud failure. On a Windows host it also runs the bundled
// ffmpeg and fails closed when a required protocol/encoder is absent —
// the 0.9.23 macOS release proved a file-exists check cannot catch an
// ffmpeg without a TLS stack (rtmps stalls silently mid-stream).
// Run by package:desktop:windows.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeWindowsFfmpegCapabilities } from './lib/windows-ffmpeg-capabilities.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ffmpegExe = join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'bin', 'ffmpeg.exe')
const bundledBackgrounds = [
  'code-demo.webp',
  'dark-mode.webp',
  'focus.webp',
  'light-mode.webp',
  'livestream.webp',
  'minimal-desk.webp',
  'podcast.webp',
  'product-launch.webp',
  'tutorial.webp',
  'webinar.webp'
]

const inputs = [
  {
    path: join(repoRoot, 'target', 'release', 'videorc-backend.exe'),
    remedy: 'pnpm package:backend'
  },
  {
    path: ffmpegExe,
    remedy: 'pnpm ffmpeg:fetch:windows'
  },
  {
    // The backend resolves ffprobe as a sibling of the bundled ffmpeg
    // (ffmpeg.rs); repair/import/probe break without it.
    path: join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'bin', 'ffprobe.exe'),
    remedy: 'pnpm ffmpeg:fetch:windows'
  },
  ...bundledBackgrounds.map((fileName) => ({
    path: join(
      repoRoot,
      'apps',
      'desktop',
      'src',
      'renderer',
      'src',
      'assets',
      'backgrounds',
      fileName
    ),
    remedy: 'restore the bundled background assets before packaging'
  }))
]

const missing = inputs.filter((input) => !existsSync(input.path))
for (const input of missing) {
  console.error(
    `preflight-windows-package: MISSING ${input.path} — produce it with: ${input.remedy}`
  )
}
if (missing.length > 0) {
  process.exit(1)
}

if (process.platform === 'win32') {
  let capabilities
  try {
    capabilities = probeWindowsFfmpegCapabilities(ffmpegExe, { execFileSync })
  } catch (error) {
    console.error(
      `preflight-windows-package: could not run ${ffmpegExe} to probe capabilities: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    process.exit(1)
  }
  if (!capabilities.ok) {
    console.error(
      `preflight-windows-package: bundled ffmpeg is missing required capabilities: ${capabilities.missing.join(', ')}.\n` +
        'Refusing to package — an ffmpeg without rtmps/tls stalls livestreams silently, and one without afftdn/aac/pcm_s16le cannot run Noise Cleanup for every supported container. Re-pin a build that carries them.'
    )
    process.exit(1)
  }
  console.log(
    'preflight-windows-package: bundled ffmpeg capability probe passed (rtmp/rtmps/tls, h264_mf, aac, pcm_s16le, afftdn).'
  )
  try {
    execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'smoke-noise-cleanup.mjs'), '--require-bundled'],
      {
        env: {
          ...process.env,
          VIDEORC_SMOKE_FFMPEG_PATH: ffmpegExe,
          VIDEORC_SMOKE_FFPROBE_PATH: join(
            repoRoot,
            'vendor',
            'ffmpeg',
            'windows-x64',
            'bin',
            'ffprobe.exe'
          )
        },
        stdio: 'inherit'
      }
    )
  } catch (error) {
    console.error(
      `preflight-windows-package: bundled ffmpeg failed the MP4/MKV Noise Cleanup artifact proof: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    process.exit(1)
  }
} else {
  console.log(
    'preflight-windows-package: skipping the ffmpeg capability probe (ffmpeg.exe cannot run on this host); it runs on the Windows box.'
  )
}

console.log('preflight-windows-package: all Windows packaging inputs present.')
