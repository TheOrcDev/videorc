import { describe, expect, it } from 'vitest'

import {
  appPlatform,
  displayKeyGlyph,
  displayKeyGlyphs,
  isWindowsPlatform,
  osSettingsName
} from './platform'

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

  it('translates a full key sequence', () => {
    expect(displayKeyGlyphs(['⌘', '⇧', 'J'], 'win32')).toEqual(['Ctrl', 'Shift', 'J'])
    expect(displayKeyGlyphs(['⌘', '1'], 'darwin')).toEqual(['⌘', '1'])
  })
})

describe('isWindowsPlatform', () => {
  it('is true only for win32', () => {
    expect(isWindowsPlatform('win32')).toBe(true)
    expect(isWindowsPlatform('darwin')).toBe(false)
    expect(isWindowsPlatform(undefined)).toBe(false)
  })
})
