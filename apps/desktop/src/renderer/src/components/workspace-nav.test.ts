import { describe, expect, it } from 'vitest'

import { AvatarPageIcon, BuddyPageIcon } from './icons'
import {
  SIDEBAR_ZONES,
  STUDIO_PANELS,
  WORKSPACE_SHORTCUTS,
  WORKSPACE_TABS,
  isStudioPanel,
  isWorkspaceTab,
  shortcutDigitFor,
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
  it('registers Assets as a Setup panel between Scene and Captions', () => {
    expect(STUDIO_PANELS.map((panel) => panel.id)).toEqual([
      'sources',
      'layouts',
      'assets',
      'captions',
      'recording',
      'live'
    ])

    const assets = STUDIO_PANELS.find((panel) => panel.id === 'assets')
    expect(assets?.label).toBe('Assets')
    expect(assets?.legacyTabId).toBe('assets')
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

  // Plan 235 D8: the digits run down the sidebar, ⌘1 to ⌘9; plan 239 D6:
  // Avatar takes ⌘6 and Library, the tenth page, ⌘0.
  it('maps the pages in sidebar order (Captions ⌘5, Avatar ⌘6, Destinations ⌘8, Library ⌘0, Settings ⌘,)', () => {
    expect(WORKSPACE_SHORTCUTS.map((entry) => [entry.digit, entry.tab])).toEqual([
      ['1', 'studio'],
      ['2', 'sources'],
      ['3', 'layouts'],
      ['4', 'assets'],
      ['5', 'captions'],
      ['6', 'avatar'],
      ['7', 'recording'],
      ['8', 'live'],
      ['9', 'ai'],
      ['0', 'library'],
      [',', 'settings']
    ])
    const digits = WORKSPACE_SHORTCUTS.filter((entry) => entry.digit !== ',')
    expect(digits.map((entry) => sidebarOrderFor(entry.tab))).toEqual(
      digits.map((_, index) => index)
    )
  })

  it('puts Settings on ⌘, and never duplicates a key', () => {
    expect(shortcutDigitFor('settings')).toBe(',')
    expect(WORKSPACE_SHORTCUTS.filter((entry) => entry.tab === 'settings')).toHaveLength(1)

    const keys = WORKSPACE_SHORTCUTS.map((entry) => entry.digit)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every reachable page a digit except Health (⌘K-only)', () => {
    const noDigit: WorkspaceTab[] = ['diagnostics']
    const reachable: WorkspaceTab[] = [
      ...WORKSPACE_TABS.map((tab) => tab.id),
      ...STUDIO_PANELS.map((panel) => panel.id)
    ]
    for (const tab of reachable) {
      if (noDigit.includes(tab)) {
        expect(shortcutDigitFor(tab), `${tab} should have no digit`).toBeUndefined()
      } else {
        expect(shortcutDigitFor(tab), `${tab} needs a shortcut`).toBeDefined()
      }
    }
    expect(WORKSPACE_SHORTCUTS).toHaveLength(reachable.length - noDigit.length)
  })

  // Plan 235 D6: Destinations (the page that was Livestream) and Sidekick
  // share the labelled Livestream group, under Setup. Ids, legacy trigger ids
  // and deep links stay: Sidekick is `ai`, Destinations is `live`
  // (`streaming`). Plan 239: the avatar is part of the picture, so its page
  // sits in Setup, before Output.
  it('groups Destinations and Sidekick under Livestream, between Setup and Library, and Avatar in Setup', () => {
    expect(SIDEBAR_ZONES.map((zone) => [zone.id, zone.label ?? null, zone.pages])).toEqual([
      ['stage', null, ['studio']],
      ['setup', 'Setup', ['sources', 'layouts', 'assets', 'captions', 'avatar', 'recording']],
      ['livestream', 'Livestream', ['live', 'ai']],
      ['library', null, ['library']],
      ['system', null, ['settings']]
    ])
    expect(workspaceTabLabel('live')).toBe('Destinations')
    expect(STUDIO_PANELS.find((panel) => panel.id === 'live')?.legacyTabId).toBe('streaming')
    expect(isStudioPanel('live')).toBe(true)
    // Plan 235 D7: a plain glyph, named for the page.
    expect(WORKSPACE_TABS.find((tab) => tab.id === 'ai')).toEqual({
      id: 'ai',
      label: 'Sidekick',
      icon: BuddyPageIcon
    })
    expect(shortcutDigitFor('ai')).toBe('9')
    expect(workspaceTabLabel('ai')).toBe('Sidekick')
    // Plan 239: a full page with a plain glyph of its own, never a Setup panel.
    expect(WORKSPACE_TABS.find((tab) => tab.id === 'avatar')).toEqual({
      id: 'avatar',
      label: 'Avatar',
      icon: AvatarPageIcon
    })
    expect(isStudioPanel('avatar')).toBe(false)
    expect(isWorkspaceTab('avatar')).toBe(true)
    expect(shortcutDigitFor('avatar')).toBe('6')
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
      'assets',
      'captions',
      'avatar',
      'recording',
      'live',
      'ai',
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

  it('classifies Assets and Captions as Studio panels and labels them', () => {
    expect(isStudioPanel('assets')).toBe(true)
    expect(isStudioPanel('studio')).toBe(false)
    expect(isWorkspaceTab('assets')).toBe(true)
    expect(isStudioPanel('captions')).toBe(true)
    expect(workspaceTabLabel('captions')).toBe('Captions')
    expect(isWorkspaceTab('library')).toBe(true)
    expect(isWorkspaceTab('missing')).toBe(false)
    expect(workspaceTabLabel('assets')).toBe('Assets')
  })
})
