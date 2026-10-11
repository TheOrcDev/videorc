import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  appPlatform,
  currentPlatform,
  displayKeyGlyph,
  isCommandKey,
  isWindowsPlatform,
  osSettingsName,
  revealInFileManagerLabel,
  shortcutAriaKeys,
  shortcutLabel,
  trashName
} from './platform'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The platform window-theme-bootstrap.js writes on <html> before the first paint. */
function bootstrapPlatform(platform: string): void {
  vi.stubGlobal('document', { documentElement: { dataset: { platform } } })
}

describe('appPlatform', () => {
  it('classifies known platforms and defaults unknown to other', () => {
    expect(appPlatform('darwin')).toBe('darwin')
    expect(appPlatform('win32')).toBe('win32')
    expect(appPlatform('linux')).toBe('other')
    expect(appPlatform(undefined)).toBe('other')
  })
})

describe('osSettingsName', () => {
  it('names the OS settings app per platform', () => {
    expect(osSettingsName('darwin')).toBe('System Settings')
    expect(osSettingsName('win32')).toBe('Windows Settings')
  })
})

describe('displayKeyGlyph', () => {
  it('keeps mac glyphs on macOS', () => {
    expect(displayKeyGlyph('⌘', 'darwin')).toBe('⌘')
    expect(displayKeyGlyph('⇧', 'darwin')).toBe('⇧')
  })

  it('translates modifier glyphs to Windows names', () => {
    expect(displayKeyGlyph('⌘', 'win32')).toBe('Ctrl')
    expect(displayKeyGlyph('⇧', 'win32')).toBe('Shift')
    expect(displayKeyGlyph('⌥', 'win32')).toBe('Alt')
  })

  it('passes plain keys through unchanged on every platform', () => {
    expect(displayKeyGlyph('K', 'win32')).toBe('K')
    expect(displayKeyGlyph('5', 'win32')).toBe('5')
  })

  it('falls back to the bootstrapped platform, so a Mac never flashes Ctrl (H-22)', () => {
    bootstrapPlatform('darwin')
    expect(displayKeyGlyph('⌘', undefined)).toBe('⌘')
    bootstrapPlatform('win32')
    expect(displayKeyGlyph('⌘', undefined)).toBe('Ctrl')
  })
})

describe('currentPlatform (plan 174 S1.2)', () => {
  it('prefers the platform passed, then the bootstrap attribute, then the user agent', () => {
    bootstrapPlatform('win32')
    expect(currentPlatform('darwin')).toBe('darwin')
    expect(currentPlatform(undefined)).toBe('win32')
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39'
    })
    expect(currentPlatform(undefined)).toBe('darwin')
  })
})

describe('shortcutLabel and shortcutAriaKeys (plan 174 S1.2, A-5)', () => {
  it('prints one macOS keycap in system order, Windows words joined by +', () => {
    expect(shortcutLabel('CmdOrCtrl+Shift+J', 'darwin')).toBe('⇧⌘J')
    expect(shortcutLabel('CmdOrCtrl+Shift+J', 'win32')).toBe('Ctrl+Shift+J')
    expect(shortcutLabel('CmdOrCtrl+P', 'linux')).toBe('Ctrl+P')
    expect(shortcutLabel('CmdOrCtrl+Enter', 'darwin')).toBe('⌘↵')
    expect(shortcutLabel('CmdOrCtrl+Enter', 'win32')).toBe('Ctrl+Enter')
  })

  it('reads the bootstrapped platform when none is passed', () => {
    bootstrapPlatform('darwin')
    expect(shortcutLabel('CmdOrCtrl+K')).toBe('⌘K')
    bootstrapPlatform('win32')
    expect(shortcutLabel('CmdOrCtrl+K')).toBe('Ctrl+K')
  })

  it('names Meta on macOS and Control elsewhere for aria-keyshortcuts', () => {
    expect(shortcutAriaKeys('CmdOrCtrl+K', 'darwin')).toBe('Meta+K')
    expect(shortcutAriaKeys('CmdOrCtrl+1', 'win32')).toBe('Control+1')
    expect(shortcutAriaKeys('CmdOrCtrl+Shift+J', 'linux')).toBe('Control+Shift+J')
  })
})

describe('isCommandKey (plan 174 S1.2, A-17)', () => {
  it('takes ⌘ alone on macOS, so ⌃K and ⌃P stay text editing', () => {
    expect(isCommandKey({ metaKey: true, ctrlKey: false }, 'darwin')).toBe(true)
    expect(isCommandKey({ metaKey: false, ctrlKey: true }, 'darwin')).toBe(false)
  })

  it('takes Ctrl elsewhere, never the Windows key', () => {
    expect(isCommandKey({ metaKey: false, ctrlKey: true }, 'win32')).toBe(true)
    expect(isCommandKey({ metaKey: true, ctrlKey: false }, 'win32')).toBe(false)
    expect(isCommandKey({ metaKey: false, ctrlKey: true }, 'linux')).toBe(true)
  })
})

describe('isWindowsPlatform', () => {
  it('is true only for win32', () => {
    expect(isWindowsPlatform('win32')).toBe(true)
    expect(isWindowsPlatform('darwin')).toBe(false)
    expect(isWindowsPlatform(undefined)).toBe(false)
  })
})

describe('revealInFileManagerLabel', () => {
  it('names the host file manager', () => {
    expect(revealInFileManagerLabel('darwin')).toBe('Show in Finder')
    expect(revealInFileManagerLabel('win32')).toBe('Show in Explorer')
    expect(revealInFileManagerLabel('linux')).toBe('Show in folder')
  })
})

describe('trashName', () => {
  it('names where a deleted file goes (plan 174 E-2)', () => {
    expect(trashName('darwin')).toBe('Trash')
    expect(trashName('win32')).toBe('Recycle Bin')
    expect(trashName('linux')).toBe('Trash')
  })
})
