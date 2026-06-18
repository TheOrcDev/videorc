import { describe, expect, it } from 'vitest'

import {
  BUNDLED_BACKGROUND_MANIFEST,
  backgroundAssetNameFromPath,
  isSupportedBackgroundFile,
  managedBackgroundFileName
} from './background-import'

describe('isSupportedBackgroundFile', () => {
  it('accepts png/jpg/jpeg/webp regardless of case', () => {
    expect(isSupportedBackgroundFile('/a/b/photo.png')).toBe(true)
    expect(isSupportedBackgroundFile('C:\\Users\\me\\Shot.JPG')).toBe(true)
    expect(isSupportedBackgroundFile('cover.jpeg')).toBe(true)
    expect(isSupportedBackgroundFile('art.WEBP')).toBe(true)
  })

  it('rejects unsupported, missing, or dotfile extensions', () => {
    expect(isSupportedBackgroundFile('clip.mp4')).toBe(false)
    expect(isSupportedBackgroundFile('archive.tar.gz')).toBe(false)
    expect(isSupportedBackgroundFile('noext')).toBe(false)
    expect(isSupportedBackgroundFile('.png')).toBe(false)
  })
})

describe('backgroundAssetNameFromPath', () => {
  it('uses the file name without directory or extension', () => {
    expect(backgroundAssetNameFromPath('/Users/me/Pictures/Sunset Ridge.png')).toBe('Sunset Ridge')
    expect(backgroundAssetNameFromPath('C:\\art\\Studio Wall.webp')).toBe('Studio Wall')
    expect(backgroundAssetNameFromPath('My.Photo.jpg')).toBe('My.Photo')
  })

  it('falls back to a default when the name is empty', () => {
    expect(backgroundAssetNameFromPath('')).toBe('Background')
    expect(backgroundAssetNameFromPath('/a/b/')).toBe('Background')
  })
})

describe('managedBackgroundFileName', () => {
  it('names the managed copy by id and normalized extension', () => {
    expect(managedBackgroundFileName('abc123', '/a/b.JPG')).toBe('abc123.jpg')
    expect(managedBackgroundFileName('abc123', 'photo.webp')).toBe('abc123.webp')
  })

  it('falls back to .png for an unsupported source extension', () => {
    expect(managedBackgroundFileName('abc123', 'weird.bmp')).toBe('abc123.png')
  })
})

describe('BUNDLED_BACKGROUND_MANIFEST', () => {
  it('declares the ten built-in backgrounds by stable asset id and webp file', () => {
    expect(BUNDLED_BACKGROUND_MANIFEST).toHaveLength(10)
    expect(BUNDLED_BACKGROUND_MANIFEST.map((asset) => asset.id)).toEqual([
      'builtin-bg-01',
      'builtin-bg-02',
      'builtin-bg-03',
      'builtin-bg-04',
      'builtin-bg-05',
      'builtin-bg-06',
      'builtin-bg-07',
      'builtin-bg-08',
      'builtin-bg-09',
      'builtin-bg-10'
    ])
    expect(BUNDLED_BACKGROUND_MANIFEST.every((asset) => asset.fileName.endsWith('.webp'))).toBe(
      true
    )
  })
})
