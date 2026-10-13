import { SCREEN_IMAGE_BATCH_MAX, SCREEN_IMAGE_REFUSALS } from '../shared/screen-image-files'

/**
 * Page script hands preload whatever it likes, including an object with its
 * own `map`. Only a real array, walked by index, keeps every path coming
 * from `pathForFile`. A File with no path on disk (say, dragged from a
 * browser) is refused here, before IPC.
 */
export function droppedFilePaths(files: unknown, pathForFile: (file: File) => string): string[] {
  if (!Array.isArray(files)) {
    throw new Error(SCREEN_IMAGE_REFUSALS.notImages)
  }
  if (files.length > SCREEN_IMAGE_BATCH_MAX) {
    throw new Error(SCREEN_IMAGE_REFUSALS.tooMany)
  }
  const paths: string[] = []
  for (let index = 0; index < files.length; index += 1) {
    const path = pathForFile(files[index] as File)
    if (!path) {
      throw new Error(SCREEN_IMAGE_REFUSALS.notImages)
    }
    paths.push(path)
  }
  return paths
}
