import { describe, expect, it, vi } from 'vitest'

import { SCREEN_IMAGE_REFUSALS } from '../shared/screen-image-files'
import { assertDroppedScreenImagePaths, issueAllOrNone } from './screen-image-drop'

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

describe('issueAllOrNone', () => {
  const noRevoke = async (): Promise<void> => undefined

  it('issues one capability at a time, in order', async () => {
    const steps: string[] = []
    const issued = await issueAllOrNone(
      ['a', 'b'],
      async (path) => {
        steps.push(`start ${path}`)
        await Promise.resolve()
        steps.push(`end ${path}`)
        return `capability-${path}`
      },
      noRevoke
    )
    expect(issued).toEqual(['capability-a', 'capability-b'])
    expect(steps).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('revokes every capability it issued when a later one fails, then rethrows', async () => {
    const failure = new Error('The backend is restarting.')
    const revoke = vi.fn(async (capability: string) => {
      if (capability === 'capability-a') throw new Error('Revoke failed too.')
    })
    await expect(
      issueAllOrNone(
        ['a', 'b', 'c'],
        async (path) => {
          if (path === 'c') throw failure
          return `capability-${path}`
        },
        revoke
      )
    ).rejects.toBe(failure)
    expect(revoke.mock.calls).toEqual([['capability-a'], ['capability-b']])
  })
})
