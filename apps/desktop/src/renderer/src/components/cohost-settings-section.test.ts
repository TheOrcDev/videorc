// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { compile } from 'tailwindcss'
import { transformWithEsbuild } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostListening, CohostSettings } from '@/lib/backend'
import { UNKNOWN_REASON } from '@/lib/user-error'

import {
  COHOST_SHOW_ON_STREAM_PATCHES,
  CohostListenField,
  BuddyModerationSection,
  BuddyRepliesSection,
  cohostShowOnStreamMode
} from './cohost-settings-section'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  chat: { cohostState: null } as Record<string, unknown>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioChat: () => mocked.chat
}))

let root: Root
let container: HTMLDivElement
let patchCohostSettings: ReturnType<typeof vi.fn>

function settings(overrides: Partial<CohostSettings> = {}): CohostSettings {
  return {
    enabled: true,
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
      name: 'Sidekick',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {}
    },
    autoChat: {
      talk: 'off',
      mode: 'off',
      greetings: { enabled: false, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    },
    ...overrides
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
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(
  current: CohostSettings,
  gate: Record<string, unknown> = { allowed: true },
  listening?: CohostListening
): Promise<void> {
  mocked.core = { cohostSettings: current, cohostGate: gate, patchCohostSettings }
  mocked.chat = { cohostState: listening ? { listening } : null }
  // Plan 150: the listen field sits on Live, Replies and Moderation on Chat.
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(CohostListenField),
        createElement(BuddyRepliesSection),
        createElement(BuddyModerationSection)
      )
    )
  )
}

function option(label: string): HTMLButtonElement {
  const group = document.getElementById('cohost-show-on-stream')!
  const button = [...group.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  )
  expect(button).toBeTruthy()
  return button!
}

describe('Show on stream automatically', () => {
  it('maps the three options onto the two engine flags', () => {
    expect(COHOST_SHOW_ON_STREAM_PATCHES).toEqual({
      off: { autoHighlight: false, voiceHighlight: false },
      voice: { autoHighlight: false, voiceHighlight: true },
      'voice-and-picks': { autoHighlight: true, voiceHighlight: true }
    })
    expect(cohostShowOnStreamMode({ autoHighlight: false, voiceHighlight: false })).toBe('off')
    expect(cohostShowOnStreamMode({ autoHighlight: false, voiceHighlight: true })).toBe('voice')
    expect(cohostShowOnStreamMode({ autoHighlight: true, voiceHighlight: true })).toBe(
      'voice-and-picks'
    )
    // Picks alone (stored before the voice source) reads as the third option.
    expect(cohostShowOnStreamMode({ autoHighlight: true, voiceHighlight: false })).toBe(
      'voice-and-picks'
    )
  })

  it('renders the choice with its helper lines and writes both flags', async () => {
    await render(settings())
    // Plan 174 F-18: not "Show on stream", which is the question's own action.
    expect(document.body.textContent).toContain('Put comments on stream automatically')
    expect(document.body.textContent).toContain(
      'What I talk about needs Sidekick to hear you (or live captions).'
    )
    expect(document.body.textContent).toContain('nothing Sidekick flagged is ever shown')
    expect(option('Off').hasAttribute('data-checked')).toBe(true)

    await act(async () => option('What I talk about').click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      autoHighlight: false,
      voiceHighlight: true
    })
    await act(async () => option("What I talk about and Sidekick's picks").click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      autoHighlight: true,
      voiceHighlight: true
    })
  })

  it('shows a stored picks-only row as the third option and rewrites it on a click', async () => {
    await render(settings({ autoHighlight: true, voiceHighlight: false }))
    const third = option("What I talk about and Sidekick's picks")
    expect(third.hasAttribute('data-checked')).toBe(true)
    await act(async () => third.click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      autoHighlight: true,
      voiceHighlight: true
    })
  })

  it('does not write when the pressed option already matches', async () => {
    await render(settings({ autoHighlight: false, voiceHighlight: true }))
    await act(async () => option('What I talk about').click())
    expect(patchCohostSettings).not.toHaveBeenCalled()
  })

  it('is disabled with the rest of the section for a Basic account', async () => {
    await render(settings(), {
      allowed: false,
      featureId: 'live-cohost',
      reason: 'Sidekick requires Videorc Premium.'
    })
    for (const label of ['Off', 'What I talk about', "What I talk about and Sidekick's picks"]) {
      expect(option(label).disabled).toBe(true)
    }
  })

  it('names the transcript in the listening consent sentence', async () => {
    await render(settings())
    expect(document.body.textContent).toContain(
      "While you're live, your microphone audio goes to Videorc's cloud speech-to-text and comes back as text, even with live captions off. Videorc servers don't keep it. The transcript is saved with your recording on this computer."
    )
  })
})

// Plan 119 S2, plan 150: the settings live in the Buddy tab's Chat tab, where
// Buddy Live's switch owns `enabled` and the Premium call to action.
describe('under the Sidekick tab', () => {
  it('splits into Replies and Moderation, with no Enable switch', async () => {
    await render(settings())
    expect(document.getElementById('cohost-enabled')).toBeNull()
    expect(document.body.textContent).not.toContain('Enable Sidekick')
    expect(document.body.textContent).not.toContain('Sidekick (alpha)')
    const titles = [...document.querySelectorAll('[data-slot="panel-section"] h2')].map(
      (heading) => heading.textContent
    )
    expect(titles).toEqual(['Replies', 'Moderation'])
    const [replies, moderation] = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="panel-section"]')
    ]
    expect(replies.querySelector('#cohost-tone')).toBeTruthy()
    // "About you" lives under Name and personality now (plan 174 G-9).
    expect(replies.querySelector('#cohost-notes')).toBeNull()
    expect(document.body.textContent).not.toContain('Sidekick notes')
    expect(moderation.querySelector('#cohost-rule-new')).toBeTruthy()
    expect(moderation.querySelector('#cohost-sensitivity')).toBeTruthy()
    expect(moderation.querySelector('#cohost-show-on-stream')).toBeTruthy()
    // Listening sits outside both: it belongs with Buddy Live's switch.
    expect(replies.querySelector('#cohost-listen')).toBeNull()
    expect(moderation.querySelector('#cohost-listen')).toBeNull()
  })

  it('leaves the Premium call to action to Sidekick Live: a Basic account sees it disabled', async () => {
    await render(settings(), {
      allowed: false,
      featureId: 'live-cohost',
      reason: 'Sidekick requires Videorc Premium.',
      upgradeUrl: 'https://www.videorc.com/premium'
    })
    expect(document.body.textContent).not.toContain('View Premium')
    expect((document.getElementById('cohost-listen') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('cohost-answers') as HTMLButtonElement).disabled).toBe(true)
  })
})

// Plan 192 D3, plan 239: Sidekick writing the greetings is Premium and cloud
// AI, like Answers and Banter, so its switch moved here from the avatar's
// Greetings (Avatar → Greetings keeps the lines and a pointer).
describe('Write greetings with AI in Replies (plan 192 D3, plan 239)', () => {
  // The id is on Base UI's hidden input; the label for it names the switch.
  function aiSwitch(): HTMLElement {
    const label = document.querySelector('label[for="buddy-greetings-ai"]')
    const control = document.querySelector<HTMLElement>(
      `[role="switch"][aria-labelledby="${label?.id}"]`
    )
    expect(control).toBeTruthy()
    return control!
  }

  const golmar = (overrides: Partial<CohostSettings> = {}): CohostSettings => {
    const base = settings(overrides)
    return { ...base, persona: { ...base.persona, name: 'Golmar' } }
  }

  it("says it writes in the avatar's voice, from your line on Avatar → Greetings", async () => {
    await render(golmar())
    const replies = document.querySelector<HTMLElement>('[data-slot="panel-section"]')!
    expect(replies.querySelector('h2')?.textContent).toBe('Replies')
    expect(replies.querySelector('label[for="buddy-greetings-ai"]')?.textContent).toBe(
      'Write greetings with AI'
    )
    expect(replies.textContent).toContain(
      "In Golmar's voice. Your line on Avatar → Greetings is the example and the fallback."
    )
    // An older backend omits the switch: on, Rust's default.
    expect(aiSwitch().getAttribute('aria-checked')).toBe('true')
    expect(aiSwitch().hasAttribute('data-disabled')).toBe(false)
  })

  it('saves ai alone in the greetings block, keeping the lines and the welcomes', async () => {
    const templates = [
      {
        id: 't1',
        kind: 'follow' as const,
        text: 'Hey {name}',
        state: 'talk' as const,
        enabled: true
      }
    ]
    const welcomes = { firstTime: { enabled: false }, returning: { enabled: true } }
    const current = golmar()
    await render({
      ...current,
      autoChat: {
        ...current.autoChat,
        greetings: { enabled: true, templates, ai: true, welcomes }
      }
    })
    await act(async () => aiSwitch().click())
    const patch = patchCohostSettings.mock.calls[0]![0] as { autoChat: CohostSettings['autoChat'] }
    expect(Object.keys(patch)).toEqual(['autoChat'])
    expect(patch.autoChat.greetings).toEqual({ enabled: true, templates, ai: false, welcomes })
    expect(patch.autoChat.answers).toEqual(current.autoChat.answers)
  })

  it('is Premium like Answers and Banter: disabled for a Basic account and under the tab lock', async () => {
    await render(golmar(), {
      allowed: false,
      featureId: 'live-cohost',
      reason: 'Sidekick requires Videorc Premium.'
    })
    expect(aiSwitch().hasAttribute('data-disabled')).toBe(true)
    mocked.core = { cohostSettings: golmar(), cohostGate: { allowed: true }, patchCohostSettings }
    // The Chat tab passes its lock (Sidekick Live's unlock reason shows above).
    const Replies = BuddyRepliesSection as (props: {
      locked?: boolean
    }) => ReturnType<typeof BuddyRepliesSection>
    await act(async () => root.render(createElement(Replies, { locked: true })))
    expect(aiSwitch().hasAttribute('data-disabled')).toBe(true)
  })
})

describe('Sidekick hears you while you are live (plan 068)', () => {
  function listenSwitch(): HTMLElement {
    // The id is on Base UI's hidden input, which the label points at; the
    // label names the switch.
    const label = document.querySelector('label[for="cohost-listen"]')
    const control = document.querySelector<HTMLElement>(
      `[role="switch"][aria-labelledby="${label?.id}"]`
    )
    expect(control).toBeTruthy()
    return control!
  }

  it('is a switch bound to the listen setting', async () => {
    await render(settings())
    expect(document.body.textContent).toContain("Sidekick hears you while you're live")
    expect(listenSwitch().hasAttribute('data-unchecked')).toBe(true)
    await act(async () => listenSwitch().click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({ listen: true })
  })

  it('turns listening off again', async () => {
    await render(settings({ listen: true }))
    expect(listenSwitch().hasAttribute('data-checked')).toBe(true)
    await act(async () => listenSwitch().click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({ listen: false })
  })

  it('is locked with the rest of the section for a Basic account', async () => {
    await render(settings(), { allowed: false, featureId: 'live-cohost', reason: 'Premium.' })
    expect(listenSwitch().hasAttribute('data-disabled')).toBe(true)
  })

  it('shows listening time left only when the server reported it', async () => {
    await render(settings({ listen: true }))
    expect(document.querySelector('[data-slot="cohost-listen-allowance"]')).toBeNull()

    await render(
      settings({ listen: true }),
      { allowed: true },
      { state: 'on', remainingSeconds: 5_400 }
    )
    expect(document.querySelector('[data-slot="cohost-listen-allowance"]')?.textContent).toBe(
      '1 h 30 min of listening left this month.'
    )

    await render(
      settings({ listen: true }),
      { allowed: true },
      { state: 'blocked', reasonCode: 'listen-monthly-quota-exhausted', message: 'Used up.' }
    )
    expect(document.querySelector('[data-slot="cohost-listen-allowance"]')?.textContent).toBe(
      'Your listening time for this month is used up.'
    )
  })
})

/**
 * The real Tailwind rules for every class rendered under `root`, applied to
 * the document so `getComputedStyle` sees what the app paints. happy-dom
 * needs three rewrites the browser does not: nesting lowered (esbuild),
 * `:is(.group > *)` unwrapped, and the logical paddings spelled out.
 */
async function applyTailwind(root: Element): Promise<void> {
  const classes = new Set<string>()
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const name of element.classList) classes.add(name)
  }
  const compiler = await compile('@theme inline { --spacing: 0.25rem; }\n@tailwind utilities;', {})
  const { code } = await transformWithEsbuild(compiler.build([...classes]), 'tailwind.css', {
    loader: 'css',
    target: 'chrome100'
  })
  const style = document.createElement('style')
  style.textContent = code
    .replace(/:is\(([^()]+)\)/g, '$1')
    .replace(/padding-inline:\s*([^;]+);/g, 'padding-left: $1; padding-right: $1;')
    .replace(/padding-block:\s*([^;]+);/g, 'padding-top: $1; padding-bottom: $1;')
  document.head.append(style)
}

/** Tailwind's `calc(<spacing> * n)` in px (16 px root); NaN for anything else. */
function px(value: string): number {
  const match = /^calc\(([\d.]+)(px|rem) \* ([\d.]+)\)$/.exec(value.trim())
  if (!match) return Number.NaN
  return Number(match[1]) * (match[2] === 'rem' ? 16 : 1) * Number(match[3])
}

// Plan 168 S-00: the grouped card pads its rows by selecting the shadcn
// `data-slot="field"`. Answers and Banter once replaced that slot with their
// own and sat flush against the card's edges and the hairline above them.
describe('grouped cards (plan 168 Phase 0)', () => {
  it('pads Answers, Banter and Write greetings with AI exactly like Reply tone (plan 239)', async () => {
    await render(settings())
    const replies = [...document.querySelectorAll<HTMLElement>('[data-slot="panel-section"]')].find(
      (section) => section.querySelector('h2')?.textContent === 'Replies'
    )!
    const card = replies.querySelector<HTMLElement>('[data-variant="grouped"]')!
    const rows = [...card.children] as HTMLElement[]
    expect(rows.map((row) => row.querySelector('label')?.textContent)).toEqual([
      'Answers',
      'Banter',
      'Write greetings with AI',
      'Reply tone'
    ])
    await applyTailwind(document.body)
    for (const row of rows) {
      const style = getComputedStyle(row)
      expect(
        [style.paddingLeft, style.paddingRight, style.paddingTop, style.paddingBottom].map(px)
      ).toEqual([12, 12, 10, 10])
    }
  })

  it('keeps the shadcn slots on every grouped card and its rows, even with a save error', async () => {
    patchCohostSettings.mockRejectedValue(new Error('Could not reach the backend.'))
    await render(settings())
    await act(async () => (document.getElementById('cohost-listen') as HTMLButtonElement).click())
    // Plan 174 S2.4: mapped copy under the listen card, never the raw backend
    // sentence and never an unpadded row in the card.
    expect(document.body.textContent).toContain(
      `Couldn't save Sidekick settings. ${UNKNOWN_REASON}`
    )
    expect(document.body.textContent).not.toContain('Could not reach the backend.')
    const cards = [...document.querySelectorAll<HTMLElement>('[data-variant="grouped"]')]
    // Listen (Live tab), Replies and Moderation (Chat tab).
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      expect(card.getAttribute('data-slot')).toBe('field-group')
      for (const row of card.children) expect(row.getAttribute('data-slot')).toBe('field')
    }
  })
})
