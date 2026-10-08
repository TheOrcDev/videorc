// @vitest-environment happy-dom
import { act, createElement, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GolemPetPreviewProps } from '@/components/golem-pet-preview'
import type { GolemPets } from '@/hooks/use-golem-pets'
import type { AiCapabilities, CohostSettings, GolemPetSummary } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

import { GolemPetSettings } from './golem-pet-settings'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  react: vi.fn((_reaction: string) => true),
  previews: [] as { packId: string; size: number }[],
  openCreator: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/golem-pet-creator-nav', () => ({ openGolemPetCreator: mocked.openCreator }))
// The canvas has its own test; here the preview is a stub with the same handle.
vi.mock('@/components/golem-pet-preview-lazy', () => ({
  LazyGolemPetPreview: (props: GolemPetPreviewProps) => {
    useImperativeHandle(props.ref, () => ({ react: mocked.react }))
    mocked.previews.push({ packId: props.packId, size: props.size })
    return createElement('div', { 'data-testid': 'golem-pet-preview', 'data-pack': props.packId })
  }
}))

let root: Root
let container: HTMLDivElement
const patchCohostSettings = vi.fn(async () => undefined)

const PACK_A: GolemPetSummary = {
  packId: '0b9c6c34-5d7e-4b4f-9a7e-3c2d1e0f9a8b',
  name: 'Moss',
  cellSize: 640,
  gazeCount: 25,
  reactions: ['laugh', 'surprised', 'wink', 'blink', 'sleep', 'proud', 'excited'],
  source: 'page-pet-import',
  hasTalk: false
}
const PACK_B: GolemPetSummary = {
  ...PACK_A,
  packId: '7f3e2d1c-0b9a-4876-9543-210fedcba987',
  name: 'Ember',
  reactions: ['laugh', 'wave'],
  gazeCount: 1
}

function settings(persona: Partial<CohostSettings['persona']> = {}): CohostSettings {
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
      id: 'p-1',
      name: 'Grum',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {},
      ...persona
    },
    autoChat: {
      mode: 'off',
      greetings: { enabled: false, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    }
  }
}

function pets(packs: GolemPetSummary[] | null = [PACK_A]): GolemPets & {
  refresh: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  return {
    packs,
    error: null,
    refresh: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  }
}

const premium: EntitlementUiGate = { allowed: true }
const petOn = {
  cohost: {
    tick: 4,
    pet: { enabled: true, creationsRemainingThisMonth: 2, monthlyLimit: 3 }
  }
} as unknown as AiCapabilities

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  patchCohostSettings.mockClear()
  mocked.react.mockClear()
  mocked.openCreator.mockClear()
  mocked.previews.length = 0
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
  list = pets(),
  importFolder,
  capabilities = petOn as AiCapabilities | null,
  consented = true
}: {
  cohost?: CohostSettings
  list?: GolemPets
  importFolder?: (personaId: string) => Promise<never>
  capabilities?: AiCapabilities | null
  consented?: boolean
} = {}): Promise<void> {
  mocked.core = {
    account: { status: 'signed-in' },
    aiCapabilities: capabilities,
    aiConsent: consented,
    cohostGate: premium,
    cohostSettings: cohost,
    patchCohostSettings,
    runtimeInfo: { platform: 'darwin' }
  }
  await act(async () => root.render(createElement(GolemPetSettings, { pets: list, importFolder })))
}

function kindButton(label: 'Still' | 'Alive'): HTMLButtonElement {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="golem-avatar-kind"] button')
  ].find((button) => button.textContent === label)!
}

function lastPersona(): CohostSettings['persona'] {
  const calls = patchCohostSettings.mock.calls as unknown as [
    { persona: CohostSettings['persona'] }
  ][]
  return calls.at(-1)![0].persona
}

function button(testId: string): HTMLButtonElement {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
}

describe('GolemPetSettings: Avatar (plan 168 S-D2)', () => {
  it('shows Still with the four state tiles and the Still preview at 160 px', async () => {
    await render()
    expect(kindButton('Still').getAttribute('data-state')).toBe('on')
    expect(document.querySelectorAll('[data-slot="golem-tile"]')).toHaveLength(4)
    expect(mocked.previews.at(-1)).toEqual({ packId: 'still', size: 160 })
  })

  it('persists Alive with the first own pack, and Still again', async () => {
    await render({ list: pets([PACK_A, { ...PACK_B, packId: 'bundled:golem' }]) })
    await act(async () => kindButton('Alive').click())
    expect(lastPersona().avatar).toEqual({ kind: 'alive', packId: PACK_A.packId })

    await render({
      cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }),
      list: pets([PACK_A])
    })
    expect(mocked.previews.at(-1)?.packId).toBe(PACK_A.packId)
    const row = document.querySelector('[data-testid="golem-pack-row"]')!
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(row.textContent).toContain('Moss')
    expect(row.textContent).toContain('32 poses · Imported')
    await act(async () => kindButton('Still').click())
    expect(lastPersona().avatar).toEqual({ kind: 'still' })
  })

  it('shows the empty state with Create and Import when there is no pack to wear', async () => {
    await render({ list: pets([]) })
    await act(async () => kindButton('Alive').click())
    expect(patchCohostSettings).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="golem-alive-empty"]')?.textContent).toContain(
      'No living Golem yet'
    )
    expect(button('golem-pack-create').disabled).toBe(false)
    expect(button('golem-pack-import')).toBeTruthy()
    expect(button('golem-create-hint')?.textContent).toBe('2 of 3 left this month')
    await act(async () => button('golem-pack-create').click())
    expect(mocked.openCreator).toHaveBeenCalledTimes(1)
  })

  it('disables Create with its one reason when the web offers no creator or consent is off', async () => {
    await render({ list: pets([]), capabilities: { cohost: { tick: 4 } } as AiCapabilities })
    await act(async () => kindButton('Alive').click())
    expect(button('golem-pack-create').disabled).toBe(true)
    expect(button('golem-create-hint').textContent).toBe('Not available yet')
    await render({ list: pets([]), consented: false })
    expect(button('golem-pack-create').disabled).toBe(true)
    expect(button('golem-create-hint').textContent).toBe(
      'Allow cloud AI below to create a living Golem.'
    )
  })

  it('imports a pack and wears it', async () => {
    const list = pets([])
    const importFolder = vi.fn(async () => ({ pack: PACK_B, skippedFiles: [] }))
    await render({ list, importFolder: importFolder as never })
    await act(async () => kindButton('Alive').click())
    await act(async () => button('golem-pack-import').click())
    expect(importFolder).toHaveBeenCalledWith('p-1')
    expect(list.refresh).toHaveBeenCalled()
    expect(lastPersona().avatar).toEqual({ kind: 'alive', packId: PACK_B.packId })
  })

  it('shows an import refusal inline in the backend words, without the IPC noise', async () => {
    const importFolder = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'golem-pets:import-folder': Error: Two-layer packs (separate head and body) are not supported. Use a complete-character pack."
      )
    })
    await render({ list: pets([]), importFolder: importFolder as never })
    await act(async () => kindButton('Alive').click())
    await act(async () => button('golem-pack-import').click())
    const alert = document.querySelector('[data-testid="golem-import-error"]')
    expect(alert?.textContent).toContain('Could not import that pack')
    expect(alert?.textContent).toContain(
      'Two-layer packs (separate head and body) are not supported. Use a complete-character pack.'
    )
    expect(alert?.textContent).not.toContain('Error invoking')
    expect(patchCohostSettings).not.toHaveBeenCalled()
  })

  it('imports on I while the Alive panel has focus', async () => {
    const importFolder = vi.fn(async () => null)
    await render({ list: pets([]), importFolder: importFolder as never })
    await act(async () => kindButton('Alive').click())
    await act(async () => {
      button('golem-pack-import').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'i', bubbles: true })
      )
    })
    expect(importFolder).toHaveBeenCalledTimes(1)
  })

  it('removes the worn pack behind a confirm: Still first, then the files', async () => {
    const list = pets([PACK_A])
    await render({ cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }), list })
    await act(async () => button('golem-pack-remove').click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Remove Moss?')
    expect(list.remove).not.toHaveBeenCalled()
    await act(async () => button('golem-pack-remove-confirm').click())
    expect(lastPersona().avatar).toEqual({ kind: 'still' })
    expect(list.remove).toHaveBeenCalledWith(PACK_A.packId)
  })
})

describe('GolemPetSettings: Reactions and Motion (plan 168 S-D2)', () => {
  function reactionRow(trigger: string): HTMLElement {
    return document.querySelector(`[data-testid="golem-reaction-row"][data-trigger="${trigger}"]`)!
  }

  it('lists one row per trigger and writes a pick into persona.reactions', async () => {
    await render({
      cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }),
      list: pets([PACK_A])
    })
    expect(document.querySelectorAll('[data-testid="golem-reaction-row"]')).toHaveLength(8)
    // Follow's default chain is wave, then proud: this pack has proud.
    const follow = reactionRow('follow')
    expect(follow.querySelector('[role="combobox"]')?.textContent).toBe('Default: Proud')
    await act(async () => (follow.querySelector('[role="combobox"]') as HTMLElement).click())
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual([
      'Default: Proud',
      'Laugh',
      'Surprised',
      'Wink',
      'Proud',
      'Excited',
      'None'
    ])
    await act(async () => options.find((option) => option.textContent === 'Excited')!.click())
    expect(lastPersona().reactions).toEqual({ follow: 'excited' })
  })

  it('goes back to the default, or None, and keeps an id the pack lacks visible', async () => {
    await render({
      cohost: settings({
        avatar: { kind: 'alive', packId: PACK_A.packId },
        reactions: { follow: 'wave', raid: 'laugh' }
      }),
      list: pets([PACK_A])
    })
    const follow = reactionRow('follow')
    expect(follow.querySelector('[role="combobox"]')?.textContent).toBe('Wave (not in this pack)')
    await act(async () => (follow.querySelector('[role="combobox"]') as HTMLElement).click())
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    await act(async () => options.find((option) => option.textContent === 'None')!.click())
    expect(lastPersona().reactions).toEqual({ follow: 'none', raid: 'laugh' })

    const raid = reactionRow('raid')
    await act(async () => (raid.querySelector('[role="combobox"]') as HTMLElement).click())
    const raidOptions = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    await act(async () => raidOptions[0]!.click())
    expect(lastPersona().reactions).toEqual({ follow: 'wave' })
  })

  it('Try plays the reaction a trigger would play, in the preview', async () => {
    await render({ list: pets([PACK_A]) })
    // Still: Follow has neither wave nor proud, so it hops with wave's pose.
    const tryFollow = reactionRow('follow').querySelector<HTMLButtonElement>(
      '[data-testid="golem-reaction-try"]'
    )!
    await act(async () => tryFollow.click())
    expect(mocked.react).toHaveBeenLastCalledWith('wave')
    // A failed destination does nothing by default.
    expect(
      reactionRow('destination-failed').querySelector<HTMLButtonElement>(
        '[data-testid="golem-reaction-try"]'
      )!.disabled
    ).toBe(true)
  })

  it('saves Sleep after and Breathing into persona.motion', async () => {
    await render()
    const sleep = document.querySelector('[aria-label="Sleep after"]') as HTMLElement
    expect(sleep.textContent).toBe('3 min')
    await act(async () => sleep.click())
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual([
      'Never',
      '1 min',
      '3 min',
      '5 min',
      '10 min'
    ])
    await act(async () => options[0]!.click())
    expect(lastPersona().motion).toEqual({ intensity: 0.45, sleepAfterSeconds: 0, breathing: true })
    await act(async () => (document.getElementById('golem-breathing') as HTMLButtonElement).click())
    expect(lastPersona().motion).toEqual({
      intensity: 0.45,
      sleepAfterSeconds: 180,
      breathing: false
    })
    const lively = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid="golem-motion-ticks"] button')
    ].find((tick) => tick.textContent === 'Lively')!
    await act(async () => lively.click())
    expect(lastPersona().motion.intensity).toBe(1)
  })
})
