// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiCapabilities, CohostSettings } from '@/lib/backend'
import {
  GOLEM_GENERATE_CONSENT_OFF,
  GOLEM_GENERATE_NOT_AVAILABLE,
  GOLEM_GENERATE_QUOTA,
  GOLEM_NAME_REQUIRED,
  golemGenerateAvailability,
  golemNameToSave,
  withGolemImage
} from '@/lib/golem-persona-view'

import type { EntitlementUiGate } from '@/lib/entitlement-ui'

import { GolemPersonaSection } from './golem-persona-section'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

let root: Root
let container: HTMLDivElement
const patchCohostSettings = vi.fn(async () => undefined)
const importGolemImage = vi.fn(async () => null)
const removeGolemPersona = vi.fn(async () => undefined)

const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Golem requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}

function settings(overrides: Partial<CohostSettings['persona']> = {}): CohostSettings {
  return {
    enabled: false,
    tone: 'friendly',
    notes: '',
    autoHighlight: false,
    voiceHighlight: false,
    rules: [],
    listen: false,
    wakeWordRequired: false,
    removeConfirm: 'confirm',
    persona: {
      id: 'default',
      name: 'Golem',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      ...overrides
    },
    autoChat: {
      mode: 'off',
      greetings: { enabled: false, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    }
  }
}

const avatarOn = {
  cohost: { tick: 4, avatar: { enabled: true, remainingToday: 24, dailyLimit: 24 } }
} as unknown as AiCapabilities

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  patchCohostSettings.mockClear()
  importGolemImage.mockClear()
  removeGolemPersona.mockClear()
  Object.assign(window, { videorc: { importGolemImage, removeGolemPersona } })
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

async function render({
  cohost = settings(),
  gate = premium as Record<string, unknown>,
  signedIn = true,
  consented = true,
  capabilities = avatarOn as AiCapabilities | null
} = {}): Promise<void> {
  mocked.core = {
    account: signedIn ? { status: 'signed-in' } : { status: 'signed-out' },
    aiCapabilities: capabilities,
    aiConsent: consented,
    cohostGate: gate,
    cohostSettings: cohost,
    patchCohostSettings,
    runtimeInfo: { platform: 'darwin' }
  }
  await act(async () => root.render(createElement(GolemPersonaSection)))
}

function nameInput(): HTMLInputElement {
  return document.getElementById('golem-name') as HTMLInputElement
}

function generateButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-slot="golem-generate"]')]
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      'value'
    )!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function blur(input: HTMLElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('golemNameToSave and availability (plan 164 S-A4)', () => {
  it('trims the name and refuses empty or overlong ones', () => {
    expect(golemNameToSave('  Grum ')).toBe('Grum')
    expect(golemNameToSave('   ')).toBeNull()
    expect(golemNameToSave('n'.repeat(25))).toBeNull()
  })

  it('names the one reason Generate is off, in the order a streamer fixes them', () => {
    const on = { signedIn: true, gate: premium, consented: true, capabilities: avatarOn }
    expect(golemGenerateAvailability(on)).toEqual({ allowed: true, reason: null, remaining: 24 })
    expect(golemGenerateAvailability({ ...on, signedIn: false }).reason).toBe(
      'Sign in to generate images.'
    )
    expect(golemGenerateAvailability({ ...on, gate: basic }).reason).toBe(basic.reason)
    expect(golemGenerateAvailability({ ...on, consented: false }).reason).toBe(
      GOLEM_GENERATE_CONSENT_OFF
    )
    expect(golemGenerateAvailability({ ...on, capabilities: null }).reason).toBe(
      GOLEM_GENERATE_NOT_AVAILABLE
    )
    expect(
      golemGenerateAvailability({
        ...on,
        capabilities: { cohost: { tick: 3 } } as AiCapabilities
      }).reason
    ).toBe(GOLEM_GENERATE_NOT_AVAILABLE)
    expect(
      golemGenerateAvailability({
        ...on,
        capabilities: {
          cohost: { avatar: { enabled: true, remainingToday: 0, dailyLimit: 24 } }
        } as AiCapabilities
      }).reason
    ).toBe(GOLEM_GENERATE_QUOTA)
  })

  it('sets and clears a state image and tracks the source', () => {
    const persona = settings().persona
    const uploaded = withGolemImage(persona, 'laugh', 'default/laugh.png', 'uploaded')
    expect(uploaded.images).toEqual({ laugh: 'default/laugh.png' })
    expect(uploaded.source).toBe('uploaded')
    const cleared = withGolemImage(uploaded, 'laugh', null, 'uploaded')
    expect(cleared.images).toEqual({})
    expect(cleared.source).toBe('default')
  })
})

describe('GolemPersonaSection', () => {
  it('requires a name to save, and saves a trimmed one on blur', async () => {
    await render()
    expect(nameInput().value).toBe('Golem')
    await type(nameInput(), '   ')
    await blur(nameInput())
    expect(patchCohostSettings).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="golem-name-error"]')?.textContent).toBe(
      GOLEM_NAME_REQUIRED
    )
    await type(nameInput(), '  Grum the Goblin ')
    expect(document.querySelector('[data-slot="golem-name-error"]')).toBeNull()
    await blur(nameInput())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      persona: { ...settings().persona, name: 'Grum the Goblin' }
    })
  })

  it('shows four state tiles with the bundled pack and lets each upload', async () => {
    await render()
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-slot="golem-tile"]')]
    expect(tiles.map((tile) => tile.dataset.state)).toEqual(['idle', 'talk', 'laugh', 'think'])
    expect(document.body.textContent).toContain('Idle')
    expect(document.body.textContent).toContain('Laughing')
    importGolemImage.mockResolvedValueOnce({
      personaId: 'default',
      state: 'laugh',
      path: 'default/laugh.png',
      url: 'videorc-asset://golem/default/laugh.png',
      width: 1,
      height: 1
    } as never)
    const upload = [...tiles[2]!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Upload')
    )!
    await act(async () => upload.click())
    expect(importGolemImage).toHaveBeenCalledWith('default', 'laugh')
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      persona: { ...settings().persona, images: { laugh: 'default/laugh.png' }, source: 'uploaded' }
    })
  })

  it('disables Generate without cloud-AI consent and says so once under the tiles', async () => {
    await render({ consented: false })
    expect(generateButtons()).toHaveLength(4)
    expect(generateButtons().every((button) => button.disabled)).toBe(true)
    expect(
      (document.querySelector('[data-slot="golem-generate-all"]') as HTMLButtonElement).disabled
    ).toBe(true)
    expect(document.querySelector('[data-slot="golem-generate-hint"]')?.textContent).toBe(
      GOLEM_GENERATE_CONSENT_OFF
    )
  })

  it('says "Not available yet" when the web does not offer avatar generation', async () => {
    await render({ capabilities: null })
    expect(generateButtons().every((button) => button.disabled)).toBe(true)
    expect(document.querySelector('[data-slot="golem-generate-hint"]')?.textContent).toBe(
      GOLEM_GENERATE_NOT_AVAILABLE
    )
  })

  it('enables Generate once a prompt is typed, and counts what is left today', async () => {
    await render()
    expect(generateButtons().every((button) => button.disabled)).toBe(true)
    expect(document.querySelector('[data-slot="golem-generate-hint"]')?.textContent).toBe(
      '24 generations left today'
    )
    await type(document.getElementById('golem-prompt') as HTMLInputElement, 'a stone golem')
    expect(generateButtons().every((button) => !button.disabled)).toBe(true)
  })

  it('saves the bubble style on change and shows its sample', async () => {
    await render()
    expect(
      document.querySelector('[data-slot="golem-bubble-sample"]')?.getAttribute('data-style')
    ).toBe('speech')
    const shout = [...document.querySelectorAll('#golem-bubble-style button')].find(
      (button) => button.textContent === 'Shout'
    ) as HTMLButtonElement
    await act(async () => shout.click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      persona: { ...settings().persona, bubbleStyle: 'shout' }
    })
  })

  it('starts over behind a confirm: removes the folder and writes a fresh persona', async () => {
    await render({
      cohost: settings({ id: 'p-1', name: 'Grum', images: { idle: 'p-1/idle.png' } })
    })
    const startOver = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Start over'
    ) as HTMLButtonElement
    await act(async () => startOver.click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Start over with a new Golem?')
    expect(removeGolemPersona).not.toHaveBeenCalled()
    const confirm = [...dialog!.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Start over'
    ) as HTMLButtonElement
    await act(async () => confirm.click())
    expect(removeGolemPersona).toHaveBeenCalledWith('p-1')
    const saved = (
      patchCohostSettings.mock.calls.at(-1) as unknown as [{ persona: CohostSettings['persona'] }]
    )[0]
    expect(saved.persona.id).not.toBe('p-1')
    expect(saved.persona).toMatchObject({ name: 'Golem', images: {}, source: 'default' })
  })
})
