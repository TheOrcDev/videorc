import { describe, expect, it } from 'vitest'

import {
  acceleratorDisplayKeys,
  acceleratorFromKeyInput,
  findAcceleratorOwner,
  normalizeAccelerator,
  validateAccelerator,
  type AcceleratorKeyInput
} from './accelerator'

const press = (
  code: string,
  mods: Partial<Omit<AcceleratorKeyInput, 'code'>> = {}
): AcceleratorKeyInput => ({
  type: 'keyDown',
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods
})

describe('acceleratorFromKeyInput', () => {
  it('records ⌘⇧M on macOS in the saved modifier order', () => {
    expect(acceleratorFromKeyInput(press('KeyM', { meta: true, shift: true }), 'darwin')).toEqual({
      kind: 'combo',
      accelerator: 'Cmd+Shift+M',
      modifiers: ['Cmd', 'Shift']
    })
  })

  it('reads the physical key, so ⌥M is not saved as µ', () => {
    expect(acceleratorFromKeyInput(press('KeyM', { alt: true }), 'darwin')).toMatchObject({
      accelerator: 'Alt+M'
    })
  })

  it('records Ctrl+Shift+M on Windows and names the Windows key Super', () => {
    expect(
      acceleratorFromKeyInput(press('KeyM', { control: true, shift: true }), 'win32')
    ).toMatchObject({
      accelerator: 'Ctrl+Shift+M'
    })
    expect(acceleratorFromKeyInput(press('KeyM', { meta: true }), 'win32')).toMatchObject({
      accelerator: 'Super+M'
    })
  })

  it('maps function, digit, arrow, numpad and punctuation keys to Electron names', () => {
    const keyOf = (code: string) =>
      acceleratorFromKeyInput(press(code, { control: true }), 'darwin')
    expect(keyOf('F13')).toMatchObject({ accelerator: 'Ctrl+F13' })
    expect(keyOf('Digit1')).toMatchObject({ accelerator: 'Ctrl+1' })
    expect(keyOf('ArrowLeft')).toMatchObject({ accelerator: 'Ctrl+Left' })
    expect(keyOf('Numpad4')).toMatchObject({ accelerator: 'Ctrl+num4' })
    expect(keyOf('BracketLeft')).toMatchObject({ accelerator: 'Ctrl+[' })
    expect(keyOf('IntlRo')).toEqual({ kind: 'unsupported', modifiers: ['Ctrl'] })
  })

  it('reports held modifiers live, on press and on release', () => {
    expect(acceleratorFromKeyInput(press('MetaLeft', { meta: true }), 'darwin')).toEqual({
      kind: 'modifiers',
      modifiers: ['Cmd']
    })
    expect(
      acceleratorFromKeyInput({ ...press('KeyM', { shift: true }), type: 'keyUp' }, 'darwin')
    ).toEqual({ kind: 'modifiers', modifiers: ['Shift'] })
  })

  it('treats bare Esc as cancel and bare Backspace or Delete as clear', () => {
    expect(acceleratorFromKeyInput(press('Escape'), 'darwin')).toEqual({ kind: 'cancel' })
    expect(acceleratorFromKeyInput(press('Backspace'), 'darwin')).toEqual({ kind: 'clear' })
    expect(acceleratorFromKeyInput(press('Delete'), 'win32')).toEqual({ kind: 'clear' })
    expect(acceleratorFromKeyInput(press('Backspace', { meta: true }), 'darwin')).toMatchObject({
      accelerator: 'Cmd+Backspace'
    })
  })
})

describe('validateAccelerator', () => {
  it('requires a real modifier, except for a bare function key', () => {
    expect(validateAccelerator('M', 'darwin')).toEqual({ ok: false, reason: 'needs-modifier' })
    expect(validateAccelerator('Shift+M', 'darwin')).toEqual({
      ok: false,
      reason: 'needs-modifier'
    })
    expect(validateAccelerator('F13', 'darwin')).toEqual({ ok: true })
    expect(validateAccelerator('Alt+M', 'win32')).toEqual({ ok: true })
  })

  it('blocks system combinations but not their Shift variants', () => {
    expect(validateAccelerator('Cmd+M', 'darwin')).toEqual({
      ok: false,
      reason: 'system-reserved'
    })
    expect(validateAccelerator('Cmd+Q', 'darwin')).toMatchObject({ reason: 'system-reserved' })
    expect(validateAccelerator('Cmd+Shift+M', 'darwin')).toEqual({ ok: true })
    expect(validateAccelerator('Alt+F4', 'win32')).toMatchObject({ reason: 'system-reserved' })
    expect(validateAccelerator('Ctrl+M', 'win32')).toEqual({ ok: true })
  })
})

describe('normalizeAccelerator', () => {
  it('compares any spelling, case or modifier order as the same binding', () => {
    expect(normalizeAccelerator('cmd+shift+m', 'darwin')).toBe('Cmd+Shift+M')
    expect(normalizeAccelerator('Shift+Command+M', 'darwin')).toBe('Cmd+Shift+M')
    expect(normalizeAccelerator('Control+Option+return', 'darwin')).toBe('Ctrl+Alt+Enter')
    expect(normalizeAccelerator('CmdOrCtrl+K', 'darwin')).toBe('Cmd+K')
  })

  it('registers a pre-062 Cmd binding as Ctrl off macOS, matching what the UI showed', () => {
    expect(normalizeAccelerator('Cmd+Shift+R', 'win32')).toBe('Ctrl+Shift+R')
    expect(normalizeAccelerator('CommandOrControl+K', 'linux')).toBe('Ctrl+K')
  })

  it('returns null for empty or malformed values', () => {
    expect(normalizeAccelerator('', 'darwin')).toBeNull()
    expect(normalizeAccelerator(undefined, 'darwin')).toBeNull()
    expect(normalizeAccelerator('Cmd+Shift', 'darwin')).toBeNull()
    expect(normalizeAccelerator('Cmd+A+B', 'darwin')).toBeNull()
  })
})

describe('findAcceleratorOwner', () => {
  const config = {
    recordToggle: 'Cmd+Shift+R',
    layouts: { 'screen-camera': 'Control+Alt+1' }
  }

  it('finds duplicates across action rows and layout rows', () => {
    expect(findAcceleratorOwner(config, 'Shift+Cmd+R', 'mic-toggle', 'darwin')).toBe(
      'record-toggle'
    )
    expect(findAcceleratorOwner(config, 'Ctrl+Alt+1', 'layout:screen-only', 'darwin')).toBe(
      'layout:screen-camera'
    )
  })

  it('ignores the row being edited and free combinations', () => {
    expect(findAcceleratorOwner(config, 'Cmd+Shift+R', 'record-toggle', 'darwin')).toBeNull()
    expect(findAcceleratorOwner(config, 'Cmd+Shift+M', 'mic-toggle', 'darwin')).toBeNull()
  })
})

describe('acceleratorDisplayKeys', () => {
  it('uses mac glyphs in menu order on macOS', () => {
    expect(acceleratorDisplayKeys('Cmd+Shift+M', 'darwin')).toEqual(['⇧', '⌘', 'M'])
    expect(acceleratorDisplayKeys('Cmd+Ctrl+Alt+Up', 'darwin')).toEqual(['⌃', '⌥', '⌘', '↑'])
  })

  it('uses words off macOS and shows a legacy Cmd binding as Ctrl', () => {
    expect(acceleratorDisplayKeys('Ctrl+Shift+M', 'win32')).toEqual(['Ctrl', 'Shift', 'M'])
    expect(acceleratorDisplayKeys('Cmd+Shift+R', 'win32')).toEqual(['Ctrl', 'Shift', 'R'])
    expect(acceleratorDisplayKeys('Super+F13', 'linux')).toEqual(['Win', 'F13'])
  })

  it('shows nothing when unassigned and the raw value when it cannot be read', () => {
    expect(acceleratorDisplayKeys('', 'darwin')).toEqual([])
    expect(acceleratorDisplayKeys('Cmd+A+B', 'darwin')).toEqual(['Cmd+A+B'])
  })
})
