// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PageTabs } from './page-tabs'
import { TabsContent } from './ui/tabs'

// Plan 174 S1.6b (A-14, D-29): one pinned strip for every page with tabs.

const TABS = [
  { id: 'setup', label: 'Setup' },
  { id: 'upcoming', label: 'Upcoming' }
] as const

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(value: 'setup' | 'upcoming', onValueChange = vi.fn()): typeof onValueChange {
  act(() =>
    root.render(
      createElement(PageTabs<'setup' | 'upcoming'>, {
        label: 'Livestream view',
        tabs: TABS,
        testId: 'livestream-tabs',
        triggerAttribute: 'data-videorc-livestream-view',
        value,
        onValueChange,
        children: [
          createElement(TabsContent, { key: 'setup', value: 'setup' }, 'Destinations'),
          createElement(TabsContent, { key: 'upcoming', value: 'upcoming' }, 'Scheduled')
        ]
      })
    )
  )
  return onValueChange
}

describe('PageTabs', () => {
  it('owns the page scroll: the strip is pinned and only the region under it scrolls', () => {
    render('setup')
    const tabs = container.querySelector('[data-testid=livestream-tabs]')
    expect(tabs?.getAttribute('data-pane-scroll')).toBe('own')
    const strip = tabs?.querySelector('[data-slot=pane-strip]')
    const scroll = tabs?.querySelector('[data-slot=page-tabs-scroll]')
    expect(strip?.querySelector('[role=tablist]')?.getAttribute('aria-label')).toBe(
      'Livestream view'
    )
    expect(scroll?.className).toContain('overflow-y-auto')
    expect(scroll?.textContent).toBe('Destinations')
    // The strip comes first and never sits inside the scroll region.
    expect(scroll?.contains(strip ?? null)).toBe(false)
  })

  it('names each trigger by its tab id, so probes and links can find a tab', () => {
    render('upcoming')
    const triggers = [...container.querySelectorAll('[data-videorc-livestream-view]')]
    expect(triggers.map((trigger) => trigger.getAttribute('data-videorc-livestream-view'))).toEqual(
      ['setup', 'upcoming']
    )
    expect(
      container.querySelector('[data-videorc-livestream-view][data-state=active]')?.textContent
    ).toBe('Upcoming')
  })

  it('reports the typed tab the streamer picks; the caller keeps it', () => {
    const onValueChange = render('setup')
    const upcoming = container.querySelector<HTMLElement>('[data-videorc-livestream-view=upcoming]')
    act(() => {
      upcoming?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    expect(onValueChange).toHaveBeenCalledWith('upcoming')
  })
})
