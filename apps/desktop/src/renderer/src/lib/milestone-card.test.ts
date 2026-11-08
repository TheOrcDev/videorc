import { describe, expect, it } from 'vitest'

import { highlightMetrics, type HighlightTextMeasurer } from './comment-highlight'
import { layoutMilestoneCard } from './milestone-card'

// A flat measurer: every glyph is half the font size wide.
const measure: HighlightTextMeasurer = (text, fontPx) => Array.from(text).length * fontPx * 0.5

describe('the milestone card (plan 225 B6)', () => {
  it('lays out the avatar, the name, the milestone and the persona mark, never a message', () => {
    const layout = layoutMilestoneCard({
      name: 'Kim',
      label: '10th stream',
      personaName: 'Buddy',
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure
    })
    expect(layout).not.toBeNull()
    const card = layout!
    const metrics = highlightMetrics(1920, 1080)
    expect(card.name).toBe('Kim')
    expect(card.label).toBe('10th stream')
    expect(card.footer).toBe('with Buddy')
    expect(card.avatarPx).toBeGreaterThan(metrics.avatarPx)
    expect(card.labelFontPx).toBeGreaterThan(metrics.textFontPx)
    expect(card.footerFontPx).toBeLessThan(metrics.textFontPx)
    // The three rows sit inside the card, in order, with the avatar beside them.
    expect(card.textX).toBe(metrics.paddingPx + card.avatarPx + metrics.identityGapPx)
    expect(card.nameY).toBeLessThan(card.labelY)
    expect(card.labelY).toBeLessThan(card.footerY)
    expect(card.footerY).toBeLessThan(card.cardHeightPx)
    expect(card.cardHeightPx).toBeGreaterThanOrEqual(card.avatarPx + metrics.paddingPx * 2)
    expect(card.cardWidthPx).toBeLessThanOrEqual(1920 * 0.6)
    // The layout takes no message text: nothing of a chat row can reach it.
    expect(Object.keys(card)).not.toContain('text')
  })

  it('keeps the vertical leg as readable as the horizontal twin and fits the name', () => {
    const landscape = layoutMilestoneCard({
      name: 'Kim',
      label: '5 in a row',
      personaName: null,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure
    })!
    const portrait = layoutMilestoneCard({
      name: 'Kim',
      label: '5 in a row',
      personaName: null,
      canvasWidth: 1080,
      canvasHeight: 1920,
      measure
    })!
    expect(portrait.labelFontPx).toBe(landscape.labelFontPx)
    expect(portrait.footer).toBe('')
    expect(portrait.footerFontPx).toBeGreaterThan(0)
    // The placed rect caps the width; an over-long name is ellipsized.
    const narrow = layoutMilestoneCard({
      name: 'a_very_long_viewer_name_that_never_ends_at_all_really',
      label: 'One year',
      personaName: 'Grum',
      canvasWidth: 1920,
      canvasHeight: 1080,
      maxCardWidthPx: 420,
      measure
    })!
    expect(narrow.name.endsWith('…')).toBe(true)
    expect(narrow.cardWidthPx).toBeLessThanOrEqual(420 + narrow.metrics.paddingPx * 2)
    expect(
      layoutMilestoneCard({ name: 'Kim', label: '   ', canvasWidth: 1920, measure })
    ).toBeNull()
  })
})
