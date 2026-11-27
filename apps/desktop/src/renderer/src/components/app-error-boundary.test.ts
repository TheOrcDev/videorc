// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppErrorBoundary } from './app-error-boundary'

// The last fallback of all: the root panel's own chunk failed, so one bare
// reload button remains. It is a real button, not an underlined word (owner,
// 11-27), and it needs no provider: nothing above it survived.

vi.mock('@/components/root-error-panel', () => ({
  RootErrorPanel: (): ReactElement => {
    throw new Error('panel chunk failed')
  }
}))

let root: Root
let container: HTMLDivElement

function Page(): ReactElement {
  throw new Error('boom')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AppErrorBoundary, when the root panel fails too', () => {
  it('leaves one Reload Videorc button, drawn as a button', async () => {
    await act(async () => root.render(createElement(AppErrorBoundary, null, createElement(Page))))
    for (let tick = 0; tick < 200 && !container.querySelector('[role="alert"]'); tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((entry) => entry.textContent?.trim())).toEqual(['Reload Videorc'])
    expect(buttons[0].dataset.variant).toBe('outline')
    expect(buttons[0].dataset.slot).toBe('button')
    expect(buttons[0].className).not.toContain('underline')
  })
})
