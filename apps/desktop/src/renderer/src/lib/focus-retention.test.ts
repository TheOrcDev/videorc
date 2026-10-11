// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { rememberFocus } from './focus-retention'

// Plan 174 S3.9 (C-5): a committed edit never costs the keyboard its place.

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(markup: string): void {
  document.body.innerHTML = markup
}

describe('rememberFocus', () => {
  it('gives focus back to the control when the commit dropped it to the body', () => {
    mount('<button id="nudge">Nudge source up</button>')
    const button = document.getElementById('nudge')!
    button.focus()
    const restore = rememberFocus(document)
    // What a disabled-then-enabled or re-rendered control does to focus.
    button.blur()
    expect(document.activeElement).toBe(document.body)
    restore()
    expect(document.activeElement).toBe(button)
  })

  it('never pulls focus back from a control the streamer moved to', () => {
    mount('<input id="x" /><input id="y" />')
    const x = document.getElementById('x')!
    const y = document.getElementById('y')!
    x.focus()
    const restore = rememberFocus(document)
    y.focus()
    restore()
    expect(document.activeElement).toBe(y)
  })

  it('leaves a control alone once it is gone, disabled or inert', () => {
    mount('<fieldset id="set"><button id="reset">Reset</button></fieldset>')
    const reset = document.getElementById('reset') as HTMLButtonElement
    reset.focus()
    let restore = rememberFocus(document)
    reset.blur()
    reset.disabled = true
    restore()
    expect(document.activeElement).toBe(document.body)

    reset.disabled = false
    reset.focus()
    restore = rememberFocus(document)
    reset.blur()
    document.getElementById('set')!.setAttribute('inert', '')
    restore()
    expect(document.activeElement).toBe(document.body)

    document.getElementById('set')!.removeAttribute('inert')
    reset.focus()
    restore = rememberFocus(document)
    reset.remove()
    expect(() => restore()).not.toThrow()
    expect(document.activeElement).toBe(document.body)
  })

  it('does nothing when nothing was focused to begin with', () => {
    mount('<button id="a">A</button>')
    expect(document.activeElement).toBe(document.body)
    const restore = rememberFocus(document)
    restore()
    expect(document.activeElement).toBe(document.body)
  })
})
