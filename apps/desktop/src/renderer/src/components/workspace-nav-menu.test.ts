import { describe, expect, it } from 'vitest'

import {
  STUDIO_PANELS,
  WORKSPACE_SHORTCUTS,
  WORKSPACE_TABS,
  sidebarOrderFor,
  workspaceTabLabel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import { SHORTCUTS } from '@/lib/shortcuts'
import { releaseNotesUrl } from '@/lib/videorc-web-links'

import {
  APP_MENU_PAGE_GROUPS,
  APP_MENU_WINDOWS,
  appMenuReleaseNotesUrl,
  type AppMenuWindowId
} from '../../../shared/app-menu-items'

// Plan 174 S0.6 (A-8): the macOS menu is built from workspace-nav and
// SHORTCUTS. Main cannot import them, so shared/app-menu-items.ts mirrors
// them, and this test holds the mirror equal.

function tabFor(key: string): WorkspaceTab {
  const tab = WORKSPACE_SHORTCUTS.find((entry) => entry.digit === key)?.tab
  if (!tab) throw new Error(`No page on ⌘${key}`)
  return tab
}

const MENU_PAGES = APP_MENU_PAGE_GROUPS.flat()

describe('the application menu mirrors workspace-nav', () => {
  it('names every ⌘1–⌘9 page once, as the sidebar does', () => {
    expect(MENU_PAGES.map((page) => page.key).sort()).toEqual(
      WORKSPACE_SHORTCUTS.map((entry) => entry.digit)
        .filter((digit) => digit !== ',')
        .sort()
    )
    for (const page of MENU_PAGES) {
      expect(page.label, `⌘${page.key}`).toBe(workspaceTabLabel(tabFor(page.key)))
    }
  })

  it('keeps sidebar order and its zones: the stage, Setup, then Library', () => {
    const order = MENU_PAGES.map((page) => sidebarOrderFor(tabFor(page.key)))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(APP_MENU_PAGE_GROUPS.map((group) => group.map((page) => tabFor(page.key)))).toEqual([
      WORKSPACE_TABS.filter((tab) => tab.group === 'stage').map((tab) => tab.id),
      STUDIO_PANELS.map((panel) => panel.id),
      WORKSPACE_TABS.filter((tab) => tab.group === 'library').map((tab) => tab.id)
    ])
  })

  it('opens Settings on the ⌘, the shell maps', () => {
    expect(tabFor(',')).toBe('settings')
  })
})

describe('the application menu mirrors SHORTCUTS', () => {
  const SHORTCUT_IDS: Record<AppMenuWindowId, string> = {
    preview: 'preview-window',
    notes: 'notes-window',
    'stream-manager': 'comments-window',
    captions: 'captions-window'
  }
  it('puts each window on the chord its shortcut uses', () => {
    for (const window of APP_MENU_WINDOWS) {
      const entry = SHORTCUTS.find((shortcut) => shortcut.id === SHORTCUT_IDS[window.id])
      expect(entry, window.id).toBeDefined()
      // Both sides are Electron accelerators (plan 174 S1.2): equal, not mapped.
      expect(window.accelerator, window.id).toBe(entry!.accelerators[0])
      // One name per window (plan 174 S2.3a, A-11): the menu and Settings →
      // Shortcuts say the same thing.
      expect(entry!.label, window.id).toBe(`Open ${window.label}`)
    }
  })

  it('lists the page digits SHORTCUTS documents', () => {
    for (const page of MENU_PAGES) {
      const entry = SHORTCUTS.find(
        (shortcut) =>
          shortcut.group === 'Navigation' && shortcut.accelerators[0] === `CmdOrCtrl+${page.key}`
      )
      expect(entry?.label, `⌘${page.key}`).toBe(page.label)
    }
  })
})

describe('Help → Release Notes', () => {
  it('opens the page the What’s New dialog links to', () => {
    expect(appMenuReleaseNotesUrl('0.9.140')).toBe(releaseNotesUrl('0.9.140'))
  })
})
