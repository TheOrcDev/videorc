import { describe, expect, it } from 'vitest'

import type { AcceleratorKeyInput } from '../../../shared/accelerator'
import { acceleratorInlineLabel, shortcutRecorderStep } from './shortcut-recorder'

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
        () => 'Already used by Start / stop recording.'
      )
    ).toEqual({ type: 'reject', message: 'Already used by Start / stop recording.' })
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
