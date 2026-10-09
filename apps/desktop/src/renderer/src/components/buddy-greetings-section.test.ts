// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostGreetingTemplate, CohostSettings } from '@/lib/backend'

import { BuddyGreetingsSection } from './buddy-greetings-section'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

let root: Root
let container: HTMLDivElement
let patchCohostSettings: ReturnType<typeof vi.fn>

function settings(templates: CohostGreetingTemplate[]): CohostSettings {
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
      name: 'Buddy',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {}
    },
    autoChat: {
      mode: 'off',
      greetings: { enabled: true, templates },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  patchCohostSettings = vi.fn(async () => undefined)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(templates: CohostGreetingTemplate[]): Promise<void> {
  mocked.core = { cohostSettings: settings(templates), patchCohostSettings }
  await act(async () => root.render(createElement(BuddyGreetingsSection)))
}

function row(kind: string): HTMLElement {
  const element = document.querySelector(
    `[data-slot="buddy-greeting"][data-template-kind="${kind}"] [data-slot="list-row"]`
  ) as HTMLElement | null
  expect(element).toBeTruthy()
  return element!
}

function warnings(): string[] {
  return [...document.querySelectorAll('[data-slot="buddy-greeting-warning"]')].map(
    (note) => note.textContent ?? ''
  )
}

describe('Greetings editor (plan 164 S-D5)', () => {
  it('offers the starter set when the list is empty, in one save', async () => {
    await render([])
    expect(document.querySelector('[data-slot="buddy-greetings-empty"]')).toBeTruthy()
    const add = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Add the starter set'
    )
    await act(async () => add?.click())
    expect(patchCohostSettings).toHaveBeenCalledTimes(1)
    const patch = patchCohostSettings.mock.calls[0]![0] as {
      autoChat: CohostSettings['autoChat']
    }
    expect(patch.autoChat.greetings.templates.map((template) => template.kind)).toEqual([
      'follow',
      'sub',
      'resub',
      'cheer',
      'raid',
      'watch-streak'
    ])
    expect(patch.autoChat.greetings.enabled).toBe(true)
  })

  it('warns inline about an unknown field, with a live preview', async () => {
    await render([
      { id: 't1', kind: 'follow', text: 'Welcome {nam}!', state: 'talk', enabled: true }
    ])
    expect(row('follow').textContent).toContain('Welcome {nam}!')
    await act(async () => row('follow').click())
    expect(document.querySelector('[data-slot="buddy-greeting-preview"]')?.textContent).toContain(
      'Welcome {nam}!'
    )
    expect(warnings()).toEqual(['{nam} is not a field and will be posted as written.'])
  })

  it('warns when the text exceeds a cap on an enabled platform (X takes 140)', async () => {
    const text = `Welcome {name}! ${'x'.repeat(150)}`
    await render([{ id: 't1', kind: 'follow', text, state: 'talk', enabled: true }])
    await act(async () => row('follow').click())
    expect(warnings()).toEqual([`X takes 140 characters; this one is ${20 + 150}.`])
    // Limited to Twitch, the same text is fine.
    await render([
      { id: 't1', kind: 'follow', platform: 'twitch', text, state: 'talk', enabled: true }
    ])
    await act(async () => row('follow').click())
    expect(warnings()).toEqual([])
  })

  it('saves the switch and the edited text on blur, never the whole settings', async () => {
    await render([
      { id: 't1', kind: 'raid', text: '{name} brings {count}', state: 'laugh', enabled: true }
    ])
    await act(async () => row('raid').click())
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '{name} raids with {count}!')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(patchCohostSettings).toHaveBeenCalledTimes(1)
    const patch = patchCohostSettings.mock.calls[0]![0] as {
      autoChat: CohostSettings['autoChat']
    }
    expect(Object.keys(patch)).toEqual(['autoChat'])
    expect(patch.autoChat.greetings.templates[0]).toMatchObject({
      id: 't1',
      text: '{name} raids with {count}!',
      state: 'laugh'
    })
  })
})

describe('Greetings rhythm (plan 168 S-02)', () => {
  it('puts the Greet activity row in a grouped card, as a field', async () => {
    await render([])
    const card = document.querySelector('[data-slot="field-group"][data-variant="grouped"]')
    expect(card).toBeTruthy()
    expect(card!.children).toHaveLength(1)
    expect(card!.children[0]!.getAttribute('data-slot')).toBe('field')
    expect(card!.querySelector('#buddy-greetings-enabled')).toBeTruthy()
  })
})
