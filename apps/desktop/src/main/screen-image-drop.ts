import { extname, isAbsolute } from 'node:path'

import { SCREEN_IMAGE_EXTENSIONS, SCREEN_IMAGE_REFUSALS } from '../shared/screen-image-files'

export async function assertDroppedScreenImagePaths(
  paths: readonly string[],
  isFile: (path: string) => Promise<boolean>
): Promise<void> {
  for (const path of paths) {
    if (!isAbsolute(path) || !hasScreenImageExtension(path) || !(await isFile(path))) {
      throw new Error(SCREEN_IMAGE_REFUSALS.notImages)
    }
  }
}

function hasScreenImageExtension(path: string): boolean {
  const extension = extname(path).slice(1).toLowerCase()
  return (SCREEN_IMAGE_EXTENSIONS as readonly string[]).includes(extension)
}
