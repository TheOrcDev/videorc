import { spawnSync } from 'node:child_process'

// True when the ffmpeg binary can actually run. Used to skip the ffmpeg-spawning
// integration tests where no binary is present (e.g. the headless CI runner);
// those tests still run locally and in the release job where ffmpeg is installed.
// Mirrors the Rust side, which #[ignore]s its ffmpeg tests in CI.
export function ffmpegAvailable(ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg') {
  try {
    return spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

// Video codec args for synthetic H.264 fixtures, picked from what this ffmpeg
// can actually encode. The vendored Linux FFmpeg is LGPL (OpenH264, no
// libx264), and `docs/linux-dev-loop.md` points VIDEORC_SMOKE_FFMPEG_PATH at
// it, so a hardcoded `-c:v libx264` failed every fixture there.
const FIXTURE_H264_ENCODERS = [
  ['libx264', ['-c:v', 'libx264', '-preset', 'ultrafast']],
  ['libopenh264', ['-c:v', 'libopenh264', '-b:v', '4M']],
  ['h264_videotoolbox', ['-c:v', 'h264_videotoolbox', '-b:v', '4M']]
]

export function fixtureH264EncoderArgsFor(encodersOutput) {
  const names = new Set(
    String(encodersOutput)
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean)
  )
  return FIXTURE_H264_ENCODERS.find(([name]) => names.has(name))?.[1] ?? null
}

export function fixtureH264EncoderArgs(
  ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
) {
  let output = ''
  try {
    output =
      spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 })
        .stdout ?? ''
  } catch {
    output = ''
  }
  return fixtureH264EncoderArgsFor(output) ?? ['-c:v', 'libx264', '-preset', 'ultrafast']
}
