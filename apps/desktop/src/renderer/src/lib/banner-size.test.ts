import { describe, expect, it } from 'vitest'

import type { OverlayRect } from '@/lib/backend'

import { bannerSizeAdvice } from './banner-size'

// Plan 186 D8 (b): "Size for this place" in the Scene inspector.

/** The default horizontal place of a 6:1 wide banner: 60 % wide, bottom centre. */
const WIDE_HORIZONTAL: OverlayRect = { x: 0.2, y: 0.782222, w: 0.6, h: 0.177778 }
const FULL_WIDTH_VERTICAL: OverlayRect = { x: 0, y: 0.4, w: 1, h: 0.1 }
const SMALL_HORIZONTAL: OverlayRect = { x: 0.3, y: 0.1, w: 0.4, h: 0.1 }

const HD = { width: 1920, height: 1080 }
const UHD = { width: 3840, height: 2160 }
const VERTICAL_HD = { width: 1080, height: 1920 }

const banner = (
  width: number,
  height: number,
  horizontal: OverlayRect = WIDE_HORIZONTAL,
  vertical: OverlayRect = FULL_WIDTH_VERTICAL
) => ({ width, height, horizontal, vertical })

describe('bannerSizeAdvice', () => {
  it('says a 2400 × 400 strip is sharp on a 1080p recording', () => {
    expect(bannerSizeAdvice({ banner: banner(2400, 400), output: HD })).toStrictEqual({
      canvas: { noun: 'recording', ...HD },
      needed: { width: 1152, height: 192 },
      sharp: true,
      sizeLine: 'Size on your 1920 × 1080 recording: 1152 × 192 px',
      verdictLine: 'Your image is 2400 × 400 px: sharp at this size.'
    })
  })

  it('says an 800 × 133 strip is soft at 1080p, with the size to use', () => {
    const advice = bannerSizeAdvice({ banner: banner(800, 133), output: HD })
    expect(advice.sharp).toBe(false)
    expect(advice.sizeLine).toBe('Size on your 1920 × 1080 recording: 1152 × 192 px')
    expect(advice.verdictLine).toBe(
      'Your image is 800 × 133 px: it will look soft at this size. Use one at least 1152 × 192 px.'
    )
  })

  it('pins the plan sentences at 4K, rounding the draw size up to even pixels', () => {
    // 800 × 133 draws 2304 × 383 in this rect: 383 rounds up to 384.
    const soft = bannerSizeAdvice({ banner: banner(800, 133), output: UHD })
    expect(soft.needed).toStrictEqual({ width: 2304, height: 384 })
    expect(soft.sizeLine).toBe('Size on your 3840 × 2160 recording: 2304 × 384 px')
    expect(soft.verdictLine).toBe(
      'Your image is 800 × 133 px: it will look soft at this size. Use one at least 2304 × 384 px.'
    )
    const sharp = bannerSizeAdvice({ banner: banner(2400, 400), output: UHD })
    expect(sharp.sharp).toBe(true)
    expect(sharp.sizeLine).toBe('Size on your 3840 × 2160 recording: 2304 × 384 px')
    expect(sharp.verdictLine).toBe('Your image is 2400 × 400 px: sharp at this size.')
  })

  it('allows an upscale of up to 10 %', () => {
    // Exactly 6:1, so both draw 2304 × 384; 90 % of 2304 is 2073.6.
    expect(bannerSizeAdvice({ banner: banner(2076, 346), output: UHD })).toMatchObject({
      needed: { width: 2304, height: 384 },
      sharp: true
    })
    expect(bannerSizeAdvice({ banner: banner(2070, 345), output: UHD })).toMatchObject({
      needed: { width: 2304, height: 384 },
      sharp: false
    })
  })

  it('names the vertical stream when it draws the banner largest', () => {
    const wide = banner(2400, 400, SMALL_HORIZONTAL, FULL_WIDTH_VERTICAL)
    // Horizontal: 648 × 108 on 1080p. Vertical stream: 1080 × 180.
    expect(bannerSizeAdvice({ banner: wide, output: HD })).toMatchObject({
      needed: { width: 648, height: 108 },
      sizeLine: 'Size on your 1920 × 1080 recording: 648 × 108 px'
    })
    const advice = bannerSizeAdvice({ banner: wide, output: HD, verticalStream: VERTICAL_HD })
    expect(advice.canvas).toStrictEqual({ noun: 'vertical stream', ...VERTICAL_HD })
    expect(advice.sizeLine).toBe('Size on your 1080 × 1920 vertical stream: 1080 × 180 px')
    expect(advice.sharp).toBe(true)
    expect(
      bannerSizeAdvice({
        banner: banner(800, 133, SMALL_HORIZONTAL, FULL_WIDTH_VERTICAL),
        output: HD,
        verticalStream: VERTICAL_HD
      }).verdictLine
    ).toBe(
      'Your image is 800 × 133 px: it will look soft at this size. Use one at least 1080 × 180 px.'
    )
  })

  it('keeps the recording when it draws the banner larger than the vertical stream', () => {
    const advice = bannerSizeAdvice({
      banner: banner(2400, 400),
      output: UHD,
      verticalStream: VERTICAL_HD
    })
    expect(advice.canvas.noun).toBe('recording')
    expect(advice.needed).toStrictEqual({ width: 2304, height: 384 })
  })

  it('places a vertical program with the vertical rect', () => {
    const advice = bannerSizeAdvice({ banner: banner(2400, 400), output: VERTICAL_HD })
    expect(advice.canvas).toStrictEqual({ noun: 'recording', ...VERTICAL_HD })
    expect(advice.needed).toStrictEqual({ width: 1080, height: 180 })
  })
})
