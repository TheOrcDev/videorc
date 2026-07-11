import { describe, expect, it } from 'vitest'

import {
  CAPTION_STYLE_DEFINITIONS,
  CAPTION_STYLE_IDS,
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
    expect(m1080.fontPx).toBe(48)
    expect(captionBarMetrics(1920, 'l').fontPx).toBe(60)
    expect(captionBarMetrics(1920, 's').fontPx).toBe(38)
    // Tiny canvases never go below the readable floor.
    expect(captionBarMetrics(320, 's').fontPx).toBe(24)
  })
})

describe('caption style registry', () => {
  it('ships the four named presets from the product contract', () => {
    expect(CAPTION_STYLE_IDS).toEqual(['classic', 'glass', 'lower-third', 'high-contrast'])
    expect(CAPTION_STYLE_DEFINITIONS.classic.plate).toBe('none')
    expect(CAPTION_STYLE_DEFINITIONS.glass.plate).toBe('glass')
    expect(CAPTION_STYLE_DEFINITIONS['lower-third'].align).toBe('left')
    expect(CAPTION_STYLE_DEFINITIONS['high-contrast'].backgroundColor).toBe('#050506')
  })

  it('gives lower third a wide band while keeping other styles content-sized', () => {
    const lowerThird = layoutCaptionBar({
      text: 'Hello',
      canvasWidth: 1920,
      textSize: 'm',
      styleId: 'lower-third',
      measure
    })
    const classic = layoutCaptionBar({
      text: 'Hello',
      canvasWidth: 1920,
      textSize: 'm',
      styleId: 'classic',
      measure
    })
    expect(lowerThird?.barWidthPx).toBe(Math.floor(1920 * 0.92))
    expect(classic!.barWidthPx).toBeLessThan(lowerThird!.barWidthPx)
  })

  it.each(CAPTION_STYLE_IDS)('lays out %s at horizontal and vertical output widths', (styleId) => {
    for (const canvasWidth of [1080, 1920, 3840]) {
      const layout = layoutCaptionBar({
        text: 'Captions remain readable across every output shape.',
        canvasWidth,
        textSize: 'm',
        styleId,
        measure
      })
      expect(layout).not.toBeNull()
      expect(layout!.barWidthPx).toBeLessThanOrEqual(canvasWidth)
      expect(layout!.lines.length).toBeLessThanOrEqual(MAX_CAPTION_BAR_LINES)
    }
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
    expect(layoutCaptionBar({ text: '', canvasWidth: 1920, textSize: 'm', measure })).toBeNull()
  })
})

describe('captionBarFramePosition', () => {
  it('anchors the bar with the 4% safe margin, top or bottom, centered', async () => {
    const { captionBarFramePosition } = await import('./caption-overlay')
    const bottom = captionBarFramePosition({
      canvasWidth: 1920,
      canvasHeight: 1080,
      barWidthPx: 800,
      barHeightPx: 120,
      position: 'bottom'
    })
    expect(bottom).toEqual({ x: 560, y: 1080 - 120 - Math.round(1080 * 0.04) })
    const top = captionBarFramePosition({
      canvasWidth: 1920,
      canvasHeight: 1080,
      barWidthPx: 800,
      barHeightPx: 120,
      position: 'top'
    })
    expect(top).toEqual({ x: 560, y: Math.round(1080 * 0.04) })
  })
})
