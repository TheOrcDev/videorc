import { describe, expect, it } from 'vitest'

import {
  SIDEBAR_ZONES,
  WORKSPACE_SHORTCUTS,
  pageShortcutFor,
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
import { pageKeyAccelerator } from '../../../shared/sidebar-pages'

// Plan 174 S0.6 (A-8): the macOS menu is built from workspace-nav and
// SHORTCUTS. Main cannot import them, so shared/app-menu-items.ts mirrors
// them, and this test holds the mirror equal.

function tabFor(key: string): WorkspaceTab {
  const tab = WORKSPACE_SHORTCUTS.find((entry) => entry.key === key)?.tab
  if (!tab) throw new Error(`No page on key ${key}`)
  return tab
}

const MENU_PAGES = APP_MENU_PAGE_GROUPS.flat()

describe('the application menu mirrors workspace-nav', () => {
  it('names every page key once, as the sidebar does (Settings is Settings…)', () => {
    expect(MENU_PAGES.map((page) => page.key).sort()).toEqual(
      WORKSPACE_SHORTCUTS.map((entry) => entry.key)
        .filter((key) => key !== ',')
        .sort()
    )
    for (const page of MENU_PAGES) {
      expect(page.label, page.key).toBe(workspaceTabLabel(tabFor(page.key)))
    }
  })

  it('keeps sidebar order and its blocks: Studio, Setup, Livestream, Assets, then Library', () => {
    const order = MENU_PAGES.map((page) => sidebarOrderFor(tabFor(page.key)))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(MENU_PAGES.map((page) => page.key)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'G',
      'S',
      '0'
    ])
    expect(APP_MENU_PAGE_GROUPS.map((group) => group.map((page) => tabFor(page.key)))).toEqual([
      ...SIDEBAR_ZONES.filter((zone) => zone.id !== 'system').map((zone) => zone.pages),
      ['library']
    ])
  })

  it('opens Settings on the ⌘, the shell maps', () => {
    expect(tabFor(',')).toBe('settings')
  })

  it('prints each menu page on the accelerator the sidebar shows', () => {
    for (const page of MENU_PAGES) {
      expect(pageKeyAccelerator(page.key), page.label).toBe(pageShortcutFor(tabFor(page.key)))
    }
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

  it('lists the page keys SHORTCUTS documents', () => {
    for (const page of MENU_PAGES) {
      const entry = SHORTCUTS.find(
        (shortcut) =>
          shortcut.group === 'Navigation' &&
          shortcut.accelerators[0] === pageKeyAccelerator(page.key)
      )
      expect(entry?.label, page.key).toBe(page.label)
    }
  })
})

describe('Help → Release Notes', () => {
  it('opens the page the What’s New dialog links to', () => {
    expect(appMenuReleaseNotesUrl('0.9.140')).toBe(releaseNotesUrl('0.9.140'))
  })
})
