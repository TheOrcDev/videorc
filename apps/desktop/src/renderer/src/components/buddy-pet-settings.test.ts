// @vitest-environment happy-dom
import { act, createElement, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import type { BuddyPets } from '@/hooks/use-buddy-pets'
import type { AiCapabilities, CohostSettings, BuddyPetSummary } from '@/lib/backend'
import { writeBuddyWornPack } from '@/lib/buddy-worn-pack'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

import { BuddyPetSettings } from './buddy-pet-settings'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  react: vi.fn((_reaction: string) => true),
  previews: [] as { packId: string; size: number; paused?: boolean }[],
  openCreator: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/buddy-pet-creator-nav', () => ({ openBuddyPetCreator: mocked.openCreator }))
// The canvas has its own test; here the preview is a stub with the same handle.
vi.mock('@/components/buddy-pet-preview-lazy', () => ({
  LazyBuddyPetPreview: (props: BuddyPetPreviewProps) => {
    useImperativeHandle(props.ref, () => ({ react: mocked.react }))
    mocked.previews.push({
      packId: props.packId,
      size: props.size,
      ...(props.paused === undefined ? {} : { paused: props.paused })
    })
    return createElement('div', { 'data-testid': 'buddy-pet-preview', 'data-pack': props.packId })
  }
}))

let root: Root
let container: HTMLDivElement
const patchCohostSettings = vi.fn(async () => undefined)
const setAiConsent = vi.fn()

const PACK_A: BuddyPetSummary = {
  packId: '0b9c6c34-5d7e-4b4f-9a7e-3c2d1e0f9a8b',
  name: 'Moss',
  cellSize: 640,
  gazeCount: 25,
  reactions: ['laugh', 'surprised', 'wink', 'blink', 'sleep', 'proud', 'excited'],
  source: 'page-pet-import',
  hasTalk: false
}
const PACK_B: BuddyPetSummary = {
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

function pets(packs: BuddyPetSummary[] | null = [PACK_A]): BuddyPets & {
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
  setAiConsent.mockClear()
  mocked.react.mockClear()
  mocked.openCreator.mockClear()
  mocked.previews.length = 0
  localStorage.clear()
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
  list?: BuddyPets
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
    runtimeInfo: { platform: 'darwin' },
    setAiConsent
  }
  await act(async () => root.render(createElement(BuddyPetSettings, { pets: list, importFolder })))
}

function kindButton(label: 'Still' | 'Alive'): HTMLButtonElement {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-avatar-kind"] button')
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

describe('BuddyPetSettings: Avatar (plan 168 S-D2)', () => {
  it('shows Still with the four state tiles and the Still preview at 160 px', async () => {
    await render()
    expect(kindButton('Still').getAttribute('data-state')).toBe('on')
    expect(document.querySelectorAll('[data-testid="buddy-look-tile"]')).toHaveLength(4)
    expect(mocked.previews.at(-1)).toEqual({ packId: 'still', size: 160, paused: false })
  })

  it('folds Zoom into Test and pauses the living preview (plan 174 G-22, G-20)', async () => {
    await render({
      cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }),
      list: pets([PACK_A])
    })
    expect(document.querySelector('[data-testid="buddy-preview-zoom"]')).toBeNull()
    expect(document.querySelector('[data-testid="buddy-preview-zoom-dialog"]')).toBeNull()
    expect(button('buddy-test-open')).toBeTruthy()
    const pause = button('buddy-preview-pause')
    expect(pause.getAttribute('aria-pressed')).toBe('false')
    expect(mocked.previews.at(-1)).toEqual({ packId: PACK_A.packId, size: 160, paused: false })
    await act(async () => pause.click())
    expect(pause.getAttribute('aria-pressed')).toBe('true')
    expect(mocked.previews.at(-1)).toEqual({ packId: PACK_A.packId, size: 160, paused: true })
  })

  it('moves through the moves with arrow keys and wears one with Enter (plan 174 G-18)', async () => {
    await render({
      cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }),
      list: pets([PACK_A, PACK_B])
    })
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-pack-row"]')]
    expect(rows.map((row) => row.getAttribute('role'))).toEqual(['radio', 'radio'])
    // One tab stop: the worn row.
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1])
    rows[0]!.focus()
    await act(async () =>
      rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    expect(document.activeElement).toBe(rows[1])
    // Browsing wears nothing; Enter does.
    expect(patchCohostSettings).not.toHaveBeenCalled()
    await act(async () => rows[1]!.click())
    expect(lastPersona().avatar).toEqual({ kind: 'alive', packId: PACK_B.packId })
  })

  it('wears the pack worn last when Alive comes back (plan 174 G-10)', async () => {
    writeBuddyWornPack('p-1', PACK_B.packId)
    await render({ list: pets([PACK_A, PACK_B]) })
    await act(async () => kindButton('Alive').click())
    expect(lastPersona().avatar).toEqual({ kind: 'alive', packId: PACK_B.packId })
    // Arrow keys browse without switching what viewers see: Enter does.
    expect(document.querySelector('[data-testid="buddy-avatar-kind"]')?.getAttribute('role')).toBe(
      'radiogroup'
    )
  })

  it('persists Alive with the first own pack, and Still again', async () => {
    await render({ list: pets([PACK_A, { ...PACK_B, packId: 'bundled:buddy' }]) })
    await act(async () => kindButton('Alive').click())
    expect(lastPersona().avatar).toEqual({ kind: 'alive', packId: PACK_A.packId })
    expect(localStorage.getItem('videorc.buddyWornPack:p-1')).toBe(PACK_A.packId)

    await render({
      cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }),
      list: pets([PACK_A])
    })
    expect(mocked.previews.at(-1)?.packId).toBe(PACK_A.packId)
    const row = document.querySelector('[data-testid="buddy-pack-row"]')!
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
    expect(document.querySelector('[data-testid="buddy-alive-empty"]')?.textContent).toContain(
      'No moves yet. Import them from a page-pet folder, or create them from a picture.'
    )
    expect(button('buddy-pack-create').disabled).toBe(false)
    expect(button('buddy-pack-import')).toBeTruthy()
    expect(button('buddy-create-hint')?.textContent).toBe('2 of 3 left this month')
    await act(async () => button('buddy-pack-create').click())
    expect(mocked.openCreator).toHaveBeenCalledTimes(1)
  })

  it('locks Create with one Alert and its one action when the web offers no creator or consent is off (plan 174 G-5)', async () => {
    await render({ list: pets([]), capabilities: { cohost: { tick: 4 } } as AiCapabilities })
    await act(async () => kindButton('Alive').click())
    expect(button('buddy-pack-create').disabled).toBe(true)
    const gate = (): HTMLElement =>
      document.querySelector('[data-testid="buddy-create-gate"]') as HTMLElement
    expect(gate().textContent).toBe("Creating isn't available right now.")
    expect(gate().dataset.gate).toBe('unavailable')
    expect(document.querySelector('[data-testid="buddy-create-hint"]')).toBeNull()
    await render({ list: pets([]), consented: false })
    expect(button('buddy-pack-create').disabled).toBe(true)
    expect(gate().textContent).toContain('Allow cloud AI to create an Alive Buddy.')
    // The one action opens the one consent dialog; accepting grants consent.
    await act(async () => gate().querySelector('button')!.click())
    const consent = document.querySelector('[data-testid="buddy-avatar-consent"]')!
    await act(async () =>
      [...consent.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === 'Allow cloud AI')!
        .click()
    )
    expect(setAiConsent).toHaveBeenCalledWith(true)
  })

  it('imports a pack and wears it', async () => {
    const list = pets([])
    const importFolder = vi.fn(async () => ({ pack: PACK_B, skippedFiles: [] }))
    await render({ list, importFolder: importFolder as never })
    await act(async () => kindButton('Alive').click())
    await act(async () => button('buddy-pack-import').click())
    expect(importFolder).toHaveBeenCalledWith('p-1')
    expect(list.refresh).toHaveBeenCalled()
    expect(lastPersona().avatar).toEqual({ kind: 'alive', packId: PACK_B.packId })
  })

  it('shows an import refusal inline in the backend words, without the IPC noise', async () => {
    const importFolder = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'buddy-pets:import-folder': Error: Two-layer packs (separate head and body) are not supported. Use a complete-character pack."
      )
    })
    await render({ list: pets([]), importFolder: importFolder as never })
    await act(async () => kindButton('Alive').click())
    await act(async () => button('buddy-pack-import').click())
    const alert = document.querySelector('[data-testid="buddy-import-error"]')
    expect(alert?.textContent).toContain("Couldn't import those moves")
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
      button('buddy-pack-import').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'i', bubbles: true })
      )
    })
    expect(importFolder).toHaveBeenCalledTimes(1)
  })

  it('removes the worn pack behind a confirm: Still first, then the files', async () => {
    const list = pets([PACK_A])
    await render({ cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }), list })
    await act(async () => button('buddy-pack-remove').click())
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Remove Moss?')
    expect(list.remove).not.toHaveBeenCalled()
    await act(async () => button('buddy-pack-remove-confirm').click())
    expect(lastPersona().avatar).toEqual({ kind: 'still' })
    expect(list.remove).toHaveBeenCalledWith(PACK_A.packId)
  })
})

describe('BuddyPetSettings: Reactions and Motion (plan 168 S-D2)', () => {
  function reactionRow(trigger: string): HTMLElement {
    return document.querySelector(`[data-testid="buddy-reaction-row"][data-trigger="${trigger}"]`)!
  }

  it('lists one row per trigger and writes a pick into persona.reactions', async () => {
    await render({
      cohost: settings({ avatar: { kind: 'alive', packId: PACK_A.packId } }),
      list: pets([PACK_A])
    })
    expect(document.querySelectorAll('[data-testid="buddy-reaction-row"]')).toHaveLength(8)
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
    expect(follow.querySelector('[role="combobox"]')?.textContent).toBe('Wave (not in these moves)')
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
      '[data-testid="buddy-reaction-try"]'
    )!
    await act(async () => tryFollow.click())
    expect(mocked.react).toHaveBeenLastCalledWith('wave')
    // A failed destination does nothing by default.
    expect(
      reactionRow('destination-failed').querySelector<HTMLButtonElement>(
        '[data-testid="buddy-reaction-try"]'
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
    await act(async () => (document.getElementById('buddy-breathing') as HTMLButtonElement).click())
    expect(lastPersona().motion).toEqual({
      intensity: 0.45,
      sleepAfterSeconds: 180,
      breathing: false
    })
    const lively = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-motion-ticks"] button')
    ].find((tick) => tick.textContent === 'Lively')!
    await act(async () => lively.click())
    expect(lastPersona().motion.intensity).toBe(1)
  })
})
