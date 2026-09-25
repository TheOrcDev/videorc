// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostSettings } from '@/lib/backend'

import {
  COHOST_SHOW_ON_STREAM_PATCHES,
  CohostSettingsSection,
  cohostShowOnStreamMode
} from './cohost-settings-section'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

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
  gate: Record<string, unknown> = { allowed: true }
): Promise<void> {
  mocked.core = { cohostSettings: current, cohostGate: gate, patchCohostSettings }
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
    expect(document.body.textContent).toContain('What I talk about needs live captions.')
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

  it('names the transcript in the consent sentence', async () => {
    await render(settings())
    expect(document.body.textContent).toContain(
      'while live captions are on, it also reads short windows of what you say, as text (never audio), which are not kept.'
    )
  })
})
