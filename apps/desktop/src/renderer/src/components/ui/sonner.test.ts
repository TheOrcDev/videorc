// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster } from './sonner'

// Memory-leak finding L1 (2026-11-18): sonner 2.0.7 added a `visibilitychange`
// listener to `document` for every toast and "removed" it from `window`, so
// every toast ever shown left one listener (and its state hook) behind for the
// life of the window. sonner 2.0.8 removes from `document`. This pins the
// pairing so a downgrade or a bad patch fails here instead of in a long session.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Toaster visibilitychange listeners', () => {
  it('leaves no visibilitychange listener on document once its toasts unmount', async () => {
    const live = new Set<EventListenerOrEventListenerObject>()
    const add = document.addEventListener.bind(document)
    const remove = document.removeEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type === 'visibilitychange') live.add(listener)
        return add(type, listener, options as AddEventListenerOptions)
      }
    )
    vi.spyOn(document, 'removeEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type === 'visibilitychange') live.delete(listener)
        return remove(type, listener, options as EventListenerOptions)
      }
    )

    act(() => root.render(createElement(Toaster)))
    await act(async () => {
      toast('Recording saved', { id: 'l1-a', duration: Infinity })
      toast('Clip saved', { id: 'l1-b', duration: Infinity })
      toast('Chat send failed', { id: 'l1-c', duration: Infinity })
      await new Promise((r) => setTimeout(r, 50))
    })

    // Every mounted toast listens (sonner may add one per toast or share one;
    // either way something is listening while they are on screen).
    expect(live.size).toBeGreaterThan(0)

    act(() => root.unmount())

    expect([...live]).toEqual([])
  })
})
