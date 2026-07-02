import { describe, expect, it } from 'vitest'

import {
  captionBarMetrics,
  layoutCaptionBar,
  MAX_CAPTION_BAR_LINES,
  wrapCaptionText,
  type TextMeasurer
} from './caption-overlay'

// Deterministic measurer: every character is 0.55em wide (SF-ish average).
const measure: TextMeasurer = (text, fontPx) => text.length * fontPx * 0.55

describe('captionBarMetrics', () => {
  it('scales the font with output width and the size knob, with a floor', () => {
    const m1080 = captionBarMetrics(1920, 'm')
    expect(m1080.fontPx).toBe(51)
    expect(captionBarMetrics(1920, 'l').fontPx).toBe(63)
    expect(captionBarMetrics(1920, 's').fontPx).toBe(40)
    // Tiny canvases never go below the readable floor.
    expect(captionBarMetrics(320, 's').fontPx).toBe(24)
  })
})

describe('wrapCaptionText', () => {
  const metrics = captionBarMetrics(1920, 'm')

  it('keeps short lines whole and wraps long ones by words', () => {
    expect(wrapCaptionText('Hello viewers', metrics, measure)).toEqual(['Hello viewers'])
    const wrapped = wrapCaptionText(
      'this is a longer caption line that certainly cannot fit on one single line of the bar',
      metrics,
      measure
    )
    expect(wrapped.length).toBeLessThanOrEqual(MAX_CAPTION_BAR_LINES)
    expect(wrapped.join(' ').replace('…', '')).toContain('bar')
  })

  it('keeps the TAIL when text exceeds two lines, with a leading ellipsis', () => {
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ')
    const wrapped = wrapCaptionText(long, metrics, measure)
    expect(wrapped).toHaveLength(MAX_CAPTION_BAR_LINES)
    expect(wrapped[0]?.startsWith('…')).toBe(true)
    expect(wrapped.at(-1)?.endsWith('word59')).toBe(true)
  })

  it('returns no lines for blank text', () => {
    expect(wrapCaptionText('   ', metrics, measure)).toEqual([])
  })
})

describe('layoutCaptionBar', () => {
  it('sizes the bar to its widest line plus padding, capped at 92% of canvas', () => {
    const layout = layoutCaptionBar({
      text: 'Hello viewers',
      canvasWidth: 1920,
      textSize: 'm',
      measure
    })
    expect(layout).not.toBeNull()
    const metrics = captionBarMetrics(1920, 'm')
    expect(layout!.barWidthPx).toBe(
      Math.ceil(measure('Hello viewers', metrics.fontPx)) + metrics.paddingXPx * 2
    )
    expect(layout!.barHeightPx).toBe(metrics.paddingYPx * 2 + metrics.lineHeightPx)

    const wide = layoutCaptionBar({
      text: Array.from({ length: 40 }, () => 'wide').join(' '),
      canvasWidth: 1920,
      textSize: 'm',
      measure
    })
    expect(wide!.barWidthPx).toBeLessThanOrEqual(Math.floor(1920 * 0.92))
  })

  it('returns null for empty text', () => {
    expect(
      layoutCaptionBar({ text: '', canvasWidth: 1920, textSize: 'm', measure })
    ).toBeNull()
  })
})
