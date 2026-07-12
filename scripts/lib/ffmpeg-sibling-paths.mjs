import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * Derive the ffprobe binary beside an explicit ffmpeg binary without assuming
 * the current host's path syntax. This matters when CI validates Windows paths
 * on macOS/Linux and when packaged Windows paths contain backslashes.
 */
export function siblingFfprobePath(ffmpegPath) {
  if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) return null

  const pathApi = ffmpegPath.includes('\\') ? win32 : posix
  const binary = pathApi.basename(ffmpegPath)
  const normalizedBinary = binary.toLowerCase()
  if (normalizedBinary !== 'ffmpeg' && normalizedBinary !== 'ffmpeg.exe') return null

  const ffprobeBinary = normalizedBinary.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'
  const directory = pathApi.dirname(ffmpegPath)
  return directory === '.' ? ffprobeBinary : pathApi.join(directory, ffprobeBinary)
}

export function resolveExistingSiblingFfprobe(ffmpegPath, fileExists = existsSync) {
  const candidate = siblingFfprobePath(ffmpegPath)
  return candidate && fileExists(candidate) ? candidate : null
}
