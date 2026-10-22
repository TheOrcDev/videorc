// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PIN_WINDOW_LABEL, PinWindowButton } from './pin-window-button'

// Plan 174 S1.6b (D-PAT, I-29): one Keep on top control, four windows.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function button(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid=pin-window-button]')
}

describe('PinWindowButton', () => {
  it('has one name in every window, and says whether the window is kept on top', () => {
    expect(PIN_WINDOW_LABEL).toBe('Keep on top')
    act(() =>
      root.render(createElement(PinWindowButton, { pinned: false, onPinnedChange: vi.fn() }))
    )
    expect(button()?.getAttribute('aria-label')).toBe('Keep on top')
    expect(button()?.getAttribute('aria-pressed')).toBe('false')
    expect(button()?.className).toContain('[-webkit-app-region:no-drag]')
    act(() =>
      root.render(createElement(PinWindowButton, { pinned: true, onPinnedChange: vi.fn() }))
    )
    expect(button()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('asks for the other state on a click', () => {
    const onPinnedChange = vi.fn()
    act(() => root.render(createElement(PinWindowButton, { pinned: false, onPinnedChange })))
    act(() => button()?.click())
    expect(onPinnedChange).toHaveBeenCalledWith(true)
  })

  it('becomes a status-bar action where the title row stays bare (Stream Manager)', () => {
    const onPinnedChange = vi.fn()
    act(() =>
      root.render(
        createElement(PinWindowButton, { pinned: true, variant: 'status-bar', onPinnedChange })
      )
    )
    expect(button()?.getAttribute('data-slot')).toBe('status-bar-action')
    expect(button()?.getAttribute('aria-label')).toBe('Keep on top')
    expect(button()?.getAttribute('aria-pressed')).toBe('true')
    // The tooltip names it; no second, native hover text.
    expect(button()?.hasAttribute('title')).toBe(false)
    act(() => button()?.click())
    expect(onPinnedChange).toHaveBeenCalledWith(false)
  })
})
