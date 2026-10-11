import { describe, expect, it } from 'vitest'

import {
  navigationShortcutTab,
  shellShortcutAction,
  type ShellShortcutContext
} from './shell-shortcuts'

type Press = Parameters<typeof shellShortcutAction>[0]

const mac: ShellShortcutContext = {
  platform: 'darwin',
  modalOpen: false,
  searchOpen: false,
  notesWindowEnabled: true,
  commentsWindowEnabled: true
}

function press(key: string, init: Partial<Press> = {}): Press {
  return { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...init }
}

describe('shellShortcutAction (plan 174 S3.21, A-2, A-12)', () => {
  it('maps the shell chords', () => {
    expect(shellShortcutAction(press('k'), mac)).toBe('toggle-search')
    expect(shellShortcutAction(press('p'), mac)).toBe('toggle-preview')
    expect(shellShortcutAction(press('n', { shiftKey: true }), mac)).toBe('toggle-notes')
    expect(shellShortcutAction(press('c', { shiftKey: true }), mac)).toBe('toggle-captions')
    expect(shellShortcutAction(press('/'), mac)).toBe('open-shortcuts')
    expect(shellShortcutAction(press('x'), mac)).toBeNull()
  })

  it('shows Stream Manager on ⌘J and toggles it on ⇧⌘J', () => {
    expect(shellShortcutAction(press('j'), mac)).toBe('show-stream-manager')
    expect(shellShortcutAction(press('j', { shiftKey: true }), mac)).toBe('toggle-stream-manager')
    const off = { ...mac, commentsWindowEnabled: false }
    expect(shellShortcutAction(press('j'), off)).toBeNull()
    expect(shellShortcutAction(press('j', { shiftKey: true }), off)).toBeNull()
    expect(
      shellShortcutAction(press('n', { shiftKey: true }), { ...mac, notesWindowEnabled: false })
    ).toBeNull()
  })

  it('takes ⌘ on a Mac and Ctrl elsewhere, never both (A-17)', () => {
    expect(shellShortcutAction(press('k', { metaKey: false, ctrlKey: true }), mac)).toBeNull()
    const win = { ...mac, platform: 'win32' }
    expect(shellShortcutAction(press('k', { metaKey: false, ctrlKey: true }), win)).toBe(
      'toggle-search'
    )
    expect(shellShortcutAction(press('k'), win)).toBeNull()
    expect(shellShortcutAction(press('k', { altKey: true }), mac)).toBeNull()
  })

  it('does nothing from under a dialog, except ⌘K closing Search', () => {
    const modal = { ...mac, modalOpen: true }
    for (const key of ['k', 'p', 'j', '/']) {
      expect(shellShortcutAction(press(key), modal), key).toBeNull()
    }
    expect(shellShortcutAction(press('n', { shiftKey: true }), modal)).toBeNull()
    expect(shellShortcutAction(press('k'), { ...modal, searchOpen: true })).toBe('close-search')
    expect(shellShortcutAction(press('p'), { ...modal, searchOpen: true })).toBeNull()
  })
})

describe('navigationShortcutTab', () => {
  it('maps the forwarded keys to pages, and none from under a dialog', () => {
    expect(navigationShortcutTab('1', false)).toBe('studio')
    expect(navigationShortcutTab('9', false)).toBe('ai')
    expect(navigationShortcutTab(',', false)).toBe('settings')
    expect(navigationShortcutTab('0', false)).toBeNull()
    expect(navigationShortcutTab('1', true)).toBeNull()
  })
})
