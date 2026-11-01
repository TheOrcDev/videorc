import { describe, expect, it } from 'vitest'

import {
  acceleratorAriaKeyShortcuts,
  acceleratorDisplayKeys,
  acceleratorLabel,
  acceleratorModifiersLabel,
  commandModifierHeld
} from './accelerator-format'

// Plan 174 S1.2 (A-5, I-18, H-22, F-22, V-X1): one notation per platform.
// macOS: glyphs in system order (⌃⌥⇧⌘) in one keycap; Windows and Linux:
// words joined by "+", never a Mac glyph.

describe('acceleratorLabel', () => {
  it('reads like the macOS menus: one keycap, system order', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+J', 'darwin')).toBe('⇧⌘J')
    expect(acceleratorLabel('Shift+CmdOrCtrl+N', 'darwin')).toBe('⇧⌘N')
    expect(acceleratorLabel('CmdOrCtrl+K', 'darwin')).toBe('⌘K')
    expect(acceleratorLabel('CmdOrCtrl+,', 'darwin')).toBe('⌘,')
    expect(acceleratorLabel('Ctrl+Alt+Shift+Cmd+R', 'darwin')).toBe('⌃⌥⇧⌘R')
  })

  it('reads like Windows menus: words joined by +', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+J', 'win32')).toBe('Ctrl+Shift+J')
    expect(acceleratorLabel('CmdOrCtrl+1', 'win32')).toBe('Ctrl+1')
    expect(acceleratorLabel('CmdOrCtrl+K', 'linux')).toBe('Ctrl+K')
    expect(acceleratorLabel('Super+F13', 'linux')).toBe('Win+F13')
  })

  it('names the special keys: Mac glyphs on macOS, words elsewhere', () => {
    const keys = ['Space', 'Backspace', 'Enter', 'Delete', 'Escape', 'Shift+Backspace']
    expect(keys.map((key) => acceleratorLabel(key, 'darwin'))).toEqual([
      'Space',
      '⌫',
      '↵',
      '⌦',
      'Esc',
      '⇧⌫'
    ])
    expect(keys.map((key) => acceleratorLabel(key, 'win32'))).toEqual([
      'Space',
      'Backspace',
      'Enter',
      'Delete',
      'Esc',
      'Shift+Backspace'
    ])
    expect(acceleratorLabel('CmdOrCtrl+Enter', 'darwin')).toBe('⌘↵')
    expect(acceleratorLabel('CmdOrCtrl+Enter', 'win32')).toBe('Ctrl+Enter')
  })

  it('prints a lone modifier hint per platform (drag hints)', () => {
    expect(acceleratorLabel('Alt', 'darwin')).toBe('⌥')
    expect(acceleratorLabel('Alt', 'win32')).toBe('Alt')
    expect(acceleratorLabel('Shift', 'darwin')).toBe('⇧')
    expect(acceleratorLabel('Shift', 'linux')).toBe('Shift')
    expect(acceleratorDisplayKeys('Shift', 'win32')).toEqual(['Shift'])
  })

  it('never prints a Mac glyph off macOS for anything the app binds', () => {
    for (const accelerator of [
      'CmdOrCtrl+Shift+J',
      'CmdOrCtrl+Enter',
      'Space',
      'Backspace',
      'Shift+Backspace',
      'Alt',
      'Up'
    ]) {
      expect(acceleratorLabel(accelerator, 'win32')).not.toMatch(/[⌘⇧⌥⌃␣⌫↵⌦]/)
    }
  })

  it('is empty for nothing, and passes an unreadable value through', () => {
    expect(acceleratorLabel('', 'darwin')).toBe('')
    expect(acceleratorLabel(undefined, 'win32')).toBe('')
    expect(acceleratorLabel('Cmd+A+B', 'darwin')).toBe('Cmd+A+B')
  })
})

describe('acceleratorModifiersLabel', () => {
  it('shows modifiers held mid-press the same way', () => {
    expect(acceleratorModifiersLabel(['Cmd', 'Shift'], 'darwin')).toBe('⇧⌘')
    expect(acceleratorModifiersLabel(['Ctrl', 'Shift'], 'win32')).toBe('Ctrl+Shift')
    expect(acceleratorModifiersLabel([], 'darwin')).toBe('')
  })
})

describe('acceleratorAriaKeyShortcuts', () => {
  it('names the real keys: Meta on macOS, Control elsewhere', () => {
    expect(acceleratorAriaKeyShortcuts('CmdOrCtrl+K', 'darwin')).toBe('Meta+K')
    expect(acceleratorAriaKeyShortcuts('CmdOrCtrl+K', 'win32')).toBe('Control+K')
    expect(acceleratorAriaKeyShortcuts('CmdOrCtrl+Shift+J', 'darwin')).toBe('Shift+Meta+J')
    expect(acceleratorAriaKeyShortcuts('CmdOrCtrl+Shift+J', 'linux')).toBe('Control+Shift+J')
    expect(acceleratorAriaKeyShortcuts('Up', 'darwin')).toBe('ArrowUp')
    expect(acceleratorAriaKeyShortcuts('Space', 'win32')).toBe('Space')
    expect(acceleratorAriaKeyShortcuts('', 'darwin')).toBe('')
  })
})

describe('commandModifierHeld (A-17)', () => {
  it('is ⌘ on macOS and Ctrl elsewhere, never either', () => {
    expect(commandModifierHeld({ meta: true, control: false }, 'darwin')).toBe(true)
    expect(commandModifierHeld({ meta: false, control: true }, 'darwin')).toBe(false)
    expect(commandModifierHeld({ meta: false, control: true }, 'win32')).toBe(true)
    expect(commandModifierHeld({ meta: true, control: false }, 'win32')).toBe(false)
    expect(commandModifierHeld({ meta: false, control: true }, 'linux')).toBe(true)
  })
})
