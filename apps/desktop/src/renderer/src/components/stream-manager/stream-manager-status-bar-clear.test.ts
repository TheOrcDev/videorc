// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamManagerStatusBar } from './stream-manager-status-bar'

// Plan 174 S0.3 (H-6): Clear empties chat and Activity for the window and
// cannot be undone, so it asks first.

let root: Root
let container: HTMLDivElement

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

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('StreamManagerStatusBar Clear', () => {
  it('asks before clearing the view, and clears only on confirm', async () => {
    const onClear = vi.fn()
    await act(async () =>
      root.render(
        createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false,
          onClear
        })
      )
    )
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Clear view"]')!
    expect(trigger).not.toBeNull()
    await act(async () => trigger.click())
    const dialog = byTestId('stream-manager-clear-dialog')
    expect(dialog?.textContent).toContain('Clear the view?')
    expect(dialog?.textContent).toContain('The Library keeps the history.')
    await act(async () => byTestId('stream-manager-clear-cancel')!.click())
    expect(onClear).not.toHaveBeenCalled()
    await act(async () => trigger.click())
    await act(async () => byTestId('stream-manager-clear-confirm')!.click())
    expect(onClear).toHaveBeenCalledOnce()
    expect(byTestId('stream-manager-clear-dialog')).toBeNull()
  })
})
