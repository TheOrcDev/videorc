import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { OverlayRect } from './backend'
import {
  bannerDrawRect,
  bannerOrientationForCanvas,
  bannerRectForCanvas,
  overlayRectBottomGravity,
  overlayRectHorizontalGravity,
  overlayRectPixels,
  type BannerPixelRect
} from './banner-geometry'

interface BannerGeometryCase {
  name: string
  image: { width: number; height: number }
  canvas: { width: number; height: number }
  rect: OverlayRect
  expected: BannerPixelRect
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/banner-geometry.json', import.meta.url),
    'utf8'
  )
) as { schemaVersion: number; cases: BannerGeometryCase[] }

describe('banner geometry (plan 186)', () => {
  it('reproduces every shared fixture case exactly', () => {
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.cases.length).toBeGreaterThanOrEqual(9)
    for (const testCase of fixture.cases) {
      expect(
        bannerDrawRect(
          testCase.image.width,
          testCase.image.height,
          testCase.canvas.width,
          testCase.canvas.height,
          testCase.rect
        ),
        testCase.name
      ).toStrictEqual(testCase.expected)
    }
  })

  it('mirrors OverlayRect::pixels: rounded, clamped and never inverted', () => {
    expect(overlayRectPixels({ x: 0.2, y: 0.782222, w: 0.6, h: 0.177778 }, 1920, 1080)).toEqual([
      384, 845, 1536, 1037
    ])
    expect(overlayRectPixels({ x: -0.1, y: 0.9, w: 0.5, h: 0.5 }, 100, 100)).toEqual([
      0, 90, 40, 100
    ])
    expect(overlayRectPixels({ x: 1.2, y: 0, w: 0.1, h: 0 }, 100, 100)).toEqual([100, 0, 100, 0])
  })

  it('picks the horizontal gravity by the rect centre with the 0.02 band', () => {
    expect(overlayRectHorizontalGravity({ x: 0, y: 0, w: 0.97, h: 0.1 })).toBe('center')
    expect(overlayRectHorizontalGravity({ x: 0, y: 0, w: 0.96, h: 0.1 })).toBe('center')
    expect(overlayRectHorizontalGravity({ x: 0, y: 0, w: 0.959, h: 0.1 })).toBe('left')
    expect(overlayRectHorizontalGravity({ x: 0.1, y: 0, w: 0.85, h: 0.1 })).toBe('right')
    expect(overlayRectBottomGravity({ x: 0, y: 0.4, w: 0.1, h: 0.2 })).toBe(true)
    expect(overlayRectBottomGravity({ x: 0, y: 0.39, w: 0.1, h: 0.2 })).toBe(false)
  })

  it('stays inside the canvas for a degenerate rect and a tiny canvas', () => {
    const tiny = bannerDrawRect(512, 512, 1, 1, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    expect(tiny).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const corner = bannerDrawRect(4000, 10, 1920, 1080, { x: 0.98, y: 0, w: 0.02, h: 0.02 })
    expect(corner.x + corner.w).toBeLessThanOrEqual(1920)
    expect(corner.w).toBe(38)
    expect(corner.h).toBe(1)
  })

  it('takes the vertical rect only on a canvas taller than wide', () => {
    const banner = {
      horizontal: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      vertical: { x: 0.3, y: 0.3, w: 0.4, h: 0.1 }
    }
    expect(bannerOrientationForCanvas(1080, 1920)).toBe('vertical')
    expect(bannerOrientationForCanvas(1920, 1080)).toBe('horizontal')
    expect(bannerOrientationForCanvas(1080, 1080)).toBe('horizontal')
    expect(bannerRectForCanvas(banner, 1080, 1920)).toBe(banner.vertical)
    expect(bannerRectForCanvas(banner, 1280, 720)).toBe(banner.horizontal)
  })
})
