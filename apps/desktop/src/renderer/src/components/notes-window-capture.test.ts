// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotesWindowState } from '@/lib/backend'

import { NotesWindow } from './notes-window'

// Plan 174 I-2: Notes says when it is hidden from capture, and says loudly
// when main could not hide it, instead of only logging the failure.

let root: Root
let container: HTMLDivElement
let pushState: ((state: NotesWindowState) => void) | null = null

function windowState(overrides: Partial<NotesWindowState> = {}): NotesWindowState {
  return {
    open: true,
    visible: true,
    bounds: null,
    alwaysOnTop: false,
    protected: true,
    enabled: true,
    ...overrides
  }
}

async function mount(initial: NotesWindowState | null): Promise<void> {
  Object.assign(window, {
    videorc: {
      getNotesDocument: async () => ({ text: '', fontScale: 'md', updatedAt: '' }),
      getNotesWindowState: async () => initial,
      onNotesWindowState: (callback: (state: NotesWindowState) => void) => {
        pushState = callback
        return () => {
          pushState = null
        }
      },
      onNotesFlushRequest: () => () => undefined,
      saveNotesDocument: async () => undefined
    }
  })
  await act(async () => root.render(createElement(NotesWindow)))
}

const hiddenNote = (): Element | null =>
  container.querySelector('[data-testid="notes-capture-hidden"]')
const exposedAlert = (): Element | null =>
  container.querySelector('[data-testid="notes-capture-exposed"]')

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
  pushState = null
  vi.unstubAllGlobals()
})

describe('Notes capture protection', () => {
  it('says the notes are hidden from recordings and streams when main protected the window', async () => {
    await mount(windowState({ protected: true }))

    expect(hiddenNote()?.textContent).toBe('Hidden from recordings and streams')
    expect(hiddenNote()?.closest('footer')).not.toBeNull()
    expect(exposedAlert()).toBeNull()
  })

  it('warns in a destructive alert when protection failed', async () => {
    await mount(windowState({ protected: false }))

    const alert = exposedAlert()
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toContain('These notes can appear in your recording')
    expect(alert?.textContent).toContain("Videorc couldn't hide this window from screen capture.")
    expect(alert?.className).toContain('bg-destructive/10')
    expect(hiddenNote()).toBeNull()
  })

  it('follows main when the protection state changes while the window is open', async () => {
    await mount(windowState({ protected: true }))
    expect(exposedAlert()).toBeNull()

    await act(async () => pushState?.(windowState({ protected: false })))
    expect(exposedAlert()).not.toBeNull()
    expect(hiddenNote()).toBeNull()

    await act(async () => pushState?.(windowState({ protected: true })))
    expect(exposedAlert()).toBeNull()
    expect(hiddenNote()).not.toBeNull()
  })

  it('claims nothing before main has reported', async () => {
    await mount(null)

    expect(hiddenNote()).toBeNull()
    expect(exposedAlert()).toBeNull()
  })
})
