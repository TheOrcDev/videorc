// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostSettings } from '@/lib/backend'
import { GOLEM_NAME_REQUIRED, golemNameToSave } from '@/lib/golem-persona-view'

import type { EntitlementUiGate } from '@/lib/entitlement-ui'

import { GolemPersonaSection } from './golem-persona-section'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

let root: Root
let container: HTMLDivElement
const patchCohostSettings = vi.fn(async () => undefined)
const removeGolemPersona = vi.fn(async () => undefined)

const premium: EntitlementUiGate = { allowed: true }

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
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {},
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  patchCohostSettings.mockClear()
  removeGolemPersona.mockClear()
  Object.assign(window, { videorc: { removeGolemPersona } })
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
  consented = true
} = {}): Promise<void> {
  mocked.core = {
    account: signedIn ? { status: 'signed-in' } : { status: 'signed-out' },
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

describe('golemNameToSave (plan 164 S-A4)', () => {
  it('trims the name and refuses empty or overlong ones', () => {
    expect(golemNameToSave('  Grum ')).toBe('Grum')
    expect(golemNameToSave('   ')).toBeNull()
    expect(golemNameToSave('n'.repeat(25))).toBeNull()
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

  it('zooms the bubble sample into a dialog that switches the style too', async () => {
    await render()
    const zoom = document.querySelector('[data-testid="golem-bubble-zoom"]') as HTMLButtonElement
    expect(zoom.getAttribute('aria-label')).toBe('Zoom in on the bubble')
    expect(document.querySelector('[data-testid="golem-bubble-zoom-dialog"]')).toBeNull()
    await act(async () => zoom.click())
    const dialog = document.querySelector('[data-testid="golem-bubble-zoom-dialog"]')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    const sample = dialog.querySelector('[data-slot="golem-bubble-sample"]')
    expect(sample?.getAttribute('data-size')).toBe('zoomed')
    expect(sample?.getAttribute('data-style')).toBe('speech')
    const thought = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Thought'
    ) as HTMLButtonElement
    await act(async () => thought.click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      persona: { ...settings().persona, bubbleStyle: 'thought' }
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-testid="golem-bubble-zoom-dialog"]')).toBeNull()
  })

  it('opens the zoom when the sample itself is clicked', async () => {
    await render()
    const sample = document.querySelector(
      '[data-testid="golem-bubble-sample-zoom"]'
    ) as HTMLButtonElement
    expect(sample.querySelector('[data-slot="golem-bubble-sample"]')).not.toBeNull()
    // The magnifier is the keyboard path; the sample is out of the tab order.
    expect(sample.tabIndex).toBe(-1)
    await act(async () => sample.click())
    expect(document.querySelector('[data-testid="golem-bubble-zoom-dialog"]')).not.toBeNull()
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
