// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CohostGreetings,
  CohostGreetingTemplate,
  CohostSettings,
  CohostTalkMode
} from '@/lib/backend'
import { COHOST_ACTIVITY_TEMPLATE_KINDS } from '@/lib/backend'
import { builtinGreeting } from '@/lib/buddy-auto-chat-view'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

import { BuddyGreetingsSection } from './buddy-greetings-section'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

let root: Root
let container: HTMLDivElement
let patchCohostSettings: ReturnType<typeof vi.fn>

function settings(
  templates: CohostGreetingTemplate[],
  greetings: Partial<CohostGreetings> = {},
  talk: CohostTalkMode = 'off'
): CohostSettings {
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
      name: 'Golmar',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {}
    },
    autoChat: {
      talk,
      mode: 'off',
      greetings: { enabled: true, templates, ...greetings },
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

async function render(
  templates: CohostGreetingTemplate[],
  {
    greetings,
    premium = true,
    talk
  }: {
    greetings?: Partial<CohostGreetings>
    premium?: boolean
    talk?: CohostTalkMode
  } = {}
): Promise<void> {
  mocked.core = {
    cohostSettings: settings(templates, greetings, talk),
    // The lines are free (plan 192 D1); the section never reads the gate
    // since its AI switch moved to Sidekick → Chat (plan 239).
    cohostGate: premium
      ? { allowed: true }
      : {
          allowed: false,
          featureId: 'live-cohost',
          reason: 'Sidekick requires Videorc Premium.',
          upgradeUrl: 'https://www.videorc.com/premium'
        },
    patchCohostSettings
  }
  await act(async () => root.render(createElement(BuddyGreetingsSection)))
}

/** The `greetings` block of the one save, checked for an `{autoChat}` patch. */
function savedGreetings(call = 0): CohostGreetings {
  const patch = patchCohostSettings.mock.calls[call]![0] as {
    autoChat: CohostSettings['autoChat']
  }
  expect(Object.keys(patch)).toEqual(['autoChat'])
  return patch.autoChat.greetings
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

function row(kind: string): HTMLElement {
  const element = document.querySelector(
    `[data-slot="buddy-greeting"][data-template-kind="${kind}"] [data-slot="list-row"]`
  ) as HTMLElement | null
  expect(element).toBeTruthy()
  return element!
}

/** The row's title button: it opens and closes the editor (plan 174 S0.5). */
function toggle(kind: string): HTMLButtonElement {
  const button = row(kind).querySelector<HTMLButtonElement>('[data-slot="list-row-button"]')
  expect(button).toBeTruthy()
  return button!
}

function warnings(): string[] {
  return [...document.querySelectorAll('[data-slot="buddy-greeting-warning"]')].map(
    (note) => note.textContent ?? ''
  )
}

describe('Greetings editor (plan 164 S-D5)', () => {
  it('never asks for a starter set: an empty list posts the built-in lines (plan 192 D1)', async () => {
    await render([])
    expect(document.body.textContent).not.toContain('Add the starter set')
    expect(document.body.textContent).not.toContain('No greetings yet')
    expect(document.querySelector('[data-testid="buddy-greetings-empty-note"]')).toBeNull()
  })

  it('warns inline about an unknown field, with a live preview', async () => {
    await render([
      { id: 't1', kind: 'follow', text: 'Welcome {nam}!', state: 'talk', enabled: true }
    ])
    expect(row('follow').textContent).toContain('Welcome {nam}!')
    await act(async () => toggle('follow').click())
    expect(document.querySelector('[data-slot="buddy-greeting-preview"]')?.textContent).toContain(
      'Welcome {nam}!'
    )
    expect(warnings()).toEqual(["{nam} isn't a field and stays as written."])
  })

  it('warns when the text exceeds a cap on an enabled platform (X takes 140)', async () => {
    const text = `Welcome {name}! ${'x'.repeat(150)}`
    await render([{ id: 't1', kind: 'follow', text, state: 'talk', enabled: true }])
    await act(async () => toggle('follow').click())
    expect(warnings()).toEqual([`X takes 140 characters; this one is ${20 + 150}.`])
    // Limited to Twitch, the same text is fine.
    await render([
      { id: 't1', kind: 'follow', platform: 'twitch', text, state: 'talk', enabled: true }
    ])
    await act(async () => toggle('follow').click())
    expect(warnings()).toEqual([])
  })

  it("hides chat's caps in Bubble, where nothing goes to chat, and keeps them for Suggest (plan 211 S-C4)", async () => {
    const text = `Welcome {nam}! ${'x'.repeat(150)}`
    const line = { id: 't1', kind: 'follow' as const, text, state: 'talk' as const, enabled: true }
    await render([line], { talk: 'bubble' })
    await act(async () => toggle('follow').click())
    // The brace still warns: it would show as written in the bubble too.
    expect(warnings()).toEqual(["{nam} isn't a field and stays as written."])
    expect(document.querySelector('[data-slot="buddy-greeting-alert"]')?.textContent).not.toContain(
      'X takes 140'
    )
    // The same editor stays open across the save: now in Suggest.
    await render([line], { talk: 'suggest' })
    expect(warnings()).toEqual([
      `X takes 140 characters; this one is ${'Welcome {nam}! '.length + 150}.`,
      "{nam} isn't a field and stays as written."
    ])
  })

  it('says what the avatar says, by its name, in Bubble and in Suggest, never what it posts as you (plan 211 S-C4, plan 239)', async () => {
    await render([])
    const description = document.body.textContent ?? ''
    expect(description).toContain(
      'What Golmar says when someone chats for the first time, follows, subs or raids. Free: every kind has a line until you write your own. In Bubble, Golmar says it on stream; in Suggest, you post it.'
    )
    expect(description).not.toContain('posts as you')
  })

  it('saves the switch and the edited text on blur, never the whole settings', async () => {
    await render([
      { id: 't1', kind: 'raid', text: '{name} brings {count}', state: 'laugh', enabled: true }
    ])
    await act(async () => toggle('raid').click())
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

  it('opens from its title button, the switch beside it, never inside it (plan 174 S0.5, G-8)', async () => {
    await render([
      { id: 't1', kind: 'follow', text: 'Welcome {nam}!', state: 'talk', enabled: true }
    ])
    const button = toggle('follow')
    const enabled = row('follow').querySelector<HTMLElement>('[role="switch"]')!
    expect(row('follow').hasAttribute('role')).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(enabled.parentElement?.closest('button, [role="button"]')).toBeNull()
    // The warning is the button's description, not a coloured "!" with a tooltip.
    const alert = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(alert?.textContent).toBe("{nam} isn't a field and stays as written.")
    expect(alert?.hasAttribute('title')).toBe(false)

    // The switch saves and leaves the editor shut; the title opens it.
    await act(async () => enabled.click())
    expect(patchCohostSettings).toHaveBeenCalledTimes(1)
    expect(toggle('follow').getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle('follow').click())
    expect(toggle('follow').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('Greetings rhythm (plan 168 S-02)', () => {
  it('puts the Greetings row in a grouped card, as a field, under its one name (plan 174 F-24)', async () => {
    await render([])
    const card = document.querySelector('[data-slot="field-group"][data-variant="grouped"]')
    expect(card).toBeTruthy()
    // Plan 192 D3, plan 239: the card's second field points at the AI
    // switch, which lives in Sidekick → Chat → Replies; no switch here.
    expect(card!.children).toHaveLength(2)
    expect([...card!.children].map((child) => child.getAttribute('data-slot'))).toEqual([
      'field',
      'field'
    ])
    expect(card!.querySelector('#buddy-greetings-enabled')).toBeTruthy()
    expect(card!.querySelector('label[for="buddy-greetings-enabled"]')?.textContent).toBe(
      'Greetings'
    )
    expect(card!.children[1]?.getAttribute('data-testid')).toBe('buddy-greetings-ai-pointer')
    expect(card!.querySelector('#buddy-greetings-ai')).toBeNull()
    expect(document.body.textContent).not.toContain('Greet activity')
  })
})

describe('Default rows: an empty list posts the built-in lines (plan 192 S0.3)', () => {
  function activityRows(): HTMLElement[] {
    return [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="buddy-activity-greetings"] [data-slot="buddy-greeting"]'
      )
    ]
  }

  it('shows every Activity kind once, in order, with its built-in line marked Default', async () => {
    await render([])
    const rows = activityRows()
    expect(rows.map((element) => element.getAttribute('data-template-kind'))).toEqual([
      ...COHOST_ACTIVITY_TEMPLATE_KINDS
    ])
    for (const element of rows) {
      const kind = element.getAttribute('data-template-kind')!
      expect(element.hasAttribute('data-default')).toBe(true)
      expect(element.textContent).toContain(builtinGreeting(kind as 'follow').text)
      expect(element.querySelector('[data-testid="buddy-greeting-default"]')?.textContent).toBe(
        'Default'
      )
      expect(element.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    }
    expect(document.querySelector('[data-testid="buddy-activity-greetings"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Activity')
  })

  it("shows your lines in their kind's place, and the built-in line for every other kind", async () => {
    const lines: CohostGreetingTemplate[] = [
      { id: 'r1', kind: 'raid', text: 'Raid! {name}', state: 'laugh', enabled: true },
      { id: 'f1', kind: 'follow', text: 'Hey {name}', state: 'talk', enabled: true },
      { id: 'f2', kind: 'follow', text: 'Yo {name}', state: 'talk', enabled: false }
    ]
    await render(lines)
    const rows = activityRows()
    // Follow leads (its two lines, in their order); raid keeps its place.
    expect(rows.slice(0, 3).map((element) => element.textContent)).toEqual([
      expect.stringContaining('Hey {name}'),
      expect.stringContaining('Yo {name}'),
      expect.stringContaining(builtinGreeting('sub').text)
    ])
    const raid = rows.filter((element) => element.getAttribute('data-template-kind') === 'raid')
    expect(raid).toHaveLength(1)
    expect(raid[0]!.hasAttribute('data-default')).toBe(false)
    expect(raid[0]!.textContent).toContain('Raid! {name}')
    expect(rows.filter((element) => element.hasAttribute('data-default'))).toHaveLength(
      COHOST_ACTIVITY_TEMPLATE_KINDS.length - 2
    )
  })

  it('makes a default row yours when you edit it: same kind, your text, its state', async () => {
    await render([], { greetings: { ai: false } })
    await act(async () => toggle('raid').click())
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    // The editor starts from the built-in line, and offers no Remove.
    expect(textarea.value).toBe(builtinGreeting('raid').text)
    expect(document.querySelector('[aria-label="Remove greeting"]')).toBeNull()
    await typeInto(textarea, ' {name} storms in! ')
    expect(patchCohostSettings).toHaveBeenCalledTimes(1)
    const saved = savedGreetings()
    expect(saved.templates).toEqual([
      expect.objectContaining({
        kind: 'raid',
        text: '{name} storms in!',
        state: 'laugh',
        enabled: true
      })
    ])
    // The rest of the block rides along (no lossy spread).
    expect(saved.ai).toBe(false)
    expect(saved.enabled).toBe(true)
  })

  it('saves nothing when a default row is opened and closed unchanged', async () => {
    await render([])
    await act(async () => toggle('follow').click())
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(patchCohostSettings).not.toHaveBeenCalled()
  })

  it('switching a default row off saves a switched-off line with the built-in text', async () => {
    await render([])
    const enabled = row('cheer').querySelector<HTMLElement>('[role="switch"]')!
    await act(async () => enabled.click())
    expect(patchCohostSettings).toHaveBeenCalledTimes(1)
    expect(savedGreetings().templates).toEqual([
      expect.objectContaining({
        kind: 'cheer',
        text: builtinGreeting('cheer').text,
        state: builtinGreeting('cheer').state,
        enabled: false
      })
    ])
    // It saves and leaves the editor shut.
    expect(document.querySelector('[data-slot="buddy-greeting-editor"]')).toBeNull()
  })

  it('adds a line from the built-in one, never an empty line the settings refuse', async () => {
    await render([{ id: 't1', kind: 'follow', text: 'Hey {name}', state: 'talk', enabled: true }])
    await act(async () => toggle('follow').click())
    const variant = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Add variant')
    )!
    await act(async () => variant.click())
    expect(savedGreetings().templates[1]).toMatchObject({
      kind: 'follow',
      text: builtinGreeting('follow').text,
      enabled: true
    })
  })

  it('keeps a line it had when its text is cleared, instead of saving an empty one', async () => {
    await render([{ id: 't1', kind: 'follow', text: 'Hey {name}', state: 'talk', enabled: true }])
    await act(async () => toggle('follow').click())
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(textarea, '   ')
    expect(patchCohostSettings).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Hey {name}')
  })
})

describe('Welcomes (plan 192 S1.3)', () => {
  function welcome(kind: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      `[data-slot="buddy-welcome"][data-welcome-kind="${kind}"]`
    )
    expect(element).toBeTruthy()
    return element!
  }

  it('leads with First-time and Returning chatters, above the Activity kinds', async () => {
    await render([])
    const lists = [...document.querySelectorAll('[data-slot="grouped-list"]')].map((list) =>
      list.getAttribute('aria-label')
    )
    expect(lists).toEqual(['Welcomes', 'Activity greetings'])
    const titles = [...document.querySelectorAll('[data-slot="buddy-welcome"]')].map(
      (element) => element.querySelector('[data-slot="list-row-button"]')?.textContent
    )
    expect(titles).toEqual([
      'First-time chatters',
      'Returning chatters',
      'Regulars',
      'Back after a while',
      'Milestones'
    ])
    // An older backend sends no welcomes: both on, on their built-in lines.
    expect(welcome('first-time').textContent).toContain('Hi {name}, welcome to the stream!')
    expect(welcome('returning').textContent).toContain('Welcome back, {name}!')
    for (const kind of ['first-time', 'returning']) {
      expect(welcome(kind).querySelector('[data-testid="buddy-greeting-default"]')).toBeTruthy()
      expect(welcome(kind).querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(
        'true'
      )
    }
  })

  it('switches one welcome, keeping the other, the lines and the AI switch', async () => {
    const templates: CohostGreetingTemplate[] = [
      { id: 't1', kind: 'follow', text: 'Hey {name}', state: 'talk', enabled: true }
    ]
    await render(templates, {
      greetings: {
        ai: true,
        welcomes: {
          firstTime: { enabled: true },
          returning: { enabled: true, text: 'Back again, {name}!', state: 'laugh' }
        }
      }
    })
    expect(welcome('returning').querySelector('[data-testid="buddy-greeting-default"]')).toBeNull()
    expect(welcome('returning').textContent).toContain('Back again, {name}!')
    const enabled = welcome('first-time').querySelector<HTMLElement>('[role="switch"]')!
    expect(enabled.getAttribute('aria-label')).toBe('First-time chatters welcome on')
    await act(async () => enabled.click())
    expect(savedGreetings()).toEqual({
      enabled: true,
      templates,
      ai: true,
      welcomes: {
        firstTime: { enabled: false },
        returning: { enabled: true, text: 'Back again, {name}!', state: 'laugh' }
      }
    })
  })

  it('edits a line with the built-in one as its placeholder; empty saves as absent', async () => {
    await render([], {
      greetings: {
        welcomes: {
          firstTime: { enabled: true, text: 'Yo {name}!', reaction: 'wave' },
          returning: { enabled: true }
        }
      }
    })
    await act(async () =>
      welcome('first-time')
        .querySelector<HTMLButtonElement>('[data-slot="list-row-button"]')!
        .click()
    )
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.getAttribute('aria-label')).toBe('First-time chatters welcome text')
    expect(textarea.placeholder).toBe('Hi {name}, welcome to the stream!')
    expect(textarea.value).toBe('Yo {name}!')
    // Welcomes have no platform choice, no variants and nothing to remove.
    expect(document.querySelector('[aria-label="Platform"]')).toBeNull()
    expect(document.querySelector('[aria-label="Remove greeting"]')).toBeNull()
    await typeInto(textarea, '')
    // The preview falls back to the built-in line.
    expect(document.querySelector('[data-slot="buddy-greeting-preview"]')?.textContent).toContain(
      'Hi first_timer, welcome to the stream!'
    )
    expect(savedGreetings().welcomes).toStrictEqual({
      firstTime: { enabled: true, reaction: 'wave' },
      returning: { enabled: true }
    })
  })

  it('saves a written line trimmed, with a live preview and the field warnings', async () => {
    await render([])
    await act(async () =>
      welcome('returning')
        .querySelector<HTMLButtonElement>('[data-slot="list-row-button"]')!
        .click()
    )
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    await typeInto(textarea, '  Back, {name} from {platform} {nam}  ')
    expect(document.querySelector('[data-slot="buddy-greeting-preview"]')?.textContent).toContain(
      'Back, regular from YouTube {nam}'
    )
    expect(warnings()).toEqual(["{nam} isn't a field and stays as written."])
    expect(savedGreetings().welcomes?.returning).toStrictEqual({
      enabled: true,
      text: 'Back, {name} from {platform} {nam}'
    })
  })
})

// Plan 192 D3, plan 239: writing greetings with AI is Sidekick's (Premium and
// cloud AI), so its switch lives in Sidekick → Chat → Replies
// (cohost-settings-section.test.ts). The avatar's Greetings keep one row that
// says whether it is on and points there.
describe('Write greetings with AI, pointed at from the avatar (plan 192 D3, plan 239)', () => {
  function pointer(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="buddy-greetings-ai-pointer"]'
    )
    expect(element).toBeTruthy()
    return element!
  }

  it("says Sidekick writes each greeting in the avatar's voice while it is on, else the lines as they are", async () => {
    await render([])
    expect(pointer().textContent).toContain('Write greetings with AI')
    // An older backend omits the switch: on, Rust's default.
    expect(pointer().textContent).toContain(
      "On: Sidekick writes each greeting in Golmar's voice, with your line as the example."
    )
    await render([], { greetings: { ai: false } })
    expect(pointer().textContent).toContain('Off: Golmar says your lines as they are.')
    // No switch of its own: the one switch is in Replies.
    expect(pointer().querySelector('[role="switch"]')).toBeNull()
    expect(document.getElementById('buddy-greetings-ai')).toBeNull()
  })

  it('opens Sidekick → Chat, where the switch lives', async () => {
    const navigations: unknown[] = []
    const listen = (event: Event): void => {
      navigations.push((event as CustomEvent).detail)
    }
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, listen)
    try {
      await render([])
      const button = pointer().querySelector('button')!
      expect(button.textContent).toBe('Sidekick → Chat')
      await act(async () => button.click())
      expect(navigations).toEqual([{ tab: 'ai', buddyTab: 'chat' }])
      expect(patchCohostSettings).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, listen)
    }
  })

  it('keeps the lines free on a Basic account: a default row still saves', async () => {
    await render([], { premium: false })
    expect((document.getElementById('buddy-greetings-enabled') as HTMLButtonElement).disabled).toBe(
      false
    )
    await act(async () => row('follow').querySelector<HTMLElement>('[role="switch"]')!.click())
    expect(patchCohostSettings).toHaveBeenCalledTimes(1)
  })
})
