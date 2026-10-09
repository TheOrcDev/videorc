// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import type { BuddyLibraryController } from '@/hooks/use-buddy-library'
import type { BuddyLookClient } from '@/hooks/use-buddy-look'
import type {
  AiCapabilities,
  CohostAvatarDraft,
  CohostAvatarDraftStatus,
  CohostSettings,
  BuddyLibraryState
} from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import type { BuddyOnboardingStep } from '@/lib/buddy-library-view'
import type { BuddyLookPicture } from '@/lib/buddy-look-view'
import {
  BUDDY_ONBOARDING_GATES,
  BUDDY_ONBOARDING_STEP1,
  BUDDY_ONBOARDING_STEP2,
  BUDDY_ONBOARDING_STEP4,
  BUDDY_ONBOARDING_STEP_TITLES
} from '@/lib/buddy-onboarding-copy'
import { BUDDY_OFFICIAL_CATALOG } from '../../../shared/buddy-library'

import { BuddyOnboarding } from './buddy-onboarding'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  signIn: vi.fn(),
  openLink: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/hooks/use-account', () => ({ useVideorcAccount: () => ({ signIn: mocked.signIn }) }))
vi.mock('@/lib/videorc-web-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/videorc-web-links')>()),
  openVideorcWebLink: mocked.openLink
}))
vi.mock('@/components/buddy-pet-preview-lazy', async () => {
  const { createElement: h } = await import('react')
  return {
    LazyBuddyPetPreview: (props: BuddyPetPreviewProps) =>
      h('div', { 'data-testid': 'buddy-pet-preview', 'data-pack': props.packId })
  }
})

const DRAFT = '3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8'
const NEXT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const LIBRARY_AVATAR = '7c9e6679-7425-40de-944b-e07fc1ee9a51'
const premium: EntitlementUiGate = { allowed: true }
const free: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Golem requires Videorc Premium.',
  upgradeUrl: 'https://example.test/premium'
}

function capabilities(remainingToday = 20, count = 3): AiCapabilities {
  return {
    cohost: {
      avatar: { enabled: true, remainingToday, dailyLimit: 24 },
      buddyLibrary: { enabled: true, count, limit: 30 }
    }
  } as unknown as AiCapabilities
}

function settings(): CohostSettings {
  return {
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
    }
  } as unknown as CohostSettings
}

function library(patch: Partial<BuddyLibraryState> = {}): BuddyLibraryState {
  return {
    signedIn: true,
    official: BUDDY_OFFICIAL_CATALOG.map(({ description: _description, ...rest }) => rest),
    mine: [],
    activeAvatarId: 'official:golem',
    serverActiveAvatarId: null,
    limit: 30,
    busy: null,
    ...patch
  }
}

function draft(libraryAvatarId?: string): CohostAvatarDraft {
  return {
    requestId: DRAFT,
    images: {
      idle: `default/drafts/${DRAFT}/idle.png`,
      talk: `default/drafts/${DRAFT}/talk.png`,
      laugh: `default/drafts/${DRAFT}/laugh.png`
    },
    failed: { think: { code: 'ai-gateway-error', message: 'The model failed.' } },
    ...(libraryAvatarId ? { libraryAvatarId } : {})
  }
}

function fakeBackend(status: CohostAvatarDraftStatus = {}, caps = capabilities()) {
  let current = status
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const kept = { ...settings(), persona: { ...settings().persona, name: 'Nibbles' } }
  const requestTyped = vi.fn(async (method: string, params?: unknown) => {
    switch (method) {
      case 'cohost.avatar.draft.get':
        return current
      case 'cohost.avatar.create':
        return { requestId: NEXT }
      case 'cohost.avatar.redo':
        return { requestId: (params as { requestId: string }).requestId }
      case 'cohost.avatar.keep':
        current = {}
        return kept
      case 'cohost.avatar.discard':
        current = {}
        return {}
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  return {
    client: {
      requestTyped,
      request: vi.fn(async () => caps),
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
        return () => set.delete(handler)
      }
    } as unknown as BuddyLookClient,
    requestTyped,
    kept
  }
}

function fakeLibraryController(accept = true) {
  return {
    use: vi.fn(async () => accept),
    refresh: vi.fn(async () => undefined),
    getState: () => ({ loading: false, library: null, pending: null, problem: null })
  } as unknown as BuddyLibraryController & {
    use: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
  }
}

let root: Root
let container: HTMLDivElement
const patchCohostSettings = vi.fn(async () => undefined)
const setAiConsent = vi.fn()
const onOpenChange = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  patchCohostSettings.mockClear()
  setAiConsent.mockClear()
  onOpenChange.mockClear()
  mocked.signIn.mockClear()
  mocked.openLink.mockClear()
  Object.assign(URL, { createObjectURL: () => 'blob:picked', revokeObjectURL: () => undefined })
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

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

interface RenderOptions {
  client: BuddyLookClient
  libraryController?: BuddyLibraryController
  lib?: BuddyLibraryState | null
  signedIn?: boolean
  gate?: EntitlementUiGate
  consented?: boolean
  caps?: AiCapabilities
  initialStep?: BuddyOnboardingStep
  preparePicture?: (file: File) => Promise<BuddyLookPicture>
}

async function render(options: RenderOptions): Promise<void> {
  mocked.core = {
    account: { status: options.signedIn === false ? 'signed-out' : 'signed-in' },
    aiCapabilities: options.caps ?? capabilities(),
    aiConsent: options.consented ?? true,
    cohostGate: options.gate ?? premium,
    cohostSettings: settings(),
    patchCohostSettings,
    runtimeInfo: { platform: 'darwin' },
    setAiConsent,
    connection: null,
    wsStatus: 'disconnected'
  }
  await act(async () =>
    root.render(
      createElement(BuddyOnboarding, {
        open: true,
        onOpenChange,
        openNonce: 1,
        initialStep: options.initialStep ?? 1,
        library: options.lib === undefined ? library() : options.lib,
        libraryController: options.libraryController ?? fakeLibraryController(),
        client: options.client,
        preparePicture:
          options.preparePicture ??
          (async () => ({
            base64: 'cGljdHVyZQ==',
            type: 'image/png',
            width: 512,
            height: 512,
            bytes: 7
          }))
      })
    )
  )
  await settle()
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)
const sheet = (): HTMLElement => byTestId('buddy-onboarding')!
const step = (): string | undefined => sheet().dataset.step

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await settle()
}

async function type(id: string, value: string): Promise<void> {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pickFile(file: File): Promise<void> {
  const input = byTestId<HTMLInputElement>('buddy-onboarding-picture-input')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

const next = (): HTMLButtonElement => byTestId<HTMLButtonElement>('buddy-onboarding-next')!

/** Steps 1 to 3 filled the usual way, landing on step 4. */
async function walkToCreate({ picture = false, skip = false } = {}): Promise<void> {
  await click(byTestId('buddy-onboarding-create-own'))
  await type('buddy-onboarding-description', 'A small cheeky goblin')
  if (picture) await pickFile(new File([new Uint8Array(10)], 'cat.png', { type: 'image/png' }))
  await click(next())
  await type('buddy-onboarding-name', 'Nibbles')
  await type('buddy-onboarding-personality', 'Sly and quick.')
  await type('buddy-onboarding-about', 'I stream on Fridays.')
  await click(skip ? byTestId('buddy-onboarding-skip') : next())
  expect(step()).toBe('4')
}

describe('BuddyOnboarding (plan 170 D14, D15)', () => {
  it('opens on step 1: the copy, the live demo, what it does and the official five', async () => {
    await render({ client: fakeBackend().client })
    expect(step()).toBe('1')
    expect(byTestId('buddy-onboarding-progress')?.textContent).toBe('Step 1 of 4')
    expect(sheet().textContent).toContain(BUDDY_ONBOARDING_STEP_TITLES[0])
    expect(sheet().textContent).toContain(BUDDY_ONBOARDING_STEP1.lead)
    expect(sheet().textContent).toContain(BUDDY_ONBOARDING_STEP1.premiumNote)
    expect(byTestId('buddy-stream-demo')).not.toBeNull()
    expect(byTestId('buddy-onboarding-what')?.querySelectorAll('li')).toHaveLength(5)
    const cards = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="buddy-onboarding-official"]')
    ]
    expect(cards.map((card) => card.dataset.id)).toEqual([
      'official:golem',
      'official:orc',
      'official:goblin',
      'official:pirate',
      'official:robot'
    ])
    // The active one is badged, the others offer "Use this one".
    expect(cards[0]!.dataset.active).toBe('true')
    expect(cards[0]!.querySelector('[data-testid="buddy-onboarding-use-official"]')).toBeNull()
    expect(cards[1]!.textContent).toContain(BUDDY_ONBOARDING_STEP1.cardAction)
  })

  it('shows one still frame with reduced motion: the greeting and the chip', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    await render({ client: fakeBackend().client })
    const demo = byTestId('buddy-stream-demo')!
    expect(demo.dataset.pose).toBe('talk')
    expect(byTestId('buddy-stream-demo-bubble')?.textContent).toBe(
      BUDDY_ONBOARDING_STEP1.demoBubbles[0]
    )
    expect(byTestId('buddy-stream-demo-chip')?.className).toContain('opacity-100')
  })

  it('uses an official Golem from the gallery (free) and closes', async () => {
    const libraryController = fakeLibraryController()
    await render({ client: fakeBackend().client, libraryController, signedIn: false })
    await click(
      document.querySelector<HTMLElement>(
        '[data-id="official:pirate"] [data-testid="buddy-onboarding-use-official"]'
      )
    )
    expect(libraryController.use).toHaveBeenCalledWith('official:pirate')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('step 2 needs a description or a picture, and says so', async () => {
    await render({ client: fakeBackend().client })
    await click(byTestId('buddy-onboarding-create-own'))
    expect(step()).toBe('2')
    expect(next().disabled).toBe(true)
    expect(byTestId('buddy-onboarding-hint')?.textContent).toBe(BUDDY_ONBOARDING_STEP2.nextHint)
    await type('buddy-onboarding-description', '   ')
    expect(next().disabled).toBe(true)
    // An example chip fills it in.
    await click(
      [...sheet().querySelectorAll('button')].find(
        (button) => button.textContent === BUDDY_ONBOARDING_STEP2.examples[1]
      )
    )
    expect(
      (document.getElementById('buddy-onboarding-description') as HTMLTextAreaElement).value
    ).toBe('A knight made of pizza')
    expect(sheet().textContent).toContain('22/600')
    expect(next().disabled).toBe(false)
    expect(byTestId('buddy-onboarding-hint')).toBeNull()
    await type('buddy-onboarding-description', 'x'.repeat(601))
    expect(next().disabled).toBe(true)
    // A picture alone is enough.
    await type('buddy-onboarding-description', '')
    await pickFile(new File([new Uint8Array(10)], 'logo.png', { type: 'image/png' }))
    expect(byTestId('buddy-onboarding-picture')?.textContent).toContain('logo.png')
    expect(next().disabled).toBe(false)
    await click(byTestId('buddy-onboarding-picture-remove'))
    expect(next().disabled).toBe(true)
  })

  it('says why a picture cannot be used, in the copy document words', async () => {
    const prepare = vi.fn(async (_file: File): Promise<BuddyLookPicture> => {
      throw new Error('decode failed')
    })
    await render({ client: fakeBackend().client, preparePicture: prepare })
    await click(byTestId('buddy-onboarding-create-own'))
    await pickFile(new File(['GIF89a'], 'anim.gif', { type: 'image/gif' }))
    expect(byTestId('buddy-onboarding-picture-error')?.textContent).toBe(
      BUDDY_ONBOARDING_STEP2.pictureTypeError
    )
    expect(prepare).not.toHaveBeenCalled()
    await pickFile(new File([new Uint8Array(4)], 'broken.jpg', { type: 'image/jpeg' }))
    expect(byTestId('buddy-onboarding-picture-error')?.textContent).toBe(
      BUDDY_ONBOARDING_STEP2.pictureUnreadable
    )
  })

  it('step 3 needs a name of 1 to 24 characters; Skip for now shows once it has one', async () => {
    await render({ client: fakeBackend().client })
    await click(byTestId('buddy-onboarding-create-own'))
    await type('buddy-onboarding-description', 'A goblin')
    await click(next())
    expect(step()).toBe('3')
    expect(next().disabled).toBe(true)
    expect(byTestId('buddy-onboarding-skip')).toBeNull()
    await type('buddy-onboarding-name', 'Nibbles')
    expect(next().disabled).toBe(false)
    expect(byTestId('buddy-onboarding-skip')?.textContent).toBe('Skip for now')
    await type('buddy-onboarding-personality', 'x'.repeat(1201))
    expect(next().disabled).toBe(true)
  })

  it('advances with ⌘↵ and goes back with Back, keeping what was typed', async () => {
    await render({ client: fakeBackend().client })
    await act(async () =>
      sheet().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
      )
    )
    await settle()
    expect(step()).toBe('2')
    await type('buddy-onboarding-description', 'A goblin')
    await click(next())
    await click(byTestId('buddy-onboarding-back'))
    expect(step()).toBe('2')
    expect(
      (document.getElementById('buddy-onboarding-description') as HTMLTextAreaElement).value
    ).toBe('A goblin')
  })

  it('creates with every field: the look, the picture, the name, personality and About you', async () => {
    const backend = fakeBackend()
    await render({ client: backend.client })
    await walkToCreate({ picture: true })
    expect(byTestId('buddy-onboarding-summary-name')?.textContent).toContain('Nibbles')
    expect(byTestId('buddy-onboarding-allowance')?.textContent).toBe(
      'Uses 4 of your 20 images left today.'
    )
    const create = byTestId<HTMLButtonElement>('buddy-onboarding-create')!
    expect(create.textContent).toContain(BUDDY_ONBOARDING_STEP4.primary)
    await click(create)
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.create',
      {
        description: 'A small cheeky goblin',
        inspirationBase64: 'cGljdHVyZQ==',
        name: 'Nibbles',
        personality: 'Sly and quick.',
        context: 'I stream on Fridays.'
      },
      { timeoutMs: 15_000 }
    )
    // Working: the four slots fill in, idle first; Back is gone.
    expect(byTestId('buddy-onboarding-working')?.textContent).toBe(BUDDY_ONBOARDING_STEP4.working)
    expect(document.querySelectorAll('[data-testid="buddy-look-skeleton"]')).toHaveLength(4)
    expect(byTestId('buddy-onboarding-back')).toBeNull()
  })

  it('Skip for now creates without the personality and About you', async () => {
    const backend = fakeBackend()
    await render({ client: backend.client })
    await walkToCreate({ skip: true })
    expect(byTestId('buddy-onboarding-summary-personality')?.textContent).toContain('Not set')
    expect(byTestId('buddy-onboarding-summary-about')?.textContent).toContain('Not set')
    await click(byTestId('buddy-onboarding-create'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.create',
      { description: 'A small cheeky goblin', name: 'Nibbles' },
      { timeoutMs: 15_000 }
    )
  })

  it('gates Create by account, Premium, Cloud AI, room and images, each with its line and action', async () => {
    const gateOf = (): { kind?: string; text?: string | null; actions: string[] } => {
      const row = byTestId('buddy-onboarding-gate')
      return {
        kind: row?.dataset.gate,
        text: row?.textContent,
        actions: [
          ...document.querySelectorAll<HTMLElement>('[data-testid="buddy-onboarding-gate-action"]')
        ].map((button) => button.textContent ?? '')
      }
    }
    const create = (): HTMLButtonElement => byTestId<HTMLButtonElement>('buddy-onboarding-create')!

    await render({ client: fakeBackend().client, signedIn: false })
    await walkToCreate()
    expect(gateOf()).toMatchObject({ kind: 'signed-out', actions: ['Sign in'] })
    expect(gateOf().text).toContain(BUDDY_ONBOARDING_GATES.signedOut)
    expect(create().disabled).toBe(true)
    await click(document.querySelector('[data-action="sign-in"]') as HTMLElement)
    expect(mocked.signIn).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ client: fakeBackend().client, gate: free })
    await walkToCreate()
    expect(gateOf()).toMatchObject({
      kind: 'premium',
      actions: ['See Premium', 'Start from one of ours']
    })
    await click(document.querySelector('[data-action="see-premium"]') as HTMLElement)
    expect(mocked.openLink).toHaveBeenCalledWith('https://example.test/premium')
    await click(document.querySelector('[data-action="start-from-ours"]') as HTMLElement)
    expect(step()).toBe('1')

    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ client: fakeBackend().client, consented: false })
    await walkToCreate()
    expect(gateOf()).toMatchObject({ kind: 'cloud-ai', actions: ['Allow cloud AI'] })
    expect(gateOf().text).toContain(BUDDY_ONBOARDING_GATES.cloudAiOff)
    await click(document.querySelector('[data-action="allow-cloud-ai"]') as HTMLElement)
    const consent = byTestId('buddy-onboarding-consent')!
    await click(
      [...consent.querySelectorAll('button')].find(
        (button) => button.textContent === 'Allow cloud AI'
      )
    )
    expect(setAiConsent).toHaveBeenCalledWith(true)

    await act(async () => root.unmount())
    root = createRoot(container)
    const full = capabilities(20, 30)
    await render({ client: fakeBackend({}, full).client, caps: full })
    await walkToCreate()
    expect(gateOf()).toMatchObject({ kind: 'full', actions: [] })
    expect(gateOf().text).toContain('Your library is full (30 Golems). Delete one to make room.')
    expect(create().disabled).toBe(true)

    await act(async () => root.unmount())
    root = createRoot(container)
    const spent = capabilities(3)
    await render({ client: fakeBackend({}, spent).client, caps: spent })
    await walkToCreate()
    expect(gateOf()).toMatchObject({ kind: 'allowance' })
    expect(gateOf().text).toContain(BUDDY_ONBOARDING_GATES.allowanceUsed)
    expect(create().disabled).toBe(true)
  })

  it('opens on step 4 when a Golem is waiting as a draft: Redo, Use as my Golem, Discard', async () => {
    const backend = fakeBackend({ draft: draft(LIBRARY_AVATAR) })
    const libraryController = fakeLibraryController()
    await render({ client: backend.client, libraryController })
    expect(step()).toBe('4')
    expect(byTestId('buddy-onboarding-summary')).toBeNull()
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-testid="buddy-look-tile"]')]
    expect(tiles.map((tile) => tile.querySelector('span')?.textContent)).toEqual([
      'Idle',
      'Talk',
      'Laugh',
      'Think'
    ])
    expect(
      tiles
        .filter((tile) => tile.querySelector('[data-testid="buddy-look-redo"]'))
        .map((tile) => tile.dataset.state)
    ).toEqual(['talk', 'laugh', 'think'])
    expect(tiles[3]!.textContent).toContain(BUDDY_ONBOARDING_STEP4.poseFailed)
    expect(byTestId('buddy-onboarding-saved')?.textContent).toBe(BUDDY_ONBOARDING_STEP4.done)
    expect(byTestId('buddy-pet-preview')?.dataset.pack).toBe('still')

    await click(byTestId('buddy-onboarding-use'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.keep',
      { requestId: DRAFT },
      { timeoutMs: 35_000 }
    )
    expect(patchCohostSettings).toHaveBeenCalledWith({ persona: backend.kept.persona })
    expect(libraryController.refresh).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says nothing about the library for a draft an older web made, and Discard goes back', async () => {
    const backend = fakeBackend({ draft: draft() })
    await render({ client: backend.client, initialStep: 1 })
    expect(step()).toBe('4')
    expect(byTestId('buddy-onboarding-saved')).toBeNull()
    await click(byTestId('buddy-onboarding-discard'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.discard',
      { requestId: DRAFT },
      { timeoutMs: 15_000 }
    )
    expect(byTestId('buddy-onboarding-use')).toBeNull()
    expect(byTestId('buddy-onboarding-create')).not.toBeNull()
  })
})
