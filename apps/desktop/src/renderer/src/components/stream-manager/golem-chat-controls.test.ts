// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostAutoChat, CohostAutoChatRelayPatch } from '@/lib/backend'
import {
  GOLEM_AUTO_CHAT_CONSENT_STORAGE_KEY,
  GOLEM_AUTO_CONFIRM_SENTENCE,
  GOLEM_CONSENT_SENTENCE
} from '@/lib/golem-auto-chat-view'

import { GolemChatControls } from './golem-chat-controls'

let root: Root
let container: HTMLDivElement
let onChange: ReturnType<typeof vi.fn<(patch: CohostAutoChatRelayPatch) => void>>

function autoChat(overrides: Partial<CohostAutoChat> = {}): CohostAutoChat {
  return {
    mode: 'off',
    greetings: { enabled: false, templates: [] },
    answers: { enabled: false, cooldownSeconds: 20 },
    banter: { enabled: false, cooldownSeconds: 240 },
    ...overrides
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onChange = vi.fn()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(
  current: CohostAutoChat,
  { allowed = true, consented = true }: { allowed?: boolean; consented?: boolean } = {}
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(GolemChatControls, {
        autoChat: current,
        consented,
        gate: allowed
          ? { allowed: true }
          : { allowed: false, featureId: 'live-cohost', reason: 'Golem requires Videorc Premium.' },
        onChange
      })
    )
  )
}

function modeButton(mode: string): HTMLButtonElement {
  const button = document.querySelector(`[data-golem-mode="${mode}"]`) as HTMLButtonElement | null
  expect(button).toBeTruthy()
  return button!
}

/** Radix toggles on mousedown with the primary button. */
async function press(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    button.click()
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]')
}

function dialogButton(testId: string): HTMLButtonElement {
  const button = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null
  expect(button).toBeTruthy()
  return button!
}

describe('Golem chat mode (plan 164 S-D6)', () => {
  it('asks for consent the first time, lands in Suggest, and remembers it', async () => {
    await render(autoChat())
    await press(modeButton('suggest'))
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain(GOLEM_CONSENT_SENTENCE)
    await act(async () => dialogButton('golem-chat-accept').click())
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'suggest' })
    expect(dialog()).toBeNull()
    expect(localStorage.getItem(GOLEM_AUTO_CHAT_CONSENT_STORAGE_KEY)).toBe('1')
  })

  it('never reaches Auto without the second explicit click', async () => {
    await render(autoChat())
    await press(modeButton('auto'))
    expect(dialog()?.textContent).toContain(GOLEM_CONSENT_SENTENCE)
    await act(async () => dialogButton('golem-chat-accept').click())
    // Consent lands in Suggest; Auto still waits for its own sentence.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'suggest' })
    expect(dialog()?.textContent).toContain(GOLEM_AUTO_CONFIRM_SENTENCE)
    await act(async () => dialogButton('golem-chat-confirm-auto').click())
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'auto' })
    expect(dialog()).toBeNull()

    // Consented already: Auto still asks, every time; Not now changes nothing.
    onChange.mockClear()
    await render(autoChat({ mode: 'suggest' }))
    await press(modeButton('auto'))
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain(GOLEM_AUTO_CONFIRM_SENTENCE)
    const notNow = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Not now'
    )
    await act(async () => notNow?.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })

  it('turns Off without asking, and the switches write their one field', async () => {
    await render(autoChat({ mode: 'auto' }))
    await press(modeButton('off'))
    expect(dialog()).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'off' })
    const greetings = document.getElementById('golem-greetings') as HTMLButtonElement
    await act(async () => greetings.click())
    expect(onChange).toHaveBeenLastCalledWith({ greetings: true })
  })

  it('keeps Greetings free and locks Answers and Banter behind Premium and cloud AI', async () => {
    await render(autoChat(), { allowed: false })
    expect((document.getElementById('golem-greetings') as HTMLButtonElement).disabled).toBe(false)
    expect((document.getElementById('golem-answers') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('golem-banter') as HTMLButtonElement).disabled).toBe(true)
    await render(autoChat(), { consented: false })
    expect((document.getElementById('golem-answers') as HTMLButtonElement).disabled).toBe(true)
    await render(autoChat())
    expect((document.getElementById('golem-answers') as HTMLButtonElement).disabled).toBe(false)
  })
})
