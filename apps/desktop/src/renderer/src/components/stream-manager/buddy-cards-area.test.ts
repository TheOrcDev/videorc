// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BuddyCardsArea, freshBuddyCardLabels } from './buddy-cards-area'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(cards: { id: string; label: string }[], active = true): Promise<void> {
  await act(async () =>
    root.render(
      createElement(BuddyCardsArea, { active, cards }, createElement('div', null, 'cards'))
    )
  )
}

const announcement = (): string =>
  container.querySelector('[data-slot="buddy-cards-announcement"]')?.textContent ?? ''

describe('BuddyCardsArea (plan 174 S3.14c, H-20, H-21)', () => {
  it('names only the cards not announced yet', () => {
    const seen = new Set(['a'])
    expect(
      freshBuddyCardLabels(seen, [
        { id: 'a', label: 'old' },
        { id: 'b', label: 'new' }
      ])
    ).toEqual(['new'])
  })

  it('announces each card once, politely, and counts the cards waiting', async () => {
    await render([{ id: 'r-1', label: "Buddy asks before removing Ada's message, 18s left" }])
    const region = container.querySelector('[data-slot="buddy-cards-announcement"]')
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.getAttribute('role')).toBe('status')
    expect(announcement()).toBe("Buddy asks before removing Ada's message, 18s left")
    expect(container.querySelector('[data-slot="buddy-cards-waiting"]')).toBeNull()
    // The same card again says nothing new; a second card is announced alone.
    await render([
      { id: 'r-1', label: "Buddy asks before removing Ada's message, 17s left" },
      { id: 'u-1', label: 'Grum wants to post' }
    ])
    expect(announcement()).toBe('Grum wants to post')
    expect(container.querySelector('[data-slot="buddy-cards-waiting"]')?.textContent).toBe(
      '2 waiting'
    )
    // The cards scroll inside a capped viewport, never past the questions.
    expect(container.querySelector('[data-slot="scroll-area-viewport"]')?.className).toContain(
      'max-h-64'
    )
  })

  it('renders nothing while there is nothing to show', async () => {
    await render([], false)
    expect(container.innerHTML).toBe('')
  })
})
