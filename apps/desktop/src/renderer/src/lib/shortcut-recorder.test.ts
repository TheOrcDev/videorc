import { describe, expect, it } from 'vitest'

import type { AcceleratorKeyInput } from '../../../shared/accelerator'
import {
  acceleratorInlineLabel,
  appShortcutOwner,
  shortcutRecorderName,
  shortcutRecorderStep
} from './shortcut-recorder'

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
const free = () => null

describe('shortcutRecorderStep', () => {
  it('commits ⌘⇧M exactly as Electron registers it', () => {
    expect(
      shortcutRecorderStep(press('KeyM', { meta: true, shift: true }), 'darwin', free)
    ).toEqual({ type: 'commit', accelerator: 'Cmd+Shift+M' })
  })

  it('shows held modifiers without committing', () => {
    expect(
      shortcutRecorderStep(press('ShiftLeft', { meta: true, shift: true }), 'darwin', free)
    ).toEqual({ type: 'held', modifiers: ['Cmd', 'Shift'] })
  })

  it('cancels on Esc and clears on Backspace', () => {
    expect(shortcutRecorderStep(press('Escape'), 'darwin', free)).toEqual({ type: 'cancel' })
    expect(shortcutRecorderStep(press('Backspace'), 'darwin', free)).toEqual({ type: 'clear' })
  })

  it('explains a bare key instead of saving it', () => {
    expect(shortcutRecorderStep(press('KeyM'), 'darwin', free)).toEqual({
      type: 'reject',
      message: 'Add ⌘, ⌃ or ⌥ so the key still types in other apps.'
    })
    expect(shortcutRecorderStep(press('KeyM', { shift: true }), 'win32', free)).toEqual({
      type: 'reject',
      message: 'Add Ctrl, Alt or Win so the key still types in other apps.'
    })
  })

  it('refuses ⌘M and names it', () => {
    expect(shortcutRecorderStep(press('KeyM', { meta: true }), 'darwin', free)).toEqual({
      type: 'reject',
      message: '⌘M is a system shortcut in every app. Pick another.'
    })
  })

  it("passes the caller's duplicate refusal through", () => {
    expect(
      shortcutRecorderStep(
        press('KeyR', { meta: true, shift: true }),
        'darwin',
        () => 'Already used by Record / stop recording.'
      )
    ).toEqual({ type: 'reject', message: 'Already used by Record / stop recording.' })
  })

  it("refuses Videorc's own keys and names what they do (plan 174 I-17)", () => {
    expect(shortcutRecorderStep(press('KeyK', { meta: true }), 'darwin', free)).toEqual({
      type: 'reject',
      message: "⌘K is Videorc's shortcut for “Search & commands”. Pick another."
    })
    expect(shortcutRecorderStep(press('Digit1', { control: true }), 'win32', free)).toEqual({
      type: 'reject',
      message: "Ctrl+1 is Videorc's shortcut for “Studio”. Pick another."
    })
    expect(
      shortcutRecorderStep(press('KeyJ', { meta: true, shift: true }), 'darwin', free)
    ).toMatchObject({ type: 'reject', message: expect.stringContaining('Open Stream Manager') })
  })

  it('refuses keys Electron cannot name', () => {
    expect(shortcutRecorderStep(press('IntlRo', { control: true }), 'darwin', free)).toMatchObject({
      type: 'reject'
    })
  })
})

describe('acceleratorInlineLabel', () => {
  it('joins glyphs on macOS and words with + elsewhere', () => {
    expect(acceleratorInlineLabel('Cmd+Shift+M', 'darwin')).toBe('⇧⌘M')
    expect(acceleratorInlineLabel('Ctrl+Shift+M', 'win32')).toBe('Ctrl+Shift+M')
  })
})

describe('appShortcutOwner', () => {
  it('matches across spellings of the same keys', () => {
    expect(appShortcutOwner('Cmd+P', 'darwin')?.id).toBe('preview-window')
    expect(appShortcutOwner('Ctrl+P', 'win32')?.id).toBe('preview-window')
    expect(appShortcutOwner('Command+,', 'darwin')?.id).toBe('nav-settings')
  })

  it('leaves combinations Videorc does not use alone', () => {
    expect(appShortcutOwner('Cmd+Shift+R', 'darwin')).toBeNull()
    // ⌃P is text editing on a Mac, not Videorc's preview key.
    expect(appShortcutOwner('Ctrl+P', 'darwin')).toBeNull()
    expect(appShortcutOwner('', 'darwin')).toBeNull()
  })
})

describe('shortcutRecorderName (plan 174 I-17)', () => {
  it('carries the binding the field holds', () => {
    expect(
      shortcutRecorderName({
        label: 'Mark a clip',
        value: 'Cmd+Shift+M',
        armed: false,
        platform: 'darwin'
      })
    ).toBe('Mark a clip: ⇧⌘M')
    expect(
      shortcutRecorderName({ label: 'Mark a clip', value: '', armed: false, platform: 'win32' })
    ).toBe('Mark a clip: Unassigned')
  })

  it('says what to do while it records', () => {
    expect(
      shortcutRecorderName({
        label: 'Mark a clip',
        value: 'Cmd+Shift+M',
        armed: true,
        platform: 'darwin'
      })
    ).toBe('Mark a clip: press the new shortcut')
  })
})
