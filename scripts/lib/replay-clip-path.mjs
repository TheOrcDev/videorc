import * as nodePath from 'node:path'

// Where a saved replay clip must land: `<recordings>/Clips/<name>.mp4` inside
// the smoke's isolated state directory. Compared by path segments so the
// check holds with Windows' `\` as well as POSIX `/` (#1081).

/** True when `clipPath` is a file directly under a `recordings/Clips` folder inside `outputDirectory`. */
export function isClipUnderRecordingsClips(clipPath, outputDirectory, pathApi = nodePath) {
  const relativePath = pathApi.relative(outputDirectory, clipPath)
  if (!relativePath || relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) {
    return false
  }
  const segments = relativePath.split(pathApi.sep)
  return segments.length >= 3 && segments.at(-2) === 'Clips' && segments.at(-3) === 'recordings'
}

/** True when the clip is named `Clip YYYY-MM-DD HH-MM-SS.mp4`, with an optional ` (n)`. */
export function isReplayClipFileName(clipPath, pathApi = nodePath) {
  return /^Clip \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}( \(\d+\))?\.mp4$/.test(
    pathApi.basename(clipPath)
  )
}
