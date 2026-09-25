// Asserts the Linux packaging inputs exist before electron-builder runs
// (Plan 0008): the release backend and the pinned, policy-verified LGPL
// FFmpeg pair. fetch-ffmpeg-linux.mjs already executed the staged binary and
// checked its configure flags and encoder table; this only proves the files
// electron-builder.yml lists are really there, so a missing input fails
// here instead of as a silent gap in the AppImage.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputs = [
  join(repoRoot, 'target', 'release', 'videorc-backend'),
  join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg'),
  // The backend resolves ffprobe as a sibling of the bundled ffmpeg.
  join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffprobe'),
  join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'LICENSE.txt'),
  join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'SOURCE.txt'),
  join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'BUILD-CONFIG.txt')
]
if (process.platform !== 'linux') {
  throw new Error(`Linux packaging preflight must run on Linux, not ${process.platform}.`)
}
const missing = inputs.filter((path) => !existsSync(path))
if (missing.length > 0) {
  throw new Error(
    `Linux packaging inputs are missing:\n  ${missing.join('\n  ')}\nRun pnpm package:backend and pnpm ffmpeg:fetch:linux first.`
  )
}
console.log(`Linux packaging preflight OK (${inputs.length} inputs present).`)
