// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CohostListenPrompt } from '@/components/cohost-pane'
import { COHOST_LISTEN_PROMPT_STORAGE_KEY } from '@/lib/cohost-view'
import { uiSettingsStorage } from '@/lib/ui-settings-storage'

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
  vi.unstubAllGlobals()
})

async function render(onTurnOn: () => void, listen: boolean | undefined = false): Promise<void> {
  await act(async () =>
    root.render(createElement(CohostListenPrompt, { enabled: true, listen, onTurnOn }))
  )
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  )
  expect(found).toBeTruthy()
  return found!
}

const prompt = (): Element | null => container.querySelector('[data-slot="cohost-listen-prompt"]')

describe('CohostListenPrompt', () => {
  it('Turn on sets listening and never asks again', async () => {
    const onTurnOn = vi.fn()
    await render(onTurnOn)
    expect(prompt()).not.toBeNull()
    await act(async () => button('Turn on').click())
    expect(onTurnOn).toHaveBeenCalledTimes(1)
    expect(prompt()).toBeNull()
    expect(uiSettingsStorage().getItem(COHOST_LISTEN_PROMPT_STORAGE_KEY)).toBe('1')
  })

  it('Not now is final too, across a remount', async () => {
    const onTurnOn = vi.fn()
    await render(onTurnOn)
    // The second answer is a button too, not ghost text (owner, 11-27).
    expect(button('Not now').dataset.variant).toBe('outline')
    await act(async () => button('Not now').click())
    expect(onTurnOn).not.toHaveBeenCalled()
    expect(prompt()).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    await render(onTurnOn)
    expect(prompt()).toBeNull()
  })

  it('still answers once when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      await render(vi.fn())
      expect(prompt()).not.toBeNull()
      await act(async () => button('Not now').click())
      expect(prompt()).toBeNull()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('hides while listening is already on', async () => {
    await render(vi.fn(), true)
    expect(prompt()).toBeNull()
  })
})
