// Asserts the macOS packaging inputs exist before electron-builder runs,
// because missing extraResources inputs should fail loudly before packaging.
// It also runs the bundled ffmpeg and fails closed when a required
// protocol/encoder is absent: 0.9.23 shipped an ffmpeg without TLS (rtmps
// stalled silently), and the repair path shipped for months pointing at a
// GPL encoder the LGPL bundle never had — file-exists checks catch neither.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeMacosFfmpegCapabilities } from './lib/repair-encoder-capabilities.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const inputs = [
  {
    path: join(repoRoot, 'target', 'release', 'videorc-backend'),
    remedy: 'pnpm package:backend:macos'
  },
  {
    path: join(repoRoot, 'target', 'release', 'native_preview_host_helper'),
    remedy: 'pnpm package:backend:macos'
  },
  {
    path: join(repoRoot, 'target', 'release', 'videorc_native_preview.node'),
    remedy: 'pnpm build:native-preview-addon:release'
  },
  {
    path: join(repoRoot, 'vendor', 'ffmpeg', 'current', 'bin', 'ffmpeg'),
    remedy: 'pnpm ffmpeg:build:macos'
  },
  {
    path: join(repoRoot, 'vendor', 'ffmpeg', 'current', 'bin', 'ffprobe'),
    remedy: 'FFMPEG_REBUILD=1 pnpm ffmpeg:build:macos'
  }
]

const missing = inputs.filter((input) => !existsSync(input.path))
for (const input of missing) {
  console.error(`preflight-macos-package: MISSING ${input.path} - produce it with: ${input.remedy}`)
}
if (missing.length > 0) {
  process.exit(1)
}

const nativePreviewAddon = join(repoRoot, 'target', 'release', 'videorc_native_preview.node')
try {
  execFileSync('lipo', [nativePreviewAddon, '-verify_arch', 'arm64', 'x86_64'], {
    stdio: 'pipe'
  })
} catch (error) {
  console.error(
    `preflight-macos-package: native preview addon is not universal arm64+x86_64: ${
      error instanceof Error ? error.message : String(error)
    }\nRebuild with: pnpm build:native-preview-addon:release`
  )
  process.exit(1)
}

const ffmpegBin = join(repoRoot, 'vendor', 'ffmpeg', 'current', 'bin', 'ffmpeg')
let capabilities
try {
  capabilities = probeMacosFfmpegCapabilities(ffmpegBin, { execFileSync })
} catch (error) {
  console.error(
    `preflight-macos-package: could not run ${ffmpegBin} to probe capabilities: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
  process.exit(1)
}
if (!capabilities.ok) {
  console.error(
    `preflight-macos-package: bundled ffmpeg is missing required capabilities: ${capabilities.missing.join(', ')}.\n` +
      'Refusing to package — an ffmpeg without rtmps/tls stalls livestreams silently, and one ' +
      'without h264_videotoolbox cannot run transcode repairs, and one without afftdn/aac/' +
      'pcm_s16le cannot run Noise Cleanup for every supported container. Rebuild with: pnpm ffmpeg:build:macos'
  )
  process.exit(1)
}
console.log(
  'preflight-macos-package: bundled ffmpeg capability probe passed (rtmp/rtmps/tls, h264_videotoolbox, aac, pcm_s16le, afftdn).'
)

try {
  execFileSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'smoke-noise-cleanup.mjs'), '--require-bundled'],
    {
      env: {
        ...process.env,
        VIDEORC_SMOKE_FFMPEG_PATH: ffmpegBin,
        VIDEORC_SMOKE_FFPROBE_PATH: join(repoRoot, 'vendor', 'ffmpeg', 'current', 'bin', 'ffprobe')
      },
      stdio: 'inherit'
    }
  )
} catch (error) {
  console.error(
    `preflight-macos-package: bundled ffmpeg failed the MP4/MKV Noise Cleanup artifact proof: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
  process.exit(1)
}

console.log('preflight-macos-package: all macOS packaging inputs present.')
