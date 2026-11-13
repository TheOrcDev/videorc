// Windows audio app smokes need the capture worker (issue #1088). Without
// `ffmpeg-capture.exe` beside the bundled FFmpeg, FFmpeg opens the
// microphone itself through DirectShow and the session has no audio bus: a
// soundboard press is never on air (`sessionWithoutSounds`) and System audio
// cannot join the mix. That is the dev checkout's setup, not the product, so
// the smokes refuse up front with the fix instead of failing a case.
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

import { bundledFfmpegPath } from './recording-studio-gates.mjs'

export function windowsCaptureWorkerPath(ffmpegPath) {
  return win32.join(win32.dirname(ffmpegPath), 'ffmpeg-capture.exe')
}

/** The reason the session bus cannot run, or null when it can. */
export function missingWindowsCaptureWorker({
  platform = process.platform,
  repoRoot,
  fileExists = existsSync
} = {}) {
  if (platform !== 'win32') return null
  const worker = windowsCaptureWorkerPath(bundledFfmpegPath({ repoRoot, platform }))
  if (fileExists(worker)) return null
  return `${worker} is missing, so FFmpeg would open the microphone itself and the session would have no audio bus (no soundboard on air, no System audio). Build it with \`pnpm ffmpeg:build:capture:windows\` (MSYS2 UCRT64), or copy ffmpeg-capture.exe from an installed Videorc's resources\\ffmpeg\\bin.`
}
