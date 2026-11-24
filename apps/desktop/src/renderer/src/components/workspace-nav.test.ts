import { describe, expect, it } from 'vitest'

import { AccountIcon, AvatarPageIcon, BuddyPageRowIcon } from './icons'
import {
  SIDEBAR_ZONES,
  STUDIO_PANELS,
  WORKSPACE_SHORTCUTS,
  WORKSPACE_TABS,
  isStudioPanel,
  isWorkspaceTab,
  pageShortcutFor,
  sidebarOrderFor,
  workspacePageMeta,
  workspaceTabLabel,
  workspaceWindowTitle,
  type WorkspaceTab
} from './workspace-nav'

// Captions is a first-class Setup page at ⌘5. Settings keeps ⌘,, while Health
// intentionally has no navigation key and stays reachable via ⌘K. These invariants
// guard the IA so a later edit can't silently drop a page,
// duplicate a shortcut, or rename a legacy trigger id that smokes/deep-links depend on.
describe('workspace navigation', () => {
  // Owner 2026-11-20: the old Assets page is Images (id and trigger id kept,
  // so openStudioPanel('assets'), smokes and deep links still land on it), and
  // its sounds moved to a Sounds page of their own.
  it('keeps Images on the old Assets id and adds Sounds as a panel', () => {
    expect(STUDIO_PANELS.map((panel) => panel.id)).toEqual([
      'sources',
      'layouts',
      'assets',
      'sounds',
      'captions',
      'recording',
      'live'
    ])
    expect(STUDIO_PANELS.find((panel) => panel.id === 'assets')).toMatchObject({
      label: 'Images',
      legacyTabId: 'assets'
    })
    expect(STUDIO_PANELS.find((panel) => panel.id === 'sounds')).toMatchObject({
      label: 'Sounds',
      legacyTabId: 'sounds'
    })
    expect(workspaceWindowTitle('sounds')).toBe('Sounds – Videorc')
  })

  it('keeps legacy trigger ids stable for existing Setup panels', () => {
    const legacyById = Object.fromEntries(
      STUDIO_PANELS.map((panel) => [panel.id, panel.legacyTabId])
    )
    expect(legacyById).toMatchObject({
      sources: 'sources',
      layouts: 'layout',
      live: 'streaming',
      captions: 'captions',
      recording: 'recording'
    })
  })

  // Owner 2026-11-20: ⌘1–⌘9 run down the nine rows above the Assets group,
  // Guests included, with no gap; Images ⇧⌘G, Sounds ⇧⌘S, Library ⌘0,
  // Settings ⌘,. The map itself lives in shared/sidebar-pages.
  it('maps ⌘1–⌘9 down the top rows, ⇧⌘G Images, ⇧⌘S Sounds, ⌘0 Library, ⌘, Settings', () => {
    expect(WORKSPACE_SHORTCUTS.map((entry) => [entry.key, entry.tab])).toEqual([
      ['1', 'studio'],
      ['2', 'sources'],
      ['3', 'layouts'],
      ['4', 'captions'],
      ['5', 'recording'],
      ['6', 'live'],
      ['7', 'guests'],
      ['8', 'avatar'],
      ['9', 'ai'],
      ['G', 'assets'],
      ['S', 'sounds'],
      ['0', 'library'],
      [',', 'settings']
    ])
    const rows = SIDEBAR_ZONES.flatMap((zone) => zone.pages)
    const digits = WORKSPACE_SHORTCUTS.filter((entry) => /^[1-9]$/.test(entry.key))
    expect(digits.map((entry) => entry.tab)).toEqual(rows.slice(0, 9))
    expect(pageShortcutFor('guests')).toBe('CmdOrCtrl+7')
    expect(pageShortcutFor('ai')).toBe('CmdOrCtrl+9')
    expect(pageShortcutFor('assets')).toBe('CmdOrCtrl+Shift+G')
    expect(pageShortcutFor('sounds')).toBe('CmdOrCtrl+Shift+S')
    expect(pageShortcutFor('library')).toBe('CmdOrCtrl+0')
  })

  it('puts Settings on ⌘, and never duplicates a key', () => {
    expect(pageShortcutFor('settings')).toBe('CmdOrCtrl+,')
    const keys = WORKSPACE_SHORTCUTS.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    const tabs = WORKSPACE_SHORTCUTS.map((entry) => entry.tab)
    expect(new Set(tabs).size).toBe(tabs.length)
  })

  it('gives every reachable page a key except Health (⌘K-only)', () => {
    const reachable: WorkspaceTab[] = [
      ...WORKSPACE_TABS.map((tab) => tab.id),
      ...STUDIO_PANELS.map((panel) => panel.id)
    ]
    for (const tab of reachable) {
      if (tab === 'diagnostics') {
        expect(pageShortcutFor(tab), `${tab} should have no key`).toBeUndefined()
      } else {
        expect(pageShortcutFor(tab), `${tab} needs a shortcut`).toBeDefined()
      }
    }
    expect(WORKSPACE_SHORTCUTS).toHaveLength(reachable.length - 1)
  })

  // Plan 235 D6: Destinations (the page that was Livestream) and Sidekick
  // share the labelled Livestream group, under Setup. Ids, legacy trigger ids
  // and deep links stay: Sidekick is `ai`, Destinations is `live`
  // (`streaming`). Plan 239 made the avatar a page; the owner moved it from
  // Setup to Livestream (2026-11-19), just above Sidekick.
  it('groups Destinations, Guests, Avatar and Sidekick under Livestream, Images and Sounds under Assets, Library and Settings at the bottom', () => {
    expect(SIDEBAR_ZONES.map((zone) => [zone.id, zone.label ?? null, zone.pages])).toEqual([
      ['stage', null, ['studio']],
      ['setup', 'Setup', ['sources', 'layouts', 'captions', 'recording']],
      ['livestream', 'Livestream', ['live', 'guests', 'avatar', 'ai']],
      ['assets', 'Assets', ['assets', 'sounds']],
      ['system', null, ['library', 'settings']]
    ])
    expect(workspaceTabLabel('live')).toBe('Destinations')
    expect(STUDIO_PANELS.find((panel) => panel.id === 'live')?.legacyTabId).toBe('streaming')
    expect(isStudioPanel('live')).toBe(true)
    // Plan 235 D7: a plain glyph, named for the page.
    expect(WORKSPACE_TABS.find((tab) => tab.id === 'ai')).toEqual({
      id: 'ai',
      label: 'Sidekick',
      icon: BuddyPageRowIcon
    })
    expect(pageShortcutFor('ai')).toBe('CmdOrCtrl+9')
    expect(workspaceTabLabel('ai')).toBe('Sidekick')
    // 0.31.1: the talk show's room is its own page, beside Destinations.
    expect(WORKSPACE_TABS.find((tab) => tab.id === 'guests')).toEqual({
      id: 'guests',
      label: 'Guests',
      icon: AccountIcon
    })
    expect(isStudioPanel('guests')).toBe(false)
    expect(pageShortcutFor('guests')).toBe('CmdOrCtrl+7')
    expect(workspaceWindowTitle('guests')).toBe('Guests – Videorc')
    // Plan 239: a full page with a plain glyph of its own, never a Setup panel.
    expect(WORKSPACE_TABS.find((tab) => tab.id === 'avatar')).toEqual({
      id: 'avatar',
      label: 'Avatar',
      icon: AvatarPageIcon
    })
    expect(isStudioPanel('avatar')).toBe(false)
    expect(isWorkspaceTab('avatar')).toBe(true)
    expect(pageShortcutFor('avatar')).toBe('CmdOrCtrl+8')
    expect(workspaceTabLabel('avatar')).toBe('Avatar')
    expect(workspaceWindowTitle('avatar')).toBe('Avatar – Videorc')
  })

  it('names each sidebar page once, and every page but Health has a row', () => {
    const rows = SIDEBAR_ZONES.flatMap((zone) => zone.pages)
    expect(new Set(rows).size).toBe(rows.length)
    const pages = [...WORKSPACE_TABS.map((tab) => tab.id), ...STUDIO_PANELS.map((p) => p.id)]
    expect([...rows].sort()).toEqual(pages.filter((tab) => tab !== 'diagnostics').sort())
    expect(workspacePageMeta('live')).toMatchObject({ label: 'Destinations' })
  })

  it('cascades the shortcut chips down the sidebar, top to bottom', () => {
    const rows: WorkspaceTab[] = [
      'studio',
      'sources',
      'layouts',
      'captions',
      'recording',
      'live',
      'guests',
      'avatar',
      'ai',
      'assets',
      'sounds',
      'library',
      'settings'
    ]
    expect(rows.map((tab) => sidebarOrderFor(tab))).toEqual(rows.map((_, index) => index))
    // Health has no sidebar row.
    expect(sidebarOrderFor('diagnostics')).toBe(0)
  })

  // Plan 174 S3.21 (A-18): the window is named after its page, with no em
  // dash (the copy rules).
  it('titles the window after the page', () => {
    expect(workspaceWindowTitle('studio')).toBe('Studio – Videorc')
    expect(workspaceWindowTitle('recording')).toBe('Output – Videorc')
    expect(workspaceWindowTitle('live')).toBe('Destinations – Videorc')
    expect(workspaceWindowTitle('diagnostics')).toBe('Health – Videorc')
    expect(workspaceWindowTitle('ai')).not.toContain('—')
  })

  it('classifies Images, Sounds and Captions as Studio panels and labels them', () => {
    expect(isStudioPanel('assets')).toBe(true)
    expect(isStudioPanel('studio')).toBe(false)
    expect(isWorkspaceTab('assets')).toBe(true)
    expect(isStudioPanel('captions')).toBe(true)
    expect(workspaceTabLabel('captions')).toBe('Captions')
    expect(isWorkspaceTab('library')).toBe(true)
    expect(isWorkspaceTab('missing')).toBe(false)
    expect(workspaceTabLabel('assets')).toBe('Images')
    expect(isStudioPanel('sounds')).toBe(true)
    expect(workspaceTabLabel('sounds')).toBe('Sounds')
  })
})
