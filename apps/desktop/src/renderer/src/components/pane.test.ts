// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GroupedList, ListRow } from './list-row'
import { ConfigGrid, PageHeader } from './page'
import { PANE_OWNS_SCROLL, Pane, PaneBody, PaneStrip, Toolbar, WINDOW_TITLE_CLASS } from './pane'
import { PanelSection } from './panel-section'
import { STATUS_BAR_ACTION_CLASS, StatusBar, StatusBarHint } from './status-bar'
import { StatusBarAction } from './status-bar-action'

// Plan 050, D4: panes, toolbars, flush sections, grouped lists, status bar.

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

describe('Toolbar', () => {
  it('carries only the page title: no buttons in its top-right corner', () => {
    // Owner call, 2026-09-23: actions live with the content they act on.
    act(() =>
      root.render(
        createElement(
          Pane,
          null,
          createElement(Toolbar, { title: 'Library' }),
          createElement(PaneBody, null, createElement('button', { type: 'button' }, 'Import'))
        )
      )
    )
    const toolbar = container.querySelector('[data-slot=toolbar]')
    expect(toolbar?.querySelector('h1')?.textContent).toBe('Library')
    expect(toolbar?.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-slot=pane-body] button')?.textContent).toBe('Import')
  })

  it('makes the toolbar a 40 px drag region', () => {
    const markup = renderToStaticMarkup(createElement(Toolbar, { title: 'Studio' }))
    expect(markup).toContain('h-toolbar')
    expect(markup).toContain('[-webkit-app-region:drag]')
  })

  it('scrolls only the pane body, unless the body owns its scroll', () => {
    expect(renderToStaticMarkup(createElement(PaneBody, null, 'x'))).toContain('overflow-y-auto')
    const owned = renderToStaticMarkup(createElement(PaneBody, { scroll: false, children: 'x' }))
    expect(owned).not.toContain('overflow-y-auto')
    expect(owned).toContain('flex-col')
  })

  it('stops scrolling for a page whose root owns its scroll, with no list of pages (A-14)', () => {
    // Plan 174 S1.6b: the page says so on its root; the shell keeps no ids.
    expect(PANE_OWNS_SCROLL).toEqual({ 'data-pane-scroll': 'own' })
    const markup = renderToStaticMarkup(createElement(PaneBody, null, 'x'))
    for (const rule of ['flex', 'flex-col', 'overflow-y-hidden']) {
      expect(markup).toContain(`has-[&gt;[data-pane-scroll=own]]:${rule}`)
    }
  })

  it('titles the toolbar with the one window title recipe: 14 px / 600', () => {
    expect(WINDOW_TITLE_CLASS).toContain('text-sm font-semibold text-foreground')
    const markup = renderToStaticMarkup(createElement(Toolbar, { title: 'Studio' }))
    // Focusable by script only (plan 174 S3.21, A-18): the shell moves the
    // focus here after keyboard navigation.
    expect(markup).toContain(
      `<h1 class="${WINDOW_TITLE_CLASS} outline-none" tabindex="-1">Studio</h1>`
    )
  })
})

describe('PaneStrip', () => {
  it('pins a strip under the toolbar: a hairline below, the gutter at the sides', () => {
    const markup = renderToStaticMarkup(
      createElement(PaneStrip, { className: 'flex gap-2', children: 'filters' })
    )
    expect(markup).toContain('data-slot="pane-strip"')
    for (const token of ['shrink-0', 'border-b', 'border-border', 'px-gutter', 'py-2', 'gap-2']) {
      expect(markup).toContain(token)
    }
  })
})

describe('flush sections', () => {
  it('renders PanelSection flush: no card chrome, a 13 px / 600 header, a hairline', () => {
    const markup = renderToStaticMarkup(
      createElement(PanelSection, {
        title: 'Recording',
        description: 'Where files go.',
        children: 'x'
      })
    )
    for (const card of ['rounded-panel', 'shadow-soft', 'bg-card', 'glass-shine']) {
      expect(markup).not.toContain(card)
    }
    expect(markup).toContain('border-b')
    expect(markup).toContain('p-gutter')
    // The type tokens (plan 174 S1.6a): 13 / 600 header, 12 px description,
    // and the header is an h2 under the toolbar's h1 (A-24).
    expect(markup).toContain('text-section font-semibold')
    expect(markup).toContain('text-meta text-muted-foreground')
    expect(markup).toMatch(/<h2[^>]*>Recording<\/h2>/)
  })

  it('splits the two ConfigGrid columns with a hairline', () => {
    const markup = renderToStaticMarkup(createElement(ConfigGrid, null, 'a'))
    expect(markup).toContain('lg:grid-cols-2')
    expect(markup).toContain('lg:[&amp;&gt;*:nth-child(odd)]:border-r')
  })

  it('keeps the PageHeader title for assistive tech and its action in its own row', () => {
    const markup = renderToStaticMarkup(
      createElement(PageHeader, {
        title: 'Library',
        description: 'Every recording becomes a session.',
        action: createElement('button', null, 'New recording')
      })
    )
    expect(markup).toContain('<h2 class="sr-only">Library</h2>')
    expect(markup).toContain('Every recording becomes a session.')
    expect(markup).toContain('<button>New recording</button>')
  })
})

describe('lists', () => {
  it('sizes rows at 32 px, or 28 px when compact', () => {
    expect(renderToStaticMarkup(createElement(ListRow, { title: 'Camera' }))).toContain('h-row')
    expect(
      renderToStaticMarkup(createElement(ListRow, { title: 'Camera', compact: true }))
    ).toContain('h-row-compact')
  })

  it('groups like things in one inset list split by hairlines', () => {
    const markup = renderToStaticMarkup(
      createElement(GroupedList, {
        label: 'Devices',
        children: [
          createElement(ListRow, { key: 'camera', title: 'Camera' }),
          createElement(ListRow, { key: 'mic', title: 'Mic' })
        ]
      })
    )
    expect(markup).toContain('data-slot="grouped-list"')
    expect(markup).toContain('divide-y divide-border')
    expect(markup).toContain('>Devices<')
    // Rows inside a group are flush; the group owns the radius.
    expect(markup).toContain('in-data-[slot=grouped-list]:rounded-none')
  })
})

describe('StatusBar', () => {
  it('is 26 px with quiet, clickable hints', () => {
    const onClick = vi.fn()
    act(() =>
      root.render(
        createElement(
          StatusBar,
          { leading: createElement('span', null, 'Connected') },
          createElement(StatusBarHint, {
            accelerator: 'CmdOrCtrl+K',
            platform: 'darwin',
            label: 'Search',
            onClick
          })
        )
      )
    )
    const bar = container.querySelector('[data-slot=status-bar]')
    expect(bar?.className).toContain('h-status-bar')
    expect(bar?.textContent).toContain('Connected')
    const hint = container.querySelector<HTMLButtonElement>('[data-slot=status-bar-hint]')
    expect(hint?.textContent).toBe('⌘KSearch')
    act(() => hint?.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('StatusBarAction', () => {
  it('names an icon-only action for assistive tech and on hover (H-PAT)', () => {
    const onClick = vi.fn()
    act(() =>
      root.render(
        createElement(StatusBarAction, {
          icon: createElement('svg', { 'aria-hidden': true }),
          label: 'Open Preview',
          onClick
        })
      )
    )
    const action = container.querySelector<HTMLButtonElement>('[data-slot=status-bar-action]')
    expect(action?.getAttribute('aria-label')).toBe('Open Preview')
    // Named on hover by a tooltip, never a native title (plan 174 S1.10).
    expect(action?.hasAttribute('title')).toBe(false)
    expect(action?.getAttribute('data-state')).toBe('closed')
    expect(action?.getAttribute('type')).toBe('button')
    expect(action?.className).toContain(STATUS_BAR_ACTION_CLASS)
    act(() => action?.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('shows a word when it has one, keeps the full name, and marks a toggle that is on', () => {
    const markup = renderToStaticMarkup(
      createElement(StatusBarAction, {
        label: 'Clear view',
        text: 'Clear',
        hint: 'Clear view (keeps Library history)',
        pressed: true
      })
    )
    expect(markup).toContain('aria-label="Clear view"')
    expect(markup).toContain('aria-pressed="true"')
    // The hint is the tooltip and the description, never a title (S1.10).
    expect(markup).toContain('aria-description="Clear view (keeps Library history)"')
    expect(markup).not.toContain('title=')
    expect(markup).toContain('>Clear</button>')
  })

  it('shares one look with the shortcut hints', () => {
    for (const token of ['h-5', 'text-[11px]', 'text-subtle', 'hover:bg-accent']) {
      expect(STATUS_BAR_ACTION_CLASS).toContain(token)
    }
    act(() =>
      root.render(
        createElement(StatusBarHint, {
          accelerator: 'CmdOrCtrl+K',
          label: 'Search',
          onClick: () => {}
        })
      )
    )
    const hint = container.querySelector('[data-slot=status-bar-hint]')
    expect(hint?.className).toBe(STATUS_BAR_ACTION_CLASS)
  })
})
