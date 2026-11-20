import { describe, expect, it } from 'vitest'

import { WORKSPACE_SHORTCUTS, pageShortcutFor, workspaceTabLabel } from '@/components/workspace-nav'

import { parseAccelerator } from '@/lib/accelerator'

import { SHORTCUTS, navShortcutAccelerator, shortcutsByGroup } from './shortcuts'

describe('SHORTCUTS registry', () => {
  // ST4: the registry's Navigation rows are built from the page key map, so
  // the Settings reference table can never disagree with the sidebar.
  it('matches the workspace page shortcut map one-to-one, in sidebar order', () => {
    const navEntries = SHORTCUTS.filter((entry) => entry.id.startsWith('nav-'))
    expect(navEntries.map((entry) => entry.id)).toEqual(
      WORKSPACE_SHORTCUTS.map(({ tab }) => `nav-${tab}`)
    )
    for (const { tab } of WORKSPACE_SHORTCUTS) {
      expect(navShortcutAccelerator(tab), `nav-${tab}`).toBe(pageShortcutFor(tab))
      expect(SHORTCUTS.find((entry) => entry.id === `nav-${tab}`)?.label).toBe(
        workspaceTabLabel(tab)
      )
    }
  })

  // Owner 2026-11-20: ⌘1–⌘9 down the rows above Assets; Images ⇧⌘G, Sounds
  // ⇧⌘S, Library ⌘0, Settings ⌘,.
  it('labels ⌘7 Guests, ⌘9 Sidekick, ⇧⌘G Images, ⇧⌘S Sounds, ⌘0 Library and ⌘, Settings', () => {
    const row = (id: string): unknown => SHORTCUTS.find((entry) => entry.id === id)
    expect(row('nav-guests')).toMatchObject({ accelerators: ['CmdOrCtrl+7'], label: 'Guests' })
    expect(row('nav-ai')).toMatchObject({ accelerators: ['CmdOrCtrl+9'], label: 'Sidekick' })
    expect(row('nav-assets')).toMatchObject({
      accelerators: ['CmdOrCtrl+Shift+G'],
      label: 'Images'
    })
    expect(row('nav-sounds')).toMatchObject({
      accelerators: ['CmdOrCtrl+Shift+S'],
      label: 'Sounds'
    })
    expect(row('nav-library')).toMatchObject({ accelerators: ['CmdOrCtrl+0'], label: 'Library' })
    expect(row('nav-settings')).toMatchObject({ accelerators: ['CmdOrCtrl+,'], label: 'Settings' })
  })

  // No other chord the registry knows (main window, Stream Manager, the
  // windows) is a page key.
  it('gives every page key a chord nothing else uses', () => {
    for (const { tab } of WORKSPACE_SHORTCUTS) {
      const accelerator = pageShortcutFor(tab)
      const owners = SHORTCUTS.filter((entry) =>
        entry.accelerators.some((key) => key === accelerator)
      )
      expect(
        owners.map((entry) => entry.id),
        tab
      ).toEqual([`nav-${tab}`])
    }
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

  // Plan 174 S2.2 (I-32): a group names where its keys work, and copy never
  // says "session": Space works on Studio, the Buddy keys in Stream Manager.
  it('groups cover Navigation, Studio, Windows, Stream Manager, and Appearance', () => {
    expect([...shortcutsByGroup().keys()]).toEqual([
      'Navigation',
      'Studio',
      'Windows',
      'Stream Manager',
      'Appearance'
    ])
  })

  it('labels Space in the transport words (plan 174 D3)', () => {
    expect(SHORTCUTS.find((entry) => entry.id === 'record-toggle')).toMatchObject({
      accelerators: ['Space'],
      label: 'Record / stop recording',
      group: 'Studio'
    })
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
      'cohost-dismiss',
      'cohost-remove-flagged'
    ])
    expect(cohost.every((entry) => entry.group === 'Stream Manager')).toBe(true)
    // Plan 174 F-27: the Suggest cards' and the Say box's keys are listed too.
    const buddy = SHORTCUTS.filter((entry) => entry.id.startsWith('buddy-'))
    expect(buddy.map((entry) => [entry.id, entry.accelerators[0]])).toEqual([
      ['buddy-card-send', 'Enter'],
      ['buddy-card-dismiss', 'Escape'],
      ['buddy-say', 'Enter'],
      ['buddy-say-laugh', 'CmdOrCtrl+Enter']
    ])
    expect(buddy.every((entry) => entry.group === 'Stream Manager')).toBe(true)
    expect(cohost.find((entry) => entry.id === 'cohost-focus')?.accelerators).toEqual([
      'CmdOrCtrl+J'
    ])
    expect(cohost.find((entry) => entry.id === 'cohost-dismiss')?.accelerators).toEqual([
      'Backspace'
    ])
  })
})
