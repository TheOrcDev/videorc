// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { isModalOpen } from './modal-open'

function mount(html: string): void {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isModalOpen (plan 174 S3.21, A-2)', () => {
  it('is false on a plain page', () => {
    mount('<main><button type="button">Record</button></main>')
    expect(isModalOpen(document)).toBe(false)
  })

  it('is true while a dialog, an alert, a menu or a select is open', () => {
    for (const html of [
      '<div role="dialog" data-state="open">Schedule</div>',
      '<div role="alertdialog" data-state="open">End livestream?</div>',
      '<div role="menu" data-state="open"><div role="menuitem">Rename</div></div>',
      '<div role="listbox" data-state="open"><div role="option">1080p</div></div>'
    ]) {
      document.body.innerHTML = ''
      mount(html)
      expect(isModalOpen(document), html).toBe(true)
    }
  })

  it('ignores a closed dialog and a list that is part of the page', () => {
    mount(`
      <div role="dialog" data-state="closed">Gone</div>
      <div role="listbox"><div role="option">Row</div></div>
    `)
    expect(isModalOpen(document)).toBe(false)
  })
})
