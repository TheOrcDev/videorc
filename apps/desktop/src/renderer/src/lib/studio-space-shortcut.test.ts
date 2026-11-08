// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { spaceShortcutBlocked } from './studio-space-shortcut'

type Press = Parameters<typeof spaceShortcutBlocked>[0]

function press(target: EventTarget | null, init: Partial<Press> = {}): Press {
  return {
    repeat: false,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target,
    ...init
  }
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('spaceShortcutBlocked (plan 174 S0.1, A-1)', () => {
  it('lets a plain press on the page body through', () => {
    expect(spaceShortcutBlocked(press(document.body), document)).toBe(false)
    expect(spaceShortcutBlocked(press(null), document)).toBe(false)
  })

  it('yields to a repeat, a handled press, and modified presses', () => {
    expect(spaceShortcutBlocked(press(document.body, { repeat: true }), document)).toBe(true)
    expect(spaceShortcutBlocked(press(document.body, { defaultPrevented: true }), document)).toBe(
      true
    )
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      expect(spaceShortcutBlocked(press(document.body, { [modifier]: true }), document)).toBe(true)
    }
  })

  it('yields to a focused slider thumb, switch, tab, menu item and other widgets', () => {
    const host = mount(`
      <span role="slider" tabindex="0"><span data-thumb></span></span>
      <button role="switch" aria-checked="false"><span data-switch-thumb></span></button>
      <div role="tablist"><button role="tab">Live</button></div>
      <div role="menuitem">Open</div>
      <div role="option">Camera</div>
      <div role="checkbox"></div>
      <div role="radio"></div>
      <a href="#x"><span data-link-text>Docs</span></a>
      <div class="row" tabindex="0"><span data-row-text>Row</span></div>
      <div contenteditable="true"><span data-editable-text>Note</span></div>
      <input />
      <textarea></textarea>
      <select><option>a</option></select>
    `)
    for (const selector of [
      '[data-thumb]',
      '[data-switch-thumb]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[data-link-text]',
      '[data-row-text]',
      '[data-editable-text]',
      'input',
      'textarea',
      'select'
    ]) {
      const target = host.querySelector(selector)
      expect(target, selector).not.toBeNull()
      expect(spaceShortcutBlocked(press(target), document), selector).toBe(true)
    }
  })

  it('yields to a target inside a dialog body, and to any open dialog, menu or list', () => {
    const host = mount(`
      <div role="dialog" data-open><p data-dialog-text>Confirm Go Live</p></div>
    `)
    expect(spaceShortcutBlocked(press(host.querySelector('[data-dialog-text]')), document)).toBe(
      true
    )
    // The focus may sit on the body while a dialog is open: still blocked.
    expect(spaceShortcutBlocked(press(document.body), document)).toBe(true)

    document.body.innerHTML = ''
    mount('<div role="menu" data-open><div role="menuitem">Rename</div></div>')
    expect(spaceShortcutBlocked(press(document.body), document)).toBe(true)

    document.body.innerHTML = ''
    mount('<div role="listbox"><div role="option">1080p</div></div>')
    expect(spaceShortcutBlocked(press(document.body), document)).toBe(true)

    document.body.innerHTML = ''
    mount('<div data-videorc-stage-phase="dragging"></div>')
    expect(spaceShortcutBlocked(press(document.body), document)).toBe(true)
  })

  it('ignores a closed dialog and an unfocusable row', () => {
    const host = mount(`
      <div role="dialog" data-closed></div>
      <div tabindex="-1"><span data-inert-text>Inert</span></div>
      <p><span data-plain-text>Plain</span></p>
    `)
    expect(spaceShortcutBlocked(press(host.querySelector('[data-inert-text]')), document)).toBe(
      false
    )
    expect(spaceShortcutBlocked(press(host.querySelector('[data-plain-text]')), document)).toBe(
      false
    )
  })
})
