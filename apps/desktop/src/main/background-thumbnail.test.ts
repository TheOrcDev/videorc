import { describe, expect, it } from 'vitest'

import {
  backgroundThumbnailFileName,
  backgroundThumbnailSize,
  writeBackgroundThumbnail
} from './background-thumbnail'

describe('background thumbnails (plan 174 C-40)', () => {
  it('scales to 480 px wide and never enlarges', () => {
    expect(backgroundThumbnailSize({ width: 3840, height: 2160 })).toEqual({
      width: 480,
      height: 270
    })
    expect(backgroundThumbnailSize({ width: 320, height: 180 })).toEqual({
      width: 320,
      height: 180
    })
    expect(backgroundThumbnailSize({ width: 0, height: 0 })).toBeNull()
  })

  it('keeps a PNG a PNG and names the file out of the managed-asset scans', () => {
    expect(backgroundThumbnailFileName('abc', '/x/Sky.PNG')).toBe('abc.thumb.png')
    expect(backgroundThumbnailFileName('abc', '/x/sky.webp')).toBe('abc.thumb.jpg')
  })

  it('writes the resized image, or nothing when it cannot decode', () => {
    const writes: string[] = []
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 1920, height: 1080 }),
      resize: (size: { width: number; height: number }) => {
        expect(size).toMatchObject({ width: 480, height: 270 })
        return image
      },
      toPNG: () => Buffer.from('png'),
      toJPEG: () => Buffer.from('jpg')
    }
    expect(
      writeBackgroundThumbnail({
        id: 'abc',
        sourcePath: '/x/sky.jpg',
        directory: '/assets',
        image,
        write: (path, bytes) => writes.push(`${path}:${bytes.toString()}`)
      })
    ).toBe('abc.thumb.jpg')
    expect(writes).toEqual(['/assets/abc.thumb.jpg:jpg'])
    expect(
      writeBackgroundThumbnail({
        id: 'abc',
        sourcePath: '/x/sky.webp',
        directory: '/assets',
        image: { ...image, isEmpty: () => true },
        write: () => writes.push('unexpected')
      })
    ).toBeNull()
  })
})
