import { describe, expect, it } from 'vitest'

import {
  STUDIO_PANELS,
  WORKSPACE_SHORTCUTS,
  WORKSPACE_TABS,
  isStudioPanel,
  isWorkspaceTab,
  shortcutDigitFor,
  workspaceTabLabel,
  type WorkspaceTab
} from './workspace-nav'

// Captions is a first-class Setup page at ⌘6. Settings keeps ⌘,, while Health
// intentionally has no navigation key and stays reachable via ⌘K. These invariants
// guard the IA so a later edit can't silently drop a page,
// duplicate a shortcut, or rename a legacy trigger id that smokes/deep-links depend on.
describe('workspace navigation', () => {
  it('registers Assets as a Setup panel between Scene and Destinations', () => {
    expect(STUDIO_PANELS.map((panel) => panel.id)).toEqual([
      'sources',
      'layouts',
      'assets',
      'live',
      'captions',
      'recording'
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

  it('maps the workflow pages in sidebar order (Captions ⌘6, Settings ⌘,)', () => {
    expect(WORKSPACE_SHORTCUTS.map((entry) => [entry.digit, entry.tab])).toEqual([
      ['1', 'studio'],
      ['2', 'sources'],
      ['3', 'layouts'],
      ['4', 'assets'],
      ['5', 'live'],
      ['6', 'captions'],
      ['7', 'recording'],
      ['8', 'library'],
      ['9', 'ai'],
      [',', 'settings']
    ])
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
