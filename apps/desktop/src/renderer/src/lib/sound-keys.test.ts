// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { soundForKey, soundKeyBlocked } from './sound-keys'

// Plan 189 S6: the digits yield like Space does, except that a focused
// button (a pad) doesn't own a digit.

const press = (overrides: Partial<KeyboardEvent> = {}) => ({
  repeat: false,
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  target: document.body,
  ...overrides
})

describe('soundKeyBlocked', () => {
  it('lets a plain digit through on the page and on a focused button', () => {
    const button = document.createElement('button')
    document.body.append(button)
    expect(soundKeyBlocked(press(), document)).toBe(false)
    expect(soundKeyBlocked(press({ target: button }), document)).toBe(false)
  })

  it('yields to a repeat, a modifier, a field, a menu and an open dialog', () => {
    expect(soundKeyBlocked(press({ repeat: true }), document)).toBe(true)
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      expect(soundKeyBlocked(press({ [modifier]: true }), document)).toBe(true)
    }
    for (const markup of [
      '<input />',
      '<textarea></textarea>',
      '<div contenteditable="true"><span>x</span></div>',
      '<div role="menu"><div role="menuitem">x</div></div>'
    ]) {
      document.body.innerHTML = markup
      const target = document.body.querySelector('span, [role="menuitem"], input, textarea')!
      expect(soundKeyBlocked(press({ target }), document), markup).toBe(true)
    }
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>'
    expect(soundKeyBlocked(press(), document)).toBe(true)
    document.body.innerHTML = ''
  })
})

describe('soundForKey', () => {
  it('finds the sound with that key, 1 to 9 only', () => {
    const sounds = [{ id: 'a', hotkey: '1' as const }, { id: 'b' }]
    expect(soundForKey('1', sounds)?.id).toBe('a')
    expect(soundForKey('2', sounds)).toBeUndefined()
    expect(soundForKey('0', sounds)).toBeUndefined()
    expect(soundForKey('Digit1', sounds)).toBeUndefined()
  })
})
