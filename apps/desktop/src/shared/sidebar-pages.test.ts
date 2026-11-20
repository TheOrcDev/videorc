import { describe, expect, it } from 'vitest'

import {
  PAGE_FIXED_KEYS,
  PAGE_KEYS,
  SIDEBAR_LAYOUT,
  SIDEBAR_PAGE_LABELS,
  assignPageKeys,
  pageKeyAccelerator,
  pageKeyFor,
  pageKeyForInput
} from './sidebar-pages'

// Owner 2026-11-20: the sidebar's order and its key map live in one place.
describe('the sidebar layout', () => {
  it('runs Studio, Setup, Livestream, Assets, then Library and Settings at the foot', () => {
    expect(SIDEBAR_LAYOUT.map((zone) => [zone.id, zone.label ?? null, zone.pages])).toEqual([
      ['stage', null, ['studio']],
      ['setup', 'Setup', ['sources', 'layouts', 'captions', 'recording']],
      ['livestream', 'Livestream', ['live', 'guests', 'avatar', 'ai']],
      ['assets', 'Assets', ['assets', 'sounds']],
      ['system', null, ['library', 'settings']]
    ])
  })

  it('names the old Assets page Images and the new one Sounds', () => {
    expect(SIDEBAR_PAGE_LABELS.assets).toBe('Images')
    expect(SIDEBAR_PAGE_LABELS.sounds).toBe('Sounds')
  })
})

describe('the page keys', () => {
  it('puts ⌘1–⌘9 on the nine rows above Assets, a ⇧⌘ letter on Images and Sounds, ⌘0 on Library, ⌘, on Settings', () => {
    expect(PAGE_KEYS.map(({ key, page }) => `${key} ${page}`)).toEqual([
      '1 studio',
      '2 sources',
      '3 layouts',
      '4 captions',
      '5 recording',
      '6 live',
      '7 guests',
      '8 avatar',
      '9 ai',
      'G assets',
      'S sounds',
      '0 library',
      ', settings'
    ])
    // The digits run down the rows with no gap.
    const rows = SIDEBAR_LAYOUT.flatMap((zone) => zone.pages)
    const digitRows = PAGE_KEYS.filter((entry) => /^[1-9]$/.test(entry.key)).map((e) => e.page)
    expect(digitRows).toEqual(rows.slice(0, 9))
    // No key twice.
    const keys = PAGE_KEYS.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('prints each key as an accelerator', () => {
    expect(pageKeyAccelerator('7')).toBe('CmdOrCtrl+7')
    expect(pageKeyAccelerator('0')).toBe('CmdOrCtrl+0')
    expect(pageKeyAccelerator(',')).toBe('CmdOrCtrl+,')
    expect(pageKeyAccelerator('G')).toBe('CmdOrCtrl+Shift+G')
    expect(pageKeyAccelerator('S')).toBe('CmdOrCtrl+Shift+S')
    expect(pageKeyFor('guests')).toBe('7')
    expect(pageKeyFor('diagnostics')).toBeUndefined()
  })

  it('reads only the mapped chords off a key press', () => {
    const press = (key: string, shift = false, alt = false): string | null =>
      pageKeyForInput({ key, shift, alt })
    for (const { key } of PAGE_KEYS) {
      if (/^[A-Z]$/.test(key)) {
        // ⇧ with ⌘ can report either case.
        expect(press(key, true)).toBe(key)
        expect(press(key.toLowerCase(), true)).toBe(key)
        // A plain ⌘-letter belongs to the windows' own chords (⌘L, ⌘S…).
        expect(press(key.toLowerCase())).toBeNull()
      } else {
        expect(press(key)).toBe(key)
        expect(press(key, true)).toBeNull()
      }
      expect(press(key, false, true)).toBeNull()
    }
    // Unmapped letters and keys open nothing.
    expect(press('k', true)).toBeNull()
    expect(press('i', true)).toBeNull()
    expect(press('F12')).toBeNull()
  })

  it('leaves the fixed keys out of the digit run', () => {
    for (const [page, key] of Object.entries(PAGE_FIXED_KEYS)) {
      expect(pageKeyFor(page), page).toBe(key)
    }
  })
  // The other layout the owner weighed: Assets right after Setup, ⌘1–⌘9 and
  // ⌘0 over the first ten rows, Library on a letter. It is a reorder and two
  // fixed keys, nothing more.
  it('keeps the other layout a small change', () => {
    const [stage, setup, livestream, assets, system] = SIDEBAR_LAYOUT
    const keys = assignPageKeys([stage, setup, assets, livestream, system], {
      library: 'L',
      settings: ','
    })
    expect(keys.map(({ key, page }) => `${key} ${page}`)).toEqual([
      '1 studio',
      '2 sources',
      '3 layouts',
      '4 captions',
      '5 recording',
      '6 assets',
      '7 sounds',
      '8 live',
      '9 guests',
      '0 avatar',
      'L library',
      ', settings'
    ])
  })
})
