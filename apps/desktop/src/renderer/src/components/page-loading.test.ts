import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PageLoading, pageLoadingLabel } from './page-loading'
import {
  STUDIO_PANELS,
  WORKSPACE_TABS,
  workspaceTabLabel,
  type WorkspaceTab
} from './workspace-nav'

// #1084: Livestream, Assets and Buddy said "Opening Videorc…" while their
// chunk loaded, inside an app that was already open.

const EVERY_PAGE: WorkspaceTab[] = [
  ...WORKSPACE_TABS.map((tab) => tab.id),
  ...STUDIO_PANELS.map((panel) => panel.id)
]

describe('PageLoading', () => {
  it('names the page that is loading once the app is open', () => {
    const markup = renderToStaticMarkup(createElement(PageLoading, { tab: 'live', opening: false }))

    expect(markup).toContain('Loading Livestream…')
    expect(markup).not.toContain('Opening Videorc')
    expect(markup).toContain('role="status"')
  })

  it('never says the app is opening for a page after the first', () => {
    for (const tab of EVERY_PAGE) {
      expect(pageLoadingLabel(tab, false)).toBe(`Loading ${workspaceTabLabel(tab)}…`)
    }
    expect(pageLoadingLabel('assets', false)).toBe('Loading Assets…')
    expect(pageLoadingLabel('ai', false)).toBe('Loading Buddy…')
  })

  it('keeps the boot copy for the window opening', () => {
    expect(pageLoadingLabel('studio', true)).toBe('Opening Videorc…')
  })

  it('holds its words a beat, so a chunk that is in at once never flashes them', () => {
    const markup = renderToStaticMarkup(
      createElement(PageLoading, { tab: 'assets', opening: false })
    )

    expect(markup).toMatch(/\bdelay-300\b/)
    expect(markup).toMatch(/\bfill-mode-backwards\b/)
    expect(markup).toMatch(/\bfade-in\b/)
  })
})
