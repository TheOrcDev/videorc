import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('The packaged Windows encoded-bridge smoke must run on Windows.')
}

const repoRoot = resolve(import.meta.dirname, '..')
const baseOutput = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? 'docs/acceptance/artifacts/windows/encoded-bridge'
)
const profiles = [
  ['1080p30', 1920, 1080, 30, 6000],
  ['1080p60', 1920, 1080, 60, 9000],
  ['1440p30', 2560, 1440, 30, 12000],
  ['1440p60', 2560, 1440, 60, 18000],
  ['4k30', 3840, 2160, 30, 30000],
  ['vertical-1080p30', 1080, 1920, 30, 6000],
  ['vertical-1080p60', 1080, 1920, 60, 9000],
  ['vertical-1440p30', 1440, 2560, 30, 12000],
  ['vertical-1440p60', 1440, 2560, 60, 18000],
  ['vertical-4k30', 2160, 3840, 30, 30000]
]
const cameraProfiles = [
  ['screen-camera-1080p30', 1920, 1080, 30, 6000],
  ['screen-camera-1080p60', 1920, 1080, 60, 9000]
]

for (const [label, width, height, fps, bitrateKbps] of profiles) {
  console.log(`Windows encoded bridge: ${label}`)
  const result = spawnSync('pnpm', ['smoke:windows-native-screen'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts',
      VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE: '1',
      VIDEORC_WINDOWS_REQUIRE_GRAPHICS_CAPTURE: '1',
      ...(label.startsWith('vertical-')
        ? {}
        : { VIDEORC_WINDOWS_REQUIRE_DIRECT_D3D11_RECORDING: '1' }),
      VIDEORC_SMOKE_OUTPUT_DIR: join(baseOutput, label),
      VIDEORC_SMOKE_VIDEO_WIDTH: String(width),
      VIDEORC_SMOKE_VIDEO_HEIGHT: String(height),
      VIDEORC_SMOKE_VIDEO_FPS: String(fps),
      VIDEORC_SMOKE_VIDEO_BITRATE_KBPS: String(bitrateKbps),
      VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS:
        process.env.VIDEORC_WINDOWS_ENCODED_BRIDGE_RECORDING_MS ?? '8000',
      VIDEORC_SMOKE_TIMEOUT_MS: process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? '240000'
    }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Windows encoded bridge ${label} failed with exit code ${result.status}.`)
  }
}

for (const [label, width, height, fps, bitrateKbps] of cameraProfiles) {
  console.log(`Windows encoded bridge: ${label}`)
  const result = spawnSync('pnpm', ['smoke:windows-native-screen'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts',
      VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE: '1',
      VIDEORC_WINDOWS_REQUIRE_GRAPHICS_CAPTURE: '1',
      VIDEORC_WINDOWS_REQUIRE_DIRECT_D3D11_RECORDING: '1',
      VIDEORC_WINDOWS_INCLUDE_CAMERA: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: join(baseOutput, label),
      VIDEORC_SMOKE_VIDEO_WIDTH: String(width),
      VIDEORC_SMOKE_VIDEO_HEIGHT: String(height),
      VIDEORC_SMOKE_VIDEO_FPS: String(fps),
      VIDEORC_SMOKE_VIDEO_BITRATE_KBPS: String(bitrateKbps),
      VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS:
        process.env.VIDEORC_WINDOWS_ENCODED_BRIDGE_RECORDING_MS ?? '8000',
      VIDEORC_SMOKE_TIMEOUT_MS: process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? '240000'
    }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Windows encoded bridge ${label} failed with exit code ${result.status}.`)
  }
}

console.log(
  `Windows encoded bridge PASS: ${profiles.length} screen profiles and ${cameraProfiles.length} screen+camera profiles.`
)
