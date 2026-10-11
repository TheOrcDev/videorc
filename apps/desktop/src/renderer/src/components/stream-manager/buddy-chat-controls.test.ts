// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostAutoChat, CohostAutoChatRelayPatch } from '@/lib/backend'
import {
  BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY,
  BUDDY_AUTO_CONFIRM_SENTENCE,
  buddyPostingConsentSentence
} from '@/lib/buddy-auto-chat-view'

import { TooltipProvider } from '@/components/ui/tooltip'

import { BuddyChatControls } from './buddy-chat-controls'

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

/** The disabled reason a switch's focusable wrapper describes, or null when it has none. */
function reasonFor(id: string): string | null {
  const wrapper = document.getElementById(id)?.closest<HTMLElement>('[data-slot="disabled-reason"]')
  if (!wrapper) return null
  expect(wrapper.tabIndex).toBe(0)
  return (
    document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent ?? null
  )
}

async function render(
  current: CohostAutoChat,
  {
    allowed = true,
    consented = true,
    name
  }: { allowed?: boolean; consented?: boolean; name?: string } = {}
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(BuddyChatControls, {
          autoChat: current,
          consented,
          gate: allowed
            ? { allowed: true }
            : {
                allowed: false,
                featureId: 'live-cohost',
                reason: 'Buddy requires Videorc Premium.'
              },
          name,
          onChange
        })
      )
    )
  )
}

function modeButton(mode: string): HTMLButtonElement {
  const button = document.querySelector(`[data-buddy-mode="${mode}"]`) as HTMLButtonElement | null
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

describe('Buddy chat mode (plan 164 S-D6)', () => {
  it('asks for consent the first time, lands in Suggest, and remembers it', async () => {
    await render(autoChat())
    await press(modeButton('suggest'))
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('Let Buddy post as you?')
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence(null))
    await act(async () => dialogButton('buddy-chat-accept').click())
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'suggest' })
    expect(dialog()).toBeNull()
    expect(localStorage.getItem(BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY)).toBe('1')
  })

  it('never reaches Auto without the second explicit click', async () => {
    await render(autoChat())
    await press(modeButton('auto'))
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence(null))
    await act(async () => dialogButton('buddy-chat-accept').click())
    // Consent lands in Suggest; Auto still waits for its own sentence.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'suggest' })
    expect(dialog()?.textContent).toContain(BUDDY_AUTO_CONFIRM_SENTENCE)
    await act(async () => dialogButton('buddy-chat-confirm-auto').click())
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'auto' })
    expect(dialog()).toBeNull()

    // Consented already: Auto still asks, every time; Not now changes nothing.
    onChange.mockClear()
    await render(autoChat({ mode: 'suggest' }))
    await press(modeButton('auto'))
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain(BUDDY_AUTO_CONFIRM_SENTENCE)
    const notNow = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Not now'
    )
    await act(async () => notNow?.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })

  it("asks in the streamer's name for Buddy, and names the control Chat posting (plan 174 J2-20)", async () => {
    await render(autoChat(), { name: 'Grum' })
    expect(
      container.querySelector('[aria-label="Chat posting"]') ??
        document.querySelector('[aria-label="Chat posting"]')
    ).toBeTruthy()
    await press(modeButton('suggest'))
    expect(dialog()?.textContent).toContain('Let Grum post as you?')
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence('Grum'))
    expect(dialog()?.textContent).not.toMatch(/the Buddy/i)
  })

  it('turns Off without asking, and the switches write their one field', async () => {
    await render(autoChat({ mode: 'auto' }))
    await press(modeButton('off'))
    expect(dialog()).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'off' })
    const greetings = document.getElementById('buddy-greetings') as HTMLButtonElement
    await act(async () => greetings.click())
    expect(onChange).toHaveBeenLastCalledWith({ greetings: true })
  })

  it('keeps Greetings free and locks Answers and Banter behind Premium and cloud AI', async () => {
    await render(autoChat(), { allowed: false })
    expect((document.getElementById('buddy-greetings') as HTMLButtonElement).disabled).toBe(false)
    expect((document.getElementById('buddy-answers') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('buddy-banter') as HTMLButtonElement).disabled).toBe(true)
    // Plan 174 F-12: the reason is a focusable, described wrapper, not a title.
    expect(reasonFor('buddy-answers')).toBe('Buddy requires Videorc Premium.')
    expect(reasonFor('buddy-greetings')).toBeNull()
    await render(autoChat(), { consented: false })
    expect((document.getElementById('buddy-answers') as HTMLButtonElement).disabled).toBe(true)
    expect(reasonFor('buddy-banter')).toBe('Needs cloud AI.')
    await render(autoChat())
    expect((document.getElementById('buddy-answers') as HTMLButtonElement).disabled).toBe(false)
    expect(reasonFor('buddy-answers')).toBeNull()
  })
})
