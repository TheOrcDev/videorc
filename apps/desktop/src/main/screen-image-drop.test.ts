import { describe, expect, it } from 'vitest'

import { SCREEN_IMAGE_REFUSALS } from '../shared/screen-image-files'
import { assertDroppedScreenImagePaths } from './screen-image-drop'

const anyPathIsAFile = async (): Promise<boolean> => true

describe('assertDroppedScreenImagePaths', () => {
  it('accepts absolute paths to PNG, JPEG and WebP files', async () => {
    const paths = ['/Users/me/a.png', '/Users/me/b.JPEG', '/Users/me/c.jpg', '/Users/me/d.webp']
    await expect(assertDroppedScreenImagePaths(paths, anyPathIsAFile)).resolves.toBeUndefined()
  })

  it.each([
    ['an empty path (a File made by page script)', ''],
    ['a relative path', 'a.png'],
    ['another file type', '/Users/me/notes.txt'],
    ['a dotfile with no extension', '/Users/me/.png']
  ])('refuses the whole drop for %s, even when it is a file', async (_case, path) => {
    await expect(
      assertDroppedScreenImagePaths(['/Users/me/a.png', path], anyPathIsAFile)
    ).rejects.toThrow(SCREEN_IMAGE_REFUSALS.notImages)
  })

  it('refuses a folder or missing path named like an image', async () => {
    const onlyAIsAFile = async (path: string): Promise<boolean> => path === '/Users/me/a.png'
    await expect(
      assertDroppedScreenImagePaths(['/Users/me/a.png', '/Users/me/folder.png'], onlyAIsAFile)
    ).rejects.toThrow(SCREEN_IMAGE_REFUSALS.notImages)
  })
})
