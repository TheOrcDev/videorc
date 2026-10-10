// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BuddyConsentDialog } from '@/components/buddy-consent-dialog'
import { CLOUD_AI_KEEPS, CLOUD_AI_USES } from '@/lib/buddy-tab-view'

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

async function render(open: boolean, onAnswer: (accepted: boolean) => void): Promise<void> {
  await act(async () => root.render(createElement(BuddyConsentDialog, { open, onAnswer })))
}

const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]')

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(found).toBeTruthy()
  return found!
}

describe('BuddyConsentDialog (plan 119 decision 3, plan 174 S0.2)', () => {
  it('stays closed until asked', async () => {
    await render(false, vi.fn())
    expect(dialog()).toBeNull()
  })

  it('names every cloud use and what is kept, under the emblem', async () => {
    await render(true, vi.fn())
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Turn on Buddy Live?')
    for (const use of CLOUD_AI_USES) expect(text).toContain(use)
    expect(text).toContain(CLOUD_AI_KEEPS)
    expect(dialog()?.querySelector('[data-slot="buddy-emblem"]')).toBeTruthy()
  })

  it('answers Allow with true and Not now with false', async () => {
    const onAnswer = vi.fn()
    await render(true, onAnswer)
    await act(async () => button('Allow and turn on').click())
    expect(onAnswer).toHaveBeenLastCalledWith(true)
    await act(async () => button('Not now').click())
    expect(onAnswer).toHaveBeenLastCalledWith(false)
    expect(onAnswer).toHaveBeenCalledTimes(2)
  })
})
