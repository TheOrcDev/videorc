import { describe, expect, it } from 'vitest'

import { WORKSPACE_SHORTCUTS } from '@/components/workspace-nav'

import { SHORTCUTS, navShortcutDigit, shortcutsByGroup } from './shortcuts'

describe('SHORTCUTS registry', () => {
  // ST4: the registry is the source of truth — the nav digit map must agree
  // with it exactly, or the Settings reference table lies.
  it('matches the workspace nav digit map one-to-one', () => {
    for (const { digit, tab } of WORKSPACE_SHORTCUTS) {
      expect(navShortcutDigit(tab), `nav-${tab}`).toBe(digit)
    }
    const navEntries = SHORTCUTS.filter((entry) =>
      entry.id.startsWith('nav-') && entry.id !== 'nav-settings'
        ? true
        : entry.id.startsWith('nav-')
    )
    expect(
      navEntries.filter(
        (entry) => /^[1-9]$/.test(entry.keys.at(-1) ?? '') || entry.keys.at(-1) === ','
      ).length
    ).toBe(WORKSPACE_SHORTCUTS.length)
  })

  it('has unique ids and non-empty key lists', () => {
    const ids = SHORTCUTS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of SHORTCUTS) {
      expect(entry.keys.length).toBeGreaterThan(0)
    }
  })

  it('groups cover Navigation, Session, Windows, Comments, and Appearance', () => {
    expect([...shortcutsByGroup().keys()]).toEqual([
      'Navigation',
      'Session',
      'Windows',
      'Comments',
      'Appearance'
    ])
  })

  // S2 (Live Chat Co-host): the pane advertises these chips, so the registry
  // must carry the exact keys the pane handles — a chord typed only into the
  // component is the bug this registry exists to prevent.
  it('registers the co-host pane keyboard map', () => {
    const cohost = SHORTCUTS.filter((entry) => entry.id.startsWith('cohost-'))
    expect(cohost.map((entry) => entry.id)).toEqual([
      'cohost-focus',
      'cohost-move',
      'cohost-reply',
      'cohost-highlight',
      'cohost-answered',
      'cohost-dismiss'
    ])
    expect(cohost.every((entry) => entry.group === 'Comments')).toBe(true)
    expect(cohost.find((entry) => entry.id === 'cohost-focus')?.keys).toEqual(['⌘', 'J'])
    expect(cohost.find((entry) => entry.id === 'cohost-dismiss')?.keys).toEqual(['⌫'])
  })
})
