import { describe, expect, it } from 'vitest'

import { overlaySnapRect } from '@/lib/overlay-layout'
import { bannerDrawRect } from '../../../shared/banner-geometry'

import {
  BANNER_LANDSCAPE_EDGE_MARGIN,
  BANNER_LANDSCAPE_SIDE_MARGIN,
  BANNER_PORTRAIT_BOTTOM_MARGIN,
  BANNER_PORTRAIT_SIDE_MARGIN,
  BANNER_PORTRAIT_TOP_MARGIN,
  BANNER_SNAPS,
  BANNER_SNAP_LABELS,
  bannerFitRect,
  bannerSnapRect
} from './banner-place'

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
const WIDE = { width: 2400, height: 400 }
const LOGO = { width: 512, height: 512 }

describe('banner margins', () => {
  it('mirror the overlay snaps on both orientations', () => {
    const landscape = overlaySnapRect('highlight', 'horizontal', 'top-left')
    expect(round6(BANNER_LANDSCAPE_SIDE_MARGIN)).toBe(landscape.x)
    expect(BANNER_LANDSCAPE_EDGE_MARGIN).toBe(landscape.y)
    const landscapeBottom = overlaySnapRect('highlight', 'horizontal', 'bottom-left')
    expect(round6(1 - landscapeBottom.y - landscapeBottom.h)).toBe(BANNER_LANDSCAPE_EDGE_MARGIN)
    const portrait = overlaySnapRect('highlight', 'vertical', 'top-left')
    expect(round6(BANNER_PORTRAIT_SIDE_MARGIN)).toBe(portrait.x)
    expect(BANNER_PORTRAIT_TOP_MARGIN).toBe(portrait.y)
    const portraitBottom = overlaySnapRect('highlight', 'vertical', 'bottom-left')
    expect(round6(1 - portraitBottom.y - portraitBottom.h)).toBe(BANNER_PORTRAIT_BOTTOM_MARGIN)
  })
})

describe('bannerFitRect', () => {
  it('hugs the image inside a place with spare room, by the place gravity', () => {
    // A 6:1 strip in the full canvas: full width, at the bottom (the centre is
    // in the lower half), 1/6 × 16/9 of the height.
    expect(bannerFitRect(WIDE, { x: 0, y: 0, w: 1, h: 1 }, 16 / 9)).toStrictEqual({
      x: 0,
      y: round6(1 - 16 / 9 / 6),
      w: 1,
      h: round6(16 / 9 / 6)
    })
    // A square logo in a wide top-right place keeps its height, hugs the right.
    expect(bannerFitRect(LOGO, { x: 0.5, y: 0.04, w: 0.48, h: 0.2 }, 16 / 9)).toStrictEqual({
      x: round6(0.98 - (0.2 * 9) / 16),
      y: 0.04,
      w: round6((0.2 * 9) / 16),
      h: 0.2
    })
  })

  it('matches where every render path draws the picture', () => {
    const place = { x: 0.1, y: 0.6, w: 0.5, h: 0.3 }
    const fit = bannerFitRect(WIDE, place, 1920 / 1080)
    const drawn = bannerDrawRect(WIDE.width, WIDE.height, 1920, 1080, place)
    expect(Math.abs(fit.x * 1920 - drawn.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(fit.y * 1080 - drawn.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(fit.w * 1920 - drawn.w)).toBeLessThanOrEqual(1)
    expect(Math.abs(fit.h * 1080 - drawn.h)).toBeLessThanOrEqual(1)
  })

  it('leaves a place that already fits the image where it is', () => {
    const fitted = { x: 0.2, y: 0.782222, w: 0.6, h: 0.177778 }
    expect(bannerFitRect(WIDE, fitted, 16 / 9)).toStrictEqual(fitted)
  })
})

describe('bannerSnapRect', () => {
  it('names the seven places in order', () => {
    expect(BANNER_SNAPS.map((snap) => BANNER_SNAP_LABELS[snap])).toStrictEqual([
      'Top left',
      'Top center',
      'Top right',
      'Bottom left',
      'Bottom center',
      'Bottom right',
      'Full frame'
    ])
  })

  it('keeps the size and moves it inside the landscape margins', () => {
    const place = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }
    const size = { w: round6((0.4 * 9) / 16), h: 0.4 }
    expect(bannerSnapRect(LOGO, place, 'horizontal', 16 / 9, 'top-left')).toStrictEqual({
      x: round6(BANNER_LANDSCAPE_SIDE_MARGIN),
      y: 0.04,
      ...size
    })
    expect(bannerSnapRect(LOGO, place, 'horizontal', 16 / 9, 'top-center')).toStrictEqual({
      x: round6((1 - size.w) / 2),
      y: 0.04,
      ...size
    })
    expect(bannerSnapRect(LOGO, place, 'horizontal', 16 / 9, 'bottom-right')).toStrictEqual({
      x: round6(1 - BANNER_LANDSCAPE_SIDE_MARGIN - size.w),
      y: 0.56,
      ...size
    })
  })

  it('keeps the portrait safe area on the vertical canvas', () => {
    const place = { x: 0.1, y: 0.4, w: 0.8, h: 0.1 }
    // 6:1 in a 9:16 canvas: the width fills, the height is 0.8 × 9/16 / 6.
    const h = round6((0.8 * 9) / 16 / 6)
    expect(bannerSnapRect(WIDE, place, 'vertical', 9 / 16, 'top-right')).toStrictEqual({
      x: round6(1 - BANNER_PORTRAIT_SIDE_MARGIN - 0.8),
      y: 0.08,
      w: 0.8,
      h
    })
    expect(bannerSnapRect(WIDE, place, 'vertical', 9 / 16, 'bottom-center')).toStrictEqual({
      x: 0.1,
      y: round6(1 - 0.22 - h),
      w: 0.8,
      h
    })
  })

  it('fills the canvas on Full frame, and snaps back to the image from it', () => {
    expect(
      bannerSnapRect(LOGO, { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, 'horizontal', 16 / 9, 'full-frame')
    ).toStrictEqual({ x: 0, y: 0, w: 1, h: 1 })
    // From a full frame, a strip keeps its full width and moves to the top.
    expect(
      bannerSnapRect(WIDE, { x: 0, y: 0, w: 1, h: 1 }, 'horizontal', 16 / 9, 'top-left')
    ).toStrictEqual({ x: 0, y: 0.04, w: 1, h: round6(16 / 9 / 6) })
  })
})
