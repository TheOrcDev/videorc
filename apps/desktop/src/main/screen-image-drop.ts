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

export async function issueAllOrNone<Capability>(
  paths: readonly string[],
  issue: (path: string) => Promise<Capability>,
  revoke: (capability: Capability) => Promise<unknown>
): Promise<Capability[]> {
  const issued: Capability[] = []
  try {
    for (const path of paths) issued.push(await issue(path))
    return issued
  } catch (error) {
    const revoked = await Promise.allSettled(issued.map((capability) => revoke(capability)))
    for (const result of revoked) {
      if (result.status === 'rejected') {
        console.warn('[takeovers] could not revoke a capability', result.reason)
      }
    }
    throw error
  }
}

export function missingAsNotAFile(error: NodeJS.ErrnoException): null {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
  throw error
}
