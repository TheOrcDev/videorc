// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GroupedList, ListRow } from './list-row'
import { ConfigGrid, PageHeader } from './page'
import { Pane, PaneBody, Toolbar } from './pane'
import { PanelSection } from './panel-section'
import { StatusBar, StatusBarHint } from './status-bar'

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
    expect(markup).toContain('text-[13px] leading-5 font-semibold')
    expect(markup).toContain('text-xs text-muted-foreground')
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
          createElement(StatusBarHint, { keys: '⌘K', label: 'Search', onClick })
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
