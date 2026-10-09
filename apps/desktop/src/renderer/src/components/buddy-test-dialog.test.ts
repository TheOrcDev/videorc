// @vitest-environment happy-dom
import { act, createElement, useEffect, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuddyPetPreviewInfo, BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import type { BuddyPets } from '@/hooks/use-buddy-pets'
import type { CohostPersona, BuddyPetSummary } from '@/lib/backend'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import { BuddyAvatarSection } from './buddy-avatar-section'

const STILL_INFO: BuddyPetPreviewInfo = {
  packId: 'still',
  name: 'Still',
  reactions: ['talk', 'laugh', 'think'],
  gazeCount: 1,
  frameCount: 4,
  neutral: 'idle',
  gazes: [{ id: 'idle', gaze: [0, 0] }],
  headTop: 0.25,
  notes: []
}

const STEPS = [-1, -0.5, 0, 0.5, 1] as const
const PACK_ID = '0b9c6c34-5d7e-4b4f-9a7e-3c2d1e0f9a8b'
/** A pack with a gaze grid, talk frames and no `think`, but no laugh either. */
const ALIVE_INFO: BuddyPetPreviewInfo = {
  packId: PACK_ID,
  name: 'Moss',
  reactions: ['wink', 'sleep', 'talk-a', 'talk-b', 'wave'],
  gazeCount: 25,
  frameCount: 30,
  neutral: 'gaze-0-0',
  gazes: STEPS.flatMap((y) => STEPS.map((x) => ({ id: `gaze-${x}-${y}`, gaze: [x, y] as const }))),
  headTop: 0.2,
  notes: []
}

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  /** What each preview was last asked to show, by its size. */
  previews: new Map<number, BuddyPetPreviewProps>(),
  log: [] as string[],
  infos: new Map<string, BuddyPetPreviewInfo>(),
  react: vi.fn((_reaction: string) => true),
  renderBubble: vi.fn(async (_params: unknown) => 'QUJD' as string | null)
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/buddy-pet-creator-nav', () => ({ openBuddyPetCreator: vi.fn() }))
vi.mock('@/lib/buddy-overlay', () => ({ renderBuddyBubblePng: mocked.renderBubble }))
// The canvas has its own tests; here the preview is a stub with the same
// handle that logs its pose changes and the reactions it is asked for.
vi.mock('@/components/buddy-pet-preview-lazy', () => ({
  LazyBuddyPetPreview: (props: BuddyPetPreviewProps) => {
    const { onLoad, packId, pose, size, talking } = props
    mocked.previews.set(size, props)
    useImperativeHandle(props.ref, () => ({
      react: (reaction: string) => {
        if (size !== 160) mocked.log.push(`react:${reaction}`)
        return mocked.react(reaction)
      }
    }))
    useEffect(() => {
      if (size !== 160) mocked.log.push(`pose:${pose ?? 'none'}${talking ? '+talk' : ''}`)
    }, [pose, talking, size])
    useEffect(() => {
      const info = mocked.infos.get(packId)
      if (info) onLoad?.(info)
    }, [onLoad, packId])
    return createElement('div', { 'data-testid': 'buddy-pet-preview', 'data-pack': packId })
  }
}))

let root: Root
let container: HTMLDivElement
const request = vi.fn()
const requestTyped = vi.fn()
const patchCohostSettings = vi.fn()
const bridgeCalls: string[] = []

const PERSONA: CohostPersona = {
  id: 'p-1',
  name: 'Grum',
  personality: '',
  bubbleStyle: 'shout',
  images: {},
  source: 'default',
  avatar: { kind: 'still' },
  motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
  reactions: {}
}

const PACK: BuddyPetSummary = {
  packId: PACK_ID,
  name: 'Moss',
  cellSize: 640,
  gazeCount: 25,
  reactions: ALIVE_INFO.reactions,
  source: 'page-pet-import',
  hasTalk: true
}

function pets(): BuddyPets {
  return {
    packs: [PACK],
    error: null,
    refresh: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const spy of [request, requestTyped, patchCohostSettings, mocked.react]) spy.mockClear()
  mocked.renderBubble.mockClear()
  mocked.previews.clear()
  mocked.log.length = 0
  mocked.infos = new Map([
    ['still', STILL_INFO],
    [PACK_ID, ALIVE_INFO]
  ])
  bridgeCalls.length = 0
  // Every bridge call is recorded: the sandbox makes none.
  vi.stubGlobal(
    'videorc',
    new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === 'string'
            ? (...args: unknown[]) => {
                bridgeCalls.push(name)
                return Promise.resolve(args.length ? null : undefined)
              }
            : undefined
      }
    )
  )
  mocked.core = {
    account: { status: 'signed-in' },
    aiCapabilities: null,
    aiConsent: true,
    cohostGate: { allowed: true },
    client: { request, requestTyped },
    patchCohostSettings,
    runtimeInfo: { platform: 'darwin' }
  }
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

async function render(view: 'still' | 'alive' = 'still'): Promise<void> {
  const persona: CohostPersona =
    view === 'still' ? PERSONA : { ...PERSONA, avatar: { kind: 'alive', packId: PACK_ID } }
  await act(async () =>
    root.render(
      createElement(BuddyAvatarSection, {
        motion: persona.motion,
        persona,
        pets: pets(),
        previewPackId: view === 'still' ? 'still' : PACK_ID,
        previewRef: { current: null },
        stillPanel: null,
        view,
        onUnwear: async () => undefined,
        onViewChange: async () => undefined,
        onWear: async () => undefined
      })
    )
  )
}

/** Open through the Test button and wait for the lazy chunk. */
async function openTest(): Promise<HTMLElement> {
  await act(async () => byTestId<HTMLButtonElement>('buddy-test-open').click())
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return dialog()
}

function dialog(): HTMLElement {
  return document.querySelector('[data-testid="buddy-test-dialog"]') as HTMLElement
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.querySelector(`[data-testid="${id}"]`) as T
}

function stage(): BuddyPetPreviewProps {
  return mocked.previews.get(320)!
}

function stateButton(state: string): HTMLButtonElement {
  return dialog().querySelector(`[data-buddy-state="${state}"][role="tab"]`) as HTMLButtonElement
}

/** A click on a state: Radix tabs pick on mousedown. */
async function pickState(state: string): Promise<void> {
  await act(async () => {
    stateButton(state).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  })
}

async function press(key: string, target: Element = dialog()): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function bubble(): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>('[data-testid="buddy-test-bubble"]')
}

describe('Test your Golem (plan 169 D14)', () => {
  it('opens big from the Test button, Idle and alive, on its own non-interactive preview', async () => {
    await render()
    expect(dialog()).toBeNull()
    const opened = await openTest()
    expect(opened.getAttribute('role')).toBe('dialog')
    expect(opened.textContent).toContain('Test Grum')
    expect(stage()).toMatchObject({
      packId: 'still',
      personaId: 'p-1',
      size: 320,
      interactive: false,
      pose: null,
      talking: false
    })
    expect(stateButton('idle').getAttribute('data-state')).toBe('active')
  })

  it('opens on T while the Avatar section has focus', async () => {
    await render()
    await press('t', byTestId('buddy-preview-zoom'))
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    expect(dialog()).not.toBeNull()
  })

  it('holds each Still state: talk bobs, laugh laughs into its hold, think holds', async () => {
    await render()
    await openTest()
    await pickState('talk')
    expect(stage()).toMatchObject({ pose: 'talk', talking: true })
    mocked.log.length = 0
    await pickState('laugh')
    expect(stage()).toMatchObject({ pose: 'laugh', talking: false })
    // The hold lands first, then the laugh plays over it.
    expect(mocked.log).toEqual(['pose:laugh', 'react:laugh'])
    // Picking it again replays the laugh over the same hold.
    mocked.log.length = 0
    await pickState('laugh')
    expect(mocked.log).toEqual(['react:laugh'])
    expect(stateButton('laugh').getAttribute('data-state')).toBe('active')
    await pickState('think')
    expect(stage()).toMatchObject({ pose: 'think', talking: false })
    await pickState('idle')
    expect(stage()).toMatchObject({ pose: null, talking: false })
    expect(byTestId('buddy-test-note').textContent).toBe('')
  })

  it('picks states with 1 to 4', async () => {
    await render()
    await openTest()
    await press('2')
    expect(stage()).toMatchObject({ pose: 'talk', talking: true })
    await press('4')
    expect(stage()).toMatchObject({ pose: 'think' })
    await press('3')
    expect(stage()).toMatchObject({ pose: 'laugh' })
    await press('1')
    expect(stage()).toMatchObject({ pose: null, talking: false })
    expect(byTestId('buddy-test-stage').dataset.buddyState).toBe('idle')
    // From the States row, focus follows the pick so its ring marks the state shown.
    stateButton('idle').focus()
    await press('3', stateButton('idle'))
    expect(document.activeElement).toBe(stateButton('laugh'))
    expect(stateButton('laugh').getAttribute('data-state')).toBe('active')
  })

  it("plays an Alive pack's talk frames, looks up-left to think, and says what it lacks", async () => {
    await render('alive')
    await openTest()
    expect(stage().packId).toBe(PACK_ID)
    await press('2')
    expect(stage()).toMatchObject({ pose: null, talking: true })
    await press('4')
    expect(stage()).toMatchObject({ pose: 'gaze--0.5--1', talking: false })
    mocked.log.length = 0
    await press('3')
    expect(stage()).toMatchObject({ pose: null })
    expect(mocked.log).toContain('react:laugh')
    expect(byTestId('buddy-test-note').textContent).toBe(
      'This pack has no laugh drawing, so it hops instead.'
    )
  })

  it('plays every reaction the pack has, plus Hop', async () => {
    await render('alive')
    await openTest()
    const buttons = [
      ...dialog().querySelectorAll<HTMLButtonElement>('[data-testid="buddy-test-reaction"]')
    ]
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Wink',
      'Sleep',
      'Talk a',
      'Talk b',
      'Wave',
      'Hop'
    ])
    for (const button of buttons) await act(async () => button.click())
    expect(mocked.react.mock.calls.map(([id]) => id)).toEqual([
      'wink',
      'sleep',
      'talk-a',
      'talk-b',
      'wave',
      'hop'
    ])
    // Over a held state too: the hold stays.
    await press('4')
    await act(async () => buttons.at(-1)!.click())
    expect(stage().pose).toBe('gaze--0.5--1')
  })

  it("draws the stream's bubble over the head while Talking, and only then", async () => {
    await render()
    await openTest()
    expect(mocked.renderBubble).toHaveBeenCalledWith({
      bubble: 'Welcome to the horde! Grab a seat.',
      style: 'shout',
      canvas: { width: 3840, height: 2160 },
      rect: DEFAULT_OVERLAY_LAYOUT.buddy.horizontal
    })
    const image = bubble()!
    expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    // The bitmap's size arrives with its load.
    Object.defineProperty(image, 'naturalWidth', { value: 1382 })
    Object.defineProperty(image, 'naturalHeight', { value: 300 })
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(image.classList.contains('hidden')).toBe(true)
    await press('2')
    expect(image.classList.contains('hidden')).toBe(false)
    // The bitmap scales by the drawn Golem over its cell on the 4K canvas
    // (0.18 x 3840 = 691 px), as the stream draws the two together.
    const cell = Math.round(DEFAULT_OVERLAY_LAYOUT.buddy.horizontal.w * 3840)
    const scale = 320 / cell
    expect(parseFloat(image.style.width)).toBeCloseTo(1382 * scale, 1)
    // The tail tip on the head top: 25 % down the 320 px box.
    expect(parseFloat(image.style.top) + parseFloat(image.style.height)).toBeCloseTo(80, 1)
    await press('3')
    expect(image.classList.contains('hidden')).toBe(true)
    await press('2')
    await act(async () => byTestId('buddy-test-bubble-switch').click())
    expect(bubble()?.classList.contains('hidden') ?? true).toBe(true)
  })

  it('is a sandbox: no backend, settings or bridge call while every control is used', async () => {
    for (const view of ['still', 'alive'] as const) {
      await render(view)
      await openTest()
      for (const key of ['1', '2', '3', '4', '2']) await press(key)
      for (const state of ['idle', 'talk', 'laugh', 'think']) {
        await pickState(state)
      }
      for (const button of dialog().querySelectorAll<HTMLButtonElement>(
        '[data-testid="buddy-test-reaction"]'
      )) {
        await act(async () => button.click())
      }
      await act(async () => byTestId('buddy-test-bubble-switch').click())
      await act(async () => byTestId('buddy-test-bubble-switch').click())
      await press('Escape')
      expect(dialog()).toBeNull()
    }
    expect(request).not.toHaveBeenCalled()
    expect(requestTyped).not.toHaveBeenCalled()
    expect(patchCohostSettings).not.toHaveBeenCalled()
    expect(bridgeCalls).toEqual([])
    expect(mocked.react).toHaveBeenCalled()
  })
})
