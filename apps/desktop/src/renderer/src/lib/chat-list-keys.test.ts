// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { chatRowAfterMove, chatRowKeyCommand, clickSelectsText } from './chat-list-keys'

function key(
  overrides: Partial<Parameters<typeof chatRowKeyCommand>[0]> & { key: string }
): Parameters<typeof chatRowKeyCommand>[0] {
  return {
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: null,
    ...overrides
  }
}

const row = document.createElement('li')

describe('chatRowKeyCommand (plan 174 S3.16a, H-7)', () => {
  it('moves with the arrows, Home and End', () => {
    expect(chatRowKeyCommand(key({ key: 'ArrowDown' }), row)).toEqual({
      kind: 'move',
      move: 'next'
    })
    expect(chatRowKeyCommand(key({ key: 'ArrowUp' }), row)).toEqual({
      kind: 'move',
      move: 'previous'
    })
    expect(chatRowKeyCommand(key({ key: 'Home' }), row)).toEqual({ kind: 'move', move: 'first' })
    expect(chatRowKeyCommand(key({ key: 'End' }), row)).toEqual({ kind: 'move', move: 'last' })
  })

  it('replies on R, copies on C, removes on shift-backspace and returns to the composer on Esc', () => {
    expect(chatRowKeyCommand(key({ key: 'r' }), row)).toEqual({ kind: 'reply' })
    expect(chatRowKeyCommand(key({ key: 'C' }), row)).toEqual({ kind: 'copy' })
    expect(chatRowKeyCommand(key({ key: 'Backspace', shiftKey: true }), row)).toEqual({
      kind: 'remove'
    })
    expect(chatRowKeyCommand(key({ key: 'Delete', shiftKey: true }), row)).toEqual({
      kind: 'remove'
    })
    expect(chatRowKeyCommand(key({ key: 'Escape' }), row)).toEqual({ kind: 'composer' })
  })

  it('leaves a plain backspace, a modifier chord, a taken key and a typed letter alone', () => {
    expect(chatRowKeyCommand(key({ key: 'Backspace' }), row)).toBeNull()
    expect(chatRowKeyCommand(key({ key: 'r', metaKey: true }), row)).toBeNull()
    expect(chatRowKeyCommand(key({ key: 'c', ctrlKey: true }), row)).toBeNull()
    expect(chatRowKeyCommand(key({ key: 'ArrowDown', altKey: true }), row)).toBeNull()
    expect(chatRowKeyCommand(key({ key: 'ArrowDown', defaultPrevented: true }), row)).toBeNull()
    expect(chatRowKeyCommand(key({ key: 'r', isComposing: true }), row)).toBeNull()
    expect(chatRowKeyCommand(key({ key: 'ArrowDown' }), null)).toBeNull()
    // Enter and Space are the row button's own click.
    expect(chatRowKeyCommand(key({ key: 'Enter' }), row)).toBeNull()
    expect(chatRowKeyCommand(key({ key: ' ' }), row)).toBeNull()
  })

  it('never answers from a text field or an open menu inside the list', () => {
    const input = document.createElement('input')
    row.append(input)
    expect(chatRowKeyCommand(key({ key: 'r', target: input }), row)).toBeNull()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    menu.append(item)
    row.append(menu)
    expect(chatRowKeyCommand(key({ key: 'Escape', target: item }), row)).toBeNull()
    input.remove()
    menu.remove()
  })
})

describe('chatRowAfterMove', () => {
  it('steps and clamps, and lands on an end from outside the list', () => {
    expect(chatRowAfterMove(0, 0, 'next')).toBeNull()
    expect(chatRowAfterMove(3, 0, 'next')).toBe(1)
    expect(chatRowAfterMove(3, 2, 'next')).toBe(2)
    expect(chatRowAfterMove(3, 0, 'previous')).toBe(0)
    expect(chatRowAfterMove(3, 1, 'first')).toBe(0)
    expect(chatRowAfterMove(3, 1, 'last')).toBe(2)
    expect(chatRowAfterMove(3, -1, 'next')).toBe(0)
    expect(chatRowAfterMove(3, -1, 'previous')).toBe(2)
  })
})

describe('clickSelectsText (owner call, plan 174 D10)', () => {
  const text = document.createTextNode('Ship it!')
  const inside = document.createElement('li')
  inside.append(text)
  const elsewhere = document.createTextNode('other')

  it('is only a drag that left words selected inside the row', () => {
    expect(clickSelectsText(null, inside)).toBe(false)
    expect(
      clickSelectsText({ isCollapsed: true, anchorNode: text, toString: () => '' }, inside)
    ).toBe(false)
    expect(
      clickSelectsText({ isCollapsed: false, anchorNode: text, toString: () => '  ' }, inside)
    ).toBe(false)
    expect(
      clickSelectsText(
        { isCollapsed: false, anchorNode: elsewhere, toString: () => 'other' },
        inside
      )
    ).toBe(false)
    expect(
      clickSelectsText({ isCollapsed: false, anchorNode: text, toString: () => 'Ship' }, inside)
    ).toBe(true)
  })
})
