import { describe, expect, it } from 'vitest'

import {
  appPlatform,
  displayAccelerator,
  displayKeyGlyph,
  displayKeyGlyphs,
  isWindowsPlatform,
  osSettingsName,
  revealInFileManagerLabel
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

describe('revealInFileManagerLabel', () => {
  it('names the host file manager', () => {
    expect(revealInFileManagerLabel('darwin')).toBe('Show in Finder')
    expect(revealInFileManagerLabel('win32')).toBe('Show in Explorer')
    expect(revealInFileManagerLabel('linux')).toBe('Show in folder')
  })
})

describe('displayAccelerator', () => {
  it('keeps mac accelerators on macOS and translates modifiers elsewhere', () => {
    expect(displayAccelerator('Cmd+Shift+R', 'darwin')).toBe('Cmd+Shift+R')
    expect(displayAccelerator('Cmd+Shift+R', 'win32')).toBe('Ctrl+Shift+R')
    expect(displayAccelerator('Cmd+P', 'linux')).toBe('Ctrl+P')
  })
})
