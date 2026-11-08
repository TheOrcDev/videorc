import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LinkMadeCards, linkMadeTitle } from '@/components/stream-manager/link-made-cards'
import type { CohostLinkMade } from '@/lib/backend'

const link: CohostLinkMade = {
  personId: 'p-ada',
  names: ['Ada', 'ada_dev'],
  platforms: ['twitch', 'youtube'],
  accountKey: 'youtube:UCada',
  at: '2026-11-08T18:03:00.000Z'
}

describe('the Linked … Undo card (plan 225 C3, D4 b)', () => {
  it('names both accounts and offers Undo first, then Keep', () => {
    expect(linkMadeTitle(link)).toBe('Linked Ada (Twitch) and ada_dev (YouTube)')
    const markup = renderToStaticMarkup(
      createElement(LinkMadeCards, {
        links: [link],
        busyId: null,
        onUndo: () => undefined,
        onKeep: () => undefined
      })
    )
    expect(markup).toContain('Linked Ada (Twitch) and ada_dev (YouTube)')
    expect(markup.indexOf('link-made-undo')).toBeLessThan(markup.indexOf('link-made-keep'))
    expect(markup).not.toContain('Post')
  })

  it('renders nothing without a link', () => {
    expect(
      renderToStaticMarkup(
        createElement(LinkMadeCards, {
          links: [],
          busyId: null,
          onUndo: () => undefined,
          onKeep: () => undefined
        })
      )
    ).toBe('')
  })
})
