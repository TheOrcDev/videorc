// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostAutoChat, CohostAutoChatMode } from '@/lib/backend'
import {
  BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY,
  BUDDY_AUTO_CONFIRM_SENTENCE,
  BUDDY_MODE_HINTS,
  buddyPostingConsentSentence
} from '@/lib/buddy-auto-chat-view'

import { TooltipProvider } from '@/components/ui/tooltip'

import { BuddyChatControls } from './buddy-chat-controls'

let root: Root
let container: HTMLDivElement
let onModeChange: ReturnType<typeof vi.fn<(mode: CohostAutoChatMode) => void>>
let onOpenChatSettings: ReturnType<typeof vi.fn<() => void>>

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
  onModeChange = vi.fn()
  onOpenChatSettings = vi.fn()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(
  current: CohostAutoChat,
  { name, link = true }: { name?: string; link?: boolean } = {}
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(BuddyChatControls, {
          autoChat: current,
          name,
          onModeChange,
          ...(link ? { onOpenChatSettings } : {})
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

function chips(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-behaviour-chip"]')]
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

describe('Buddy chat posting (plan 164 S-D6, plan 174 S3.14a)', () => {
  it('asks for consent the first time, lands in Suggest, and remembers it', async () => {
    await render(autoChat())
    await press(modeButton('suggest'))
    expect(onModeChange).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('Let Buddy post as you?')
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence(null))
    await act(async () => dialogButton('buddy-chat-accept').click())
    expect(onModeChange).toHaveBeenLastCalledWith('suggest')
    expect(dialog()).toBeNull()
    expect(localStorage.getItem(BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY)).toBe('1')
  })

  it('never reaches Auto without the second explicit click', async () => {
    await render(autoChat())
    await press(modeButton('auto'))
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence(null))
    await act(async () => dialogButton('buddy-chat-accept').click())
    // Consent lands in Suggest; Auto still waits for its own sentence.
    expect(onModeChange).toHaveBeenCalledTimes(1)
    expect(onModeChange).toHaveBeenLastCalledWith('suggest')
    expect(dialog()?.textContent).toContain(BUDDY_AUTO_CONFIRM_SENTENCE)
    await act(async () => dialogButton('buddy-chat-confirm-auto').click())
    expect(onModeChange).toHaveBeenLastCalledWith('auto')
    expect(dialog()).toBeNull()

    // Consented already: Auto still asks, every time; Not now changes nothing.
    onModeChange.mockClear()
    await render(autoChat({ mode: 'suggest' }))
    await press(modeButton('auto'))
    expect(onModeChange).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain(BUDDY_AUTO_CONFIRM_SENTENCE)
    const notNow = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Not now'
    )
    await act(async () => notNow?.click())
    expect(onModeChange).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })

  it("asks in the streamer's name for Buddy, and names the control Chat posting (plan 174 J2-20)", async () => {
    await render(autoChat(), { name: 'Grum' })
    const control = document.querySelector('[aria-labelledby="buddy-chat-posting-label"]')
    expect(control).toBeTruthy()
    expect(document.getElementById('buddy-chat-posting-label')?.textContent).toBe('Chat posting')
    await press(modeButton('suggest'))
    expect(dialog()?.textContent).toContain('Let Grum post as you?')
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence('Grum'))
    expect(dialog()?.textContent).not.toMatch(/the Buddy/i)
  })

  it('turns Off without asking, and Off only stops posting (D7)', async () => {
    await render(autoChat({ mode: 'auto' }))
    await press(modeButton('off'))
    expect(dialog()).toBeNull()
    expect(onModeChange).toHaveBeenLastCalledWith('off')
    // The mode's meaning is a visible line, never a title (plan 174 F-12).
    expect(document.querySelector('[data-slot="buddy-mode-hint"]')?.textContent).toBe(
      BUDDY_MODE_HINTS.auto
    )
    expect(document.querySelector('[data-buddy-mode][title]')).toBeNull()
    await render(autoChat({ mode: 'off' }))
    expect(document.querySelector('[data-slot="buddy-mode-hint"]')?.textContent).toBe(
      'Nothing is posted.'
    )
  })

  it('shows Greetings, Answers and Banter as read-only chips that open Buddy → Chat', async () => {
    await render(autoChat({ greetings: { enabled: true, templates: [] } }))
    // No switches: the behaviours have one home (plan 174 F-24, H-8).
    expect(document.querySelector('[role="switch"]')).toBeNull()
    expect(chips().map((chip) => chip.textContent)).toEqual([
      'Greetings on',
      'Answers off',
      'Banter off'
    ])
    const [greetings, answers] = chips()
    expect(greetings!.getAttribute('aria-label')).toBe('Greetings on. Change it in Buddy → Chat.')
    expect(greetings!.hasAttribute('data-on')).toBe(true)
    expect(answers!.hasAttribute('data-on')).toBe(false)
    // The tone rides the chip's dot; the words stay monochrome.
    expect(greetings!.getAttribute('data-variant')).toBe('success')
    expect(answers!.getAttribute('data-variant')).toBe('neutral')
    await act(async () => answers!.click())
    expect(onOpenChatSettings).toHaveBeenCalledTimes(1)
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('keeps the chips inert without a way to Buddy → Chat', async () => {
    await render(autoChat(), { link: false })
    for (const chip of chips()) expect(chip.disabled).toBe(true)
  })
})
