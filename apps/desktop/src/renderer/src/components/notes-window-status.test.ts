// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotesWindow } from './notes-window'

// Plan 174 S3.19 (I-24, J2-18): the footer's save word is visual only; a
// failed save gets its own status line with Retry, and a pin that didn't
// take says so beside the pin.

let root: Root
let container: HTMLDivElement

async function mount(api: Record<string, unknown>): Promise<void> {
  Object.assign(window, {
    videorc: {
      getNotesDocument: async () => ({ text: 'intro', fontScale: 'md', updatedAt: '' }),
      getNotesWindowState: async () => null,
      onNotesWindowState: () => () => undefined,
      onNotesFlushRequest: () => () => undefined,
      saveNotesDocument: async () => undefined,
      ...api
    }
  })
  await act(async () => root.render(createElement(NotesWindow)))
}

const byTestId = (id: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text)
const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!

async function blurNotes(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('Notes save and pin feedback', () => {
  it('says a failed save once, with Retry, and clears it when the retry saves', async () => {
    const saveNotesDocument = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)
    await mount({ saveNotesDocument })
    const failure = byTestId('notes-save-failure')
    expect(failure.getAttribute('role')).toBe('status')
    expect(failure.textContent).toBe('')

    await blurNotes()
    expect(failure.textContent).toContain("Couldn't save your notes. Your text is still here.")
    expect(byTestId('notes-save-state').textContent).toBe('Not saved')
    // The save word is never a live region (I-24).
    expect(byTestId('notes-save-state').closest('[aria-live]')).toBeNull()

    await act(async () => button('Retry')!.click())
    expect(saveNotesDocument).toHaveBeenCalledTimes(2)
    expect(failure.textContent).toBe('')
    expect(byTestId('notes-save-state').textContent).toBe('Saved')
  })

  it('never saves over notes it could not read, and Retry loads them (QA F9)', async () => {
    let flush: (() => void) | undefined
    const getNotesDocument = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('EIO'))
      .mockResolvedValue({ text: 'Existing notes', fontScale: 'lg', updatedAt: '' })
    const saveNotesDocument = vi
      .fn<(patch: unknown) => Promise<void>>()
      .mockResolvedValue(undefined)
    await mount({
      getNotesDocument,
      saveNotesDocument,
      onNotesFlushRequest: (callback: () => void) => {
        flush = callback
        return () => undefined
      }
    })
    const failure = byTestId('notes-load-failure')
    expect(failure.getAttribute('role')).toBe('status')
    expect(failure.textContent).toContain("Couldn't open your notes. Nothing was changed.")
    expect(textarea().readOnly).toBe(true)
    // Never "Saved" for notes that are not here.
    expect(container.querySelector('[data-testid="notes-save-state"]')).toBeNull()

    // Blur, a text-size pick and the close flush must not save the blank text.
    await blurNotes()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Small text"]')!.click()
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    await act(async () => flush!())
    expect(saveNotesDocument.mock.calls).toEqual([[{}]])

    await act(async () => button('Retry')!.click())
    expect(failure.textContent).toBe('')
    expect(textarea().value).toBe('Existing notes')
    expect(textarea().readOnly).toBe(false)
    expect(byTestId('notes-save-state').textContent).toBe('Saved')

    await act(async () => flush!())
    expect(saveNotesDocument).toHaveBeenLastCalledWith({ text: 'Existing notes', fontScale: 'lg' })
  })

  it('says Not saved when main reports a failed write (QA F9)', async () => {
    const saveNotesDocument = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('ENOSPC'))
    await mount({ saveNotesDocument })
    await blurNotes()
    expect(byTestId('notes-save-state').textContent).toBe('Not saved')
    expect(byTestId('notes-save-failure').textContent).toContain("Couldn't save your notes.")
  })

  it('says beside the pin when keep-on-top fails, and clears it on the next try', async () => {
    const setNotesWindowAlwaysOnTop = vi
      .fn<(pinned: boolean) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValue({ alwaysOnTop: true })
    await mount({ setNotesWindowAlwaysOnTop })
    const pin = container.querySelector<HTMLButtonElement>('[data-testid="pin-window-button"]')!
    const pinError = byTestId('notes-pin-error')
    expect(pinError.getAttribute('role')).toBe('status')
    // Beside the pin, in the footer.
    expect(pinError.nextElementSibling).toBe(pin)

    await act(async () => pin.click())
    expect(pinError.textContent).toBe("Couldn't keep on top")
    expect(pin.getAttribute('aria-pressed')).toBe('false')

    await act(async () => pin.click())
    expect(pinError.textContent).toBe('')
    expect(pin.getAttribute('aria-pressed')).toBe('true')
  })

  it('says keep-on-top is not available when main offers no pin', async () => {
    await mount({ setNotesWindowAlwaysOnTop: undefined })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="pin-window-button"]')!.click()
    )
    expect(byTestId('notes-pin-error').textContent).toBe("Keep on top isn't available")
  })
})
