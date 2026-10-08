// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { compile } from 'tailwindcss'
import { transformWithEsbuild } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostListening, CohostSettings } from '@/lib/backend'

import {
  COHOST_SHOW_ON_STREAM_PATCHES,
  CohostListenField,
  OrcleModerationSection,
  OrcleRepliesSection,
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
      name: 'Golem',
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
        createElement(OrcleRepliesSection),
        createElement(OrcleModerationSection)
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
    expect(document.body.textContent).toContain('Show on stream automatically')
    expect(document.body.textContent).toContain(
      'What I talk about needs Golem to hear you (or live captions).'
    )
    expect(document.body.textContent).toContain('nothing Golem flagged is ever shown')
    expect(option('Off').getAttribute('data-state')).toBe('on')

    await act(async () => option('What I talk about').click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      autoHighlight: false,
      voiceHighlight: true
    })
    await act(async () => option("What I talk about and Golem's picks").click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      autoHighlight: true,
      voiceHighlight: true
    })
  })

  it('shows a stored picks-only row as the third option and rewrites it on a click', async () => {
    await render(settings({ autoHighlight: true, voiceHighlight: false }))
    const third = option("What I talk about and Golem's picks")
    expect(third.getAttribute('data-state')).toBe('on')
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
      reason: 'Golem requires Videorc Premium.'
    })
    for (const label of ['Off', 'What I talk about', "What I talk about and Golem's picks"]) {
      expect(option(label).disabled).toBe(true)
    }
  })

  it('names the transcript in the listening consent sentence', async () => {
    await render(settings())
    expect(document.body.textContent).toContain(
      "While you're live, your microphone audio goes to Videorc's cloud speech-to-text to be turned into text, even with live captions off. Videorc servers don't keep it. The transcript is saved with your recording on this computer."
    )
  })
})

// Plan 119 S2, plan 150: the settings live in the Golem tab's Chat tab, where
// Golem Live's switch owns `enabled` and the Premium call to action.
describe('under the Golem tab', () => {
  it('splits into Replies and Moderation, with no Enable switch', async () => {
    await render(settings())
    expect(document.getElementById('cohost-enabled')).toBeNull()
    expect(document.body.textContent).not.toContain('Enable Golem')
    expect(document.body.textContent).not.toContain('Golem (alpha)')
    const titles = [...document.querySelectorAll('[data-slot="panel-section"] h3')].map(
      (heading) => heading.textContent
    )
    expect(titles).toEqual(['Replies', 'Moderation'])
    const [replies, moderation] = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="panel-section"]')
    ]
    expect(replies.querySelector('#cohost-tone')).toBeTruthy()
    expect(replies.querySelector('#cohost-notes')).toBeTruthy()
    expect(moderation.querySelector('#cohost-rule-new')).toBeTruthy()
    expect(moderation.querySelector('#cohost-sensitivity')).toBeTruthy()
    expect(moderation.querySelector('#cohost-show-on-stream')).toBeTruthy()
    // Listening sits outside both: it belongs with Golem Live's switch.
    expect(replies.querySelector('#cohost-listen')).toBeNull()
    expect(moderation.querySelector('#cohost-listen')).toBeNull()
  })

  it('leaves the Premium call to action to Golem Live: a Basic account sees it disabled', async () => {
    await render(settings(), {
      allowed: false,
      featureId: 'live-cohost',
      reason: 'Golem requires Videorc Premium.',
      upgradeUrl: 'https://www.videorc.com/premium'
    })
    expect(document.body.textContent).not.toContain('View Premium')
    expect((document.getElementById('cohost-listen') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('cohost-notes') as HTMLTextAreaElement).disabled).toBe(true)
  })
})

describe('Golem hears you while you are live (plan 068)', () => {
  function listenSwitch(): HTMLButtonElement {
    const control = document.getElementById('cohost-listen') as HTMLButtonElement | null
    expect(control).toBeTruthy()
    return control!
  }

  it('is a switch bound to the listen setting', async () => {
    await render(settings())
    expect(document.body.textContent).toContain("Golem hears you while you're live")
    expect(listenSwitch().getAttribute('data-state')).toBe('unchecked')
    await act(async () => listenSwitch().click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({ listen: true })
  })

  it('turns listening off again', async () => {
    await render(settings({ listen: true }))
    expect(listenSwitch().getAttribute('data-state')).toBe('checked')
    await act(async () => listenSwitch().click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({ listen: false })
  })

  it('is locked with the rest of the section for a Basic account', async () => {
    await render(settings(), { allowed: false, featureId: 'live-cohost', reason: 'Premium.' })
    expect(listenSwitch().disabled).toBe(true)
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
  it('pads Answers and Banter exactly like Reply tone and Golem notes', async () => {
    await render(settings())
    const replies = [...document.querySelectorAll<HTMLElement>('[data-slot="panel-section"]')].find(
      (section) => section.querySelector('h3')?.textContent === 'Replies'
    )!
    const card = replies.querySelector<HTMLElement>('[data-variant="grouped"]')!
    const rows = [...card.children] as HTMLElement[]
    expect(rows.map((row) => row.querySelector('label')?.textContent)).toEqual([
      'Answers',
      'Banter',
      'Reply tone',
      'Golem notes'
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
    // The error shows under the listen card, never as an unpadded row in it.
    expect(document.body.textContent).toContain('Could not reach the backend.')
    const cards = [...document.querySelectorAll<HTMLElement>('[data-variant="grouped"]')]
    // Listen (Live tab), Replies and Moderation (Chat tab).
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      expect(card.getAttribute('data-slot')).toBe('field-group')
      for (const row of card.children) expect(row.getAttribute('data-slot')).toBe('field')
    }
  })
})
