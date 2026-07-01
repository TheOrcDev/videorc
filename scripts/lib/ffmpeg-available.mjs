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
