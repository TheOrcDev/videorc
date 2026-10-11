import { describe, expect, it } from 'vitest'

import { WORKSPACE_SHORTCUTS } from '@/components/workspace-nav'

import { parseAccelerator } from '../../../shared/accelerator-format'

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
      navEntries.filter((entry) => /^CmdOrCtrl\+([1-9]|,)$/.test(entry.accelerators[0])).length
    ).toBe(WORKSPACE_SHORTCUTS.length)
  })

  it('labels ⌘9 Buddy (plan 119)', () => {
    expect(SHORTCUTS.find((entry) => entry.id === 'nav-ai')).toMatchObject({
      accelerators: ['CmdOrCtrl+9'],
      label: 'Buddy'
    })
  })

  it('has unique ids and accelerators that parse on every platform', () => {
    const ids = SHORTCUTS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of SHORTCUTS) {
      expect(entry.accelerators.length).toBeGreaterThan(0)
      for (const accelerator of entry.accelerators) {
        // Plan 174 S1.2: authored as accelerators, never as Mac glyphs.
        expect(accelerator, entry.id).not.toMatch(/[⌘⇧⌥⌃␣⌫↵]/)
        for (const platform of ['darwin', 'win32', 'linux']) {
          expect(parseAccelerator(accelerator, platform), `${entry.id} ${platform}`).not.toBeNull()
        }
      }
    }
  })

  it('groups cover Navigation, Session, Windows, Chat, and Appearance', () => {
    expect([...shortcutsByGroup().keys()]).toEqual([
      'Navigation',
      'Session',
      'Windows',
      'Chat',
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
    expect(cohost.every((entry) => entry.group === 'Chat')).toBe(true)
    expect(cohost.find((entry) => entry.id === 'cohost-focus')?.accelerators).toEqual([
      'CmdOrCtrl+J'
    ])
    expect(cohost.find((entry) => entry.id === 'cohost-dismiss')?.accelerators).toEqual([
      'Backspace'
    ])
  })
})
