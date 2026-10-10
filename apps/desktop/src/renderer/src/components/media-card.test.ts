import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MediaCard } from './media-card'

// Plan 174 S1.6b (J1-19): one card recipe for objects with a picture.

describe('MediaCard', () => {
  it('is the skill card: 8 px radius, a 4% fill, a hairline and no shadow', () => {
    const markup = renderToStaticMarkup(createElement(MediaCard, null, 'Scene'))
    expect(markup).toContain('data-slot="media-card"')
    for (const token of ['rounded-row', 'border-border', 'bg-foreground/[0.04]']) {
      expect(markup).toContain(token)
    }
    expect(markup).not.toMatch(/shadow|rounded-panel|bg-muted|bg-card/)
  })

  it('marks the one in use with the accent block, never a colour', () => {
    const markup = renderToStaticMarkup(createElement(MediaCard, { selected: true }, 'Scene'))
    expect(markup).toContain('data-selected="true"')
    expect(markup).toContain('border-foreground/25 bg-accent')
    expect(markup).not.toMatch(/primary|success|warning/)
  })

  it('puts the look on its child, so a card can be a button', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MediaCard,
        { asChild: true, interactive: true },
        createElement('button', { type: 'button' }, 'Screen + camera')
      )
    )
    expect(markup).toMatch(/^<button type="button" class="[^"]*rounded-row[^"]*hover:bg-accent/)
    expect(markup).toContain('data-slot="media-card"')
  })
})
