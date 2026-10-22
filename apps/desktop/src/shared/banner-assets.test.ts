import { describe, expect, it } from 'vitest'

import { bannerAssetUrl, isBannerFileName } from './banner-assets'

describe('banner asset URLs (plan 186)', () => {
  it('addresses the managed banner host by encoded basename only', () => {
    const id = '5c1e2b8a-7d3f-4e61-9a0b-2f4c6d8e1a3b'
    expect(bannerAssetUrl(`${id}.png`)).toBe(`videorc-asset://banner/${id}.png`)
    expect(bannerAssetUrl(`${id}.thumb.png`)).toBe(`videorc-asset://banner/${id}.thumb.png`)
    expect(bannerAssetUrl(`/Users/me/Library/Banners/${id}.png`)).toBe(
      `videorc-asset://banner/${id}.png`
    )
    expect(bannerAssetUrl(`C:\\Users\\me\\Banners\\${id}.png`)).toBe(
      `videorc-asset://banner/${id}.png`
    )
    expect(bannerAssetUrl('a b#c.png')).toBe('videorc-asset://banner/a%20b%23c.png')
  })

  it('accepts bare basenames and refuses paths, hops and hidden files', () => {
    expect(isBannerFileName('5c1e2b8a.png')).toBe(true)
    expect(isBannerFileName('5c1e2b8a.thumb.png')).toBe(true)
    for (const bad of ['', '.png', '../x.png', 'a/b.png', 'a\\b.png', 'a..png', 'x\0.png', 7]) {
      expect(isBannerFileName(bad)).toBe(false)
    }
    expect(isBannerFileName(`${'a'.repeat(252)}.png`)).toBe(false)
    expect(isBannerFileName(`${'a'.repeat(251)}.png`)).toBe(true)
  })
})
