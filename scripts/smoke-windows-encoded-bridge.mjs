import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { parseWindowsEncodedBridgeArgs } from './lib/windows-encoded-bridge-profiles.mjs'

if (process.platform !== 'win32') {
  throw new Error('The packaged Windows encoded-bridge smoke must run on Windows.')
}

const repoRoot = resolve(import.meta.dirname, '..')
const baseOutput = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? 'docs/acceptance/artifacts/windows/encoded-bridge'
)
const encodedBridgeArgs = process.argv.slice(2)
const options = parseWindowsEncodedBridgeArgs(encodedBridgeArgs)
const runCameraProfiles = encodedBridgeArgs.length === 0
const cameraProfiles = [
  ['screen-camera-1080p30', 1920, 1080, 30, 6000],
  ['screen-camera-1080p60', 1920, 1080, 60, 9000]
]

for (const { id, width, height, fps, bitrateKbps } of options.profiles) {
  console.log(`Windows encoded bridge: ${id}`)
  const result = spawnSync('pnpm', ['smoke:windows-native-screen'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts',
      VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE: '1',
      ...(!options.d3d11 && !options.expectFallback
        ? { VIDEORC_WINDOWS_REQUIRE_GRAPHICS_CAPTURE: '1' }
        : {}),
      ...(!options.d3d11 && !options.expectFallback && !id.startsWith('vertical-')
        ? { VIDEORC_WINDOWS_REQUIRE_DIRECT_D3D11_RECORDING: '1' }
        : {}),
      ...(options.d3d11 ? { VIDEORC_WINDOWS_D3D11_MEDIA: '1' } : {}),
      ...(options.requireD3d11 ? { VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA: '1' } : {}),
      ...(options.expectFallback === 'natural'
        ? { VIDEORC_WINDOWS_EXPECT_D3D11_FALLBACK: 'natural' }
        : {}),
      VIDEORC_SMOKE_OUTPUT_DIR: join(baseOutput, id),
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
    throw new Error(`Windows encoded bridge ${id} failed with exit code ${result.status}.`)
  }
}

for (const [label, width, height, fps, bitrateKbps] of runCameraProfiles ? cameraProfiles : []) {
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
  runCameraProfiles
    ? `Windows encoded bridge PASS: ${options.profiles.length} screen profiles and ${cameraProfiles.length} screen+camera profiles.`
    : `Windows encoded bridge PASS: ${options.profiles.length} selected packaged record-only profiles.`
)
