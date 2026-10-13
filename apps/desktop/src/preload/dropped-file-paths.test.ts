import { describe, expect, it, vi } from 'vitest'

import { SCREEN_IMAGE_BATCH_MAX, SCREEN_IMAGE_REFUSALS } from '../shared/screen-image-files'
import { droppedFilePaths } from './dropped-file-paths'

const pathForFile = (file: File): string => `/dropped/${file.name}`

describe('droppedFilePaths', () => {
  it('asks pathForFile for every dropped file, in order', () => {
    const files = [new File([''], 'a.png'), new File([''], 'b.webp')]
    expect(droppedFilePaths(files, pathForFile)).toEqual(['/dropped/a.png', '/dropped/b.webp'])
  })

  it('refuses a drop with no files, like a promised file from Mail', () => {
    expect(() => droppedFilePaths([], pathForFile)).toThrow(SCREEN_IMAGE_REFUSALS.notImages)
  })

  it('never lets a forged array-like object supply its own paths', () => {
    const forged = { length: 1, map: () => ['/Users/me/secret.png'] }
    const spy = vi.fn(pathForFile)
    expect(() => droppedFilePaths(forged, spy)).toThrow(SCREEN_IMAGE_REFUSALS.notImages)
    expect(spy).not.toHaveBeenCalled()
  })

  it('ignores a map method planted on a real array', () => {
    const files = Object.assign([new File([''], 'a.png')], {
      map: () => ['/Users/me/secret.png']
    })
    expect(droppedFilePaths(files, pathForFile)).toEqual(['/dropped/a.png'])
  })

  it('refuses a file with no path on disk, like an image dragged from a browser', () => {
    const files = [new File([''], 'a.png'), new File([''], 'from-browser.png')]
    const pathOnDisk = (file: File): string => (file.name === 'a.png' ? '/dropped/a.png' : '')
    expect(() => droppedFilePaths(files, pathOnDisk)).toThrow(SCREEN_IMAGE_REFUSALS.notImages)
  })

  it('refuses more files than one batch allows', () => {
    const files = Array.from(
      { length: SCREEN_IMAGE_BATCH_MAX + 1 },
      (_, i) => new File([''], `${i}.png`)
    )
    expect(() => droppedFilePaths(files, pathForFile)).toThrow(SCREEN_IMAGE_REFUSALS.tooMany)
  })
})
