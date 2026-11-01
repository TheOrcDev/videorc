// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { isLayoutUndoShortcut, layoutUndoShortcutBlocked } from './layout-undo-shortcut'

// Plan 174 S3.9 (D15): ⌘Z undoes the last layout change on the Scene page,
// and only there, never inside a text field or over an open dialog.

const press = (
  overrides: Partial<Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>>
) => ({ key: 'z', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides })

const keydown = (target: EventTarget | null, overrides: Partial<KeyboardEvent> = {}) => ({
  repeat: false,
  defaultPrevented: false,
  target,
  ...overrides
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the layout undo chord', () => {
  it('is the platform command key with Z and nothing else', () => {
    expect(isLayoutUndoShortcut(press({ metaKey: true }), 'darwin')).toBe(true)
    expect(isLayoutUndoShortcut(press({ key: 'Z', metaKey: true }), 'darwin')).toBe(true)
    expect(isLayoutUndoShortcut(press({ ctrlKey: true }), 'win32')).toBe(true)
    expect(isLayoutUndoShortcut(press({ ctrlKey: true }), 'linux')).toBe(true)
    // Ctrl alone is not the command key on a Mac, and Meta is not on Windows.
    expect(isLayoutUndoShortcut(press({ ctrlKey: true }), 'darwin')).toBe(false)
    expect(isLayoutUndoShortcut(press({ metaKey: true }), 'win32')).toBe(false)
    // Redo and option chords belong to someone else, as does a bare Z.
    expect(isLayoutUndoShortcut(press({ metaKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isLayoutUndoShortcut(press({ metaKey: true, altKey: true }), 'darwin')).toBe(false)
    expect(isLayoutUndoShortcut(press({}), 'darwin')).toBe(false)
    expect(isLayoutUndoShortcut(press({ key: 'y', ctrlKey: true }), 'win32')).toBe(false)
  })
})

describe('what blocks the layout undo', () => {
  it('yields to text fields, so the native undo keeps working there', () => {
    document.body.innerHTML = `
      <input id="name" />
      <textarea id="notes"></textarea>
      <div id="editor" contenteditable="true"></div>
      <button id="plain">Save scene</button>
      <div id="page"></div>
    `
    const byId = (id: string) => document.getElementById(id)
    expect(layoutUndoShortcutBlocked(keydown(byId('name')), document)).toBe(true)
    expect(layoutUndoShortcutBlocked(keydown(byId('notes')), document)).toBe(true)
    expect(layoutUndoShortcutBlocked(keydown(byId('editor')), document)).toBe(true)
    // A button or the page itself does not edit text: the undo runs.
    expect(layoutUndoShortcutBlocked(keydown(byId('plain')), document)).toBe(false)
    expect(layoutUndoShortcutBlocked(keydown(byId('page')), document)).toBe(false)
    expect(layoutUndoShortcutBlocked(keydown(document.body), document)).toBe(false)
  })

  it('yields to an open dialog or menu and to a stage gesture in flight', () => {
    document.body.innerHTML = `<div id="page"></div>`
    const page = document.getElementById('page')
    expect(layoutUndoShortcutBlocked(keydown(page), document)).toBe(false)
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" data-open></div>')
    expect(layoutUndoShortcutBlocked(keydown(page), document)).toBe(true)
    document.body.innerHTML = `<div id="page"></div><div data-videorc-stage-phase="pending"></div>`
    expect(layoutUndoShortcutBlocked(keydown(document.getElementById('page')), document)).toBe(true)
    document.body.innerHTML = `<div id="page"></div><div data-videorc-stage-phase="idle"></div>`
    expect(layoutUndoShortcutBlocked(keydown(document.getElementById('page')), document)).toBe(
      false
    )
  })

  it('ignores repeats and presses something else already handled', () => {
    document.body.innerHTML = `<div id="page"></div>`
    const page = document.getElementById('page')
    expect(layoutUndoShortcutBlocked(keydown(page, { repeat: true }), document)).toBe(true)
    expect(layoutUndoShortcutBlocked(keydown(page, { defaultPrevented: true }), document)).toBe(
      true
    )
  })
})
