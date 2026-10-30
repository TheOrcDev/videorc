// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostAutoChat, CohostTalkMode } from '@/lib/backend'
import {
  BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY,
  buddyPostingConsentSentence,
  buddyTalkHint
} from '@/lib/buddy-auto-chat-view'

import { TooltipProvider } from '@/components/ui/tooltip'

import { BuddyChatControls } from './buddy-chat-controls'

let root: Root
let container: HTMLDivElement
let onTalkChange: ReturnType<typeof vi.fn<(talk: CohostTalkMode) => void>>
let onOpenChatSettings: ReturnType<typeof vi.fn<() => void>>

function autoChat(overrides: Partial<CohostAutoChat> = {}): CohostAutoChat {
  return {
    talk: 'off',
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
  onTalkChange = vi.fn()
  onOpenChatSettings = vi.fn()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(
  current: CohostAutoChat,
  {
    name,
    picture,
    link = true,
    aiGreetings
  }: { name?: string; picture?: string; link?: boolean; aiGreetings?: boolean } = {}
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(BuddyChatControls, {
          autoChat: current,
          aiGreetings,
          name,
          picture,
          onTalkChange,
          ...(link ? { onOpenChatSettings } : {})
        })
      )
    )
  )
}

function talkButton(talk: string): HTMLButtonElement {
  const button = document.querySelector(`[data-buddy-talk="${talk}"]`) as HTMLButtonElement | null
  expect(button).toBeTruthy()
  return button!
}

function hint(): string | null | undefined {
  return document.querySelector('[data-slot="buddy-talk-hint"]')?.textContent
}

function chips(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-behaviour-chip"]')]
}

/** A segment checks on a click. */
async function press(button: HTMLElement): Promise<void> {
  await act(async () => button.click())
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]')
}

function dialogButton(testId: string): HTMLButtonElement {
  const button = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null
  expect(button).toBeTruthy()
  return button!
}

describe('How Buddy talks (plan 164 S-D6, plan 174 S3.14a, plan 211 D1, D5)', () => {
  it('offers Off, Bubble and Suggest in that order, and no Auto', async () => {
    await render(autoChat({ talk: 'bubble' }))
    const options = [...document.querySelectorAll<HTMLButtonElement>('[data-buddy-talk]')]
    expect(options.map((option) => [option.dataset.buddyTalk, option.textContent])).toEqual([
      ['off', 'Off'],
      ['bubble', 'Bubble'],
      ['suggest', 'Suggest']
    ])
    expect(document.querySelector('[data-buddy-talk="auto"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/\bAuto\b/)
    // The selected value is `talk`, never the legacy `mode` riding along.
    expect(talkButton('bubble').getAttribute('aria-checked')).toBe('true')
    await render(autoChat({ talk: 'suggest', mode: 'off' }))
    expect(talkButton('suggest').getAttribute('aria-checked')).toBe('true')
    expect(talkButton('off').getAttribute('aria-checked')).toBe('false')
  })

  it('applies Bubble and Off at once, without asking: Buddy posts nothing as you', async () => {
    await render(autoChat({ talk: 'off' }))
    await press(talkButton('bubble'))
    expect(dialog()).toBeNull()
    expect(onTalkChange).toHaveBeenLastCalledWith('bubble')
    expect(localStorage.getItem(BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY)).toBeNull()

    await render(autoChat({ talk: 'suggest' }))
    await press(talkButton('off'))
    expect(dialog()).toBeNull()
    expect(onTalkChange).toHaveBeenLastCalledWith('off')
    // Choosing the value already chosen sends nothing.
    onTalkChange.mockClear()
    await press(talkButton('suggest'))
    expect(onTalkChange).not.toHaveBeenCalled()
  })

  it('asks for consent the first time Suggest is chosen, lands there, and remembers it', async () => {
    await render(autoChat({ talk: 'bubble' }))
    await press(talkButton('suggest'))
    expect(onTalkChange).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('Let Buddy post as you?')
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence(null))
    expect(dialog()?.textContent).not.toMatch(/\bAuto\b/)
    await act(async () => dialogButton('buddy-chat-accept').click())
    expect(onTalkChange).toHaveBeenCalledTimes(1)
    expect(onTalkChange).toHaveBeenLastCalledWith('suggest')
    expect(dialog()).toBeNull()
    expect(localStorage.getItem(BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY)).toBe('1')

    // Consented already: Suggest applies at once.
    onTalkChange.mockClear()
    await render(autoChat({ talk: 'off' }))
    await press(talkButton('suggest'))
    expect(dialog()).toBeNull()
    expect(onTalkChange).toHaveBeenLastCalledWith('suggest')
  })

  it('changes nothing on Not now', async () => {
    await render(autoChat({ talk: 'bubble' }))
    await press(talkButton('suggest'))
    const notNow = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Not now'
    )
    await act(async () => notNow?.click())
    expect(onTalkChange).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(localStorage.getItem(BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY)).toBeNull()
  })

  it("names the control and asks in the streamer's name for Buddy (plan 174 J2-20)", async () => {
    await render(autoChat(), { name: 'Grum' })
    const control = document.querySelector('[aria-labelledby="buddy-talk-label"]')
    expect(control?.getAttribute('role')).toBe('radiogroup')
    expect(document.getElementById('buddy-talk-label')?.textContent).toBe('Grum talks')
    await press(talkButton('suggest'))
    expect(dialog()?.textContent).toContain('Let Grum post as you?')
    expect(dialog()?.textContent).toContain(buddyPostingConsentSentence('Grum'))
    expect(dialog()?.textContent).not.toMatch(/the Buddy/i)
    await render(autoChat())
    expect(document.getElementById('buddy-talk-label')?.textContent).toBe('Buddy talks')
  })

  it('shows the Buddy it names, not the emblem, when it has its own picture', async () => {
    const orc = 'videorc-asset://buddy/official-orc/idle.png'
    await render(autoChat(), { name: 'Golmar', picture: orc })
    await press(talkButton('suggest'))
    expect(dialog()?.textContent).toContain('Let Golmar post as you?')
    const picture = dialog()?.querySelector('[data-slot="buddy-chat-consent-picture"]')
    expect(picture?.getAttribute('src')).toBe(orc)
    expect(dialog()?.querySelector('[data-slot="buddy-emblem"]')).toBeNull()
  })

  it('keeps the emblem when the Buddy has no picture to show', async () => {
    await render(autoChat(), { name: 'Buddy' })
    await press(talkButton('suggest'))
    expect(dialog()?.querySelector('[data-slot="buddy-emblem"]')).toBeTruthy()
    expect(dialog()?.querySelector('[data-slot="buddy-chat-consent-picture"]')).toBeNull()
  })

  it("says what the chosen value means as a visible line, in the Buddy's name (plan 174 F-12)", async () => {
    await render(autoChat({ talk: 'bubble' }), { name: 'Golmar' })
    expect(hint()).toBe('Golmar talks on stream in its bubble. Nothing goes to chat.')
    expect(
      talkButton('bubble').closest('[role="radiogroup"]')?.getAttribute('aria-describedby')
    ).toBe('buddy-talk-hint')
    expect(document.querySelector('[data-buddy-talk][title]')).toBeNull()
    await render(autoChat({ talk: 'off' }), { name: 'Golmar' })
    expect(hint()).toBe('Golmar says nothing on its own.')
    await render(autoChat({ talk: 'suggest' }), { name: 'Golmar' })
    expect(hint()).toBe(buddyTalkHint('suggest', 'Golmar'))
  })

  it('shows Greetings, Answers and Banter as read-only chips that open Buddy → Chat', async () => {
    const line = {
      id: 't-1',
      kind: 'follow' as const,
      text: 'Welcome, {name}!',
      state: 'talk' as const,
      enabled: true
    }
    await render(autoChat({ greetings: { enabled: true, templates: [line] } }))
    // No switches: the behaviours have one home (plan 174 F-24, H-8).
    expect(document.querySelector('[role="switch"]')).toBeNull()
    // Plan 211 D1: what Buddy says, not what it posts.
    expect(
      document.querySelector('[data-slot="buddy-behaviour-chips"]')?.getAttribute('aria-label')
    ).toBe('What Buddy says')
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
    expect(onTalkChange).not.toHaveBeenCalled()
  })

  it('never warns about an empty list: it posts the built-in lines (plan 192 D1)', async () => {
    await render(autoChat({ greetings: { enabled: true, templates: [] } }))
    const [greetings] = chips()
    expect(greetings!.textContent).toBe('Greetings on')
    expect(greetings!.getAttribute('data-variant')).toBe('success')
    expect(greetings!.getAttribute('aria-label')).toBe('Greetings on. Change it in Buddy → Chat.')
  })

  it('says AI on the Greetings chip only when Buddy may write them (plan 192 D7)', async () => {
    const greetings = { enabled: true, templates: [], ai: true }
    await render(autoChat({ greetings }), { aiGreetings: true })
    expect(chips()[0]!.textContent).toBe('Greetings on · AI')
    expect(chips()[0]!.getAttribute('aria-label')).toBe(
      'Greetings on · AI. Change it in Buddy → Chat.'
    )
    // Without Premium and cloud AI, or with the switch off, the lines go out.
    await render(autoChat({ greetings }))
    expect(chips()[0]!.textContent).toBe('Greetings on')
    await render(autoChat({ greetings: { ...greetings, ai: false } }), { aiGreetings: true })
    expect(chips()[0]!.textContent).toBe('Greetings on')
  })

  it('keeps the chips inert without a way to Buddy → Chat', async () => {
    await render(autoChat(), { link: false })
    for (const chip of chips()) expect(chip.disabled).toBe(true)
  })
})
