// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostListening, CohostSettings } from '@/lib/backend'

import {
  COHOST_SHOW_ON_STREAM_PATCHES,
  CohostSettingsSection,
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
  vi.unstubAllGlobals()
})

async function render(
  current: CohostSettings,
  gate: Record<string, unknown> = { allowed: true },
  listening?: CohostListening
): Promise<void> {
  mocked.core = { cohostSettings: current, cohostGate: gate, patchCohostSettings }
  mocked.chat = { cohostState: listening ? { listening } : null }
  await act(async () => root.render(createElement(CohostSettingsSection)))
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
      'What I talk about needs Orcle to hear you (or live captions).'
    )
    expect(document.body.textContent).toContain('nothing Orcle flagged is ever shown')
    expect(option('Off').getAttribute('data-state')).toBe('on')

    await act(async () => option('What I talk about').click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      autoHighlight: false,
      voiceHighlight: true
    })
    await act(async () => option("What I talk about and Orcle's picks").click())
    expect(patchCohostSettings).toHaveBeenLastCalledWith({
      autoHighlight: true,
      voiceHighlight: true
    })
  })

  it('shows a stored picks-only row as the third option and rewrites it on a click', async () => {
    await render(settings({ autoHighlight: true, voiceHighlight: false }))
    const third = option("What I talk about and Orcle's picks")
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
      reason: 'Orcle requires Videorc Premium.'
    })
    for (const label of ['Off', 'What I talk about', "What I talk about and Orcle's picks"]) {
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

// Plan 119 S2: the section lives under the Orcle tab's Customize, where Orcle
// Live's switch owns `enabled` and the Premium call to action.
describe('under the Orcle tab', () => {
  it('has no Enable switch and no title of its own', async () => {
    await render(settings())
    expect(document.getElementById('cohost-enabled')).toBeNull()
    expect(document.body.textContent).not.toContain('Enable Orcle')
    expect(document.body.textContent).not.toContain('Orcle (alpha)')
    expect(document.querySelector('[data-slot="panel-section"] header')).toBeNull()
  })

  it('leaves the Premium call to action to Orcle Live: a Basic account sees it disabled', async () => {
    await render(settings(), {
      allowed: false,
      featureId: 'live-cohost',
      reason: 'Orcle requires Videorc Premium.',
      upgradeUrl: 'https://www.videorc.com/premium'
    })
    expect(document.body.textContent).not.toContain('View Premium')
    expect((document.getElementById('cohost-listen') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('cohost-notes') as HTMLTextAreaElement).disabled).toBe(true)
  })
})

describe('Orcle hears you while you are live (plan 068)', () => {
  function listenSwitch(): HTMLButtonElement {
    const control = document.getElementById('cohost-listen') as HTMLButtonElement | null
    expect(control).toBeTruthy()
    return control!
  }

  it('is a switch bound to the listen setting', async () => {
    await render(settings())
    expect(document.body.textContent).toContain("Orcle hears you while you're live")
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
