// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import type { BuddyLookClient } from '@/hooks/use-buddy-look'
import type {
  AiCapabilities,
  CohostAvatarDraft,
  CohostAvatarDraftStatus,
  CohostSettings
} from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

import { BuddyLookSection } from './buddy-look-section'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  openCreator: vi.fn(),
  previews: [] as { packId: string; stillImages: unknown }[]
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/buddy-pet-creator-nav', () => ({ openBuddyPetCreator: mocked.openCreator }))
vi.mock('@/components/buddy-pet-preview-lazy', async () => {
  const { createElement: h } = await import('react')
  return {
    LazyBuddyPetPreview: (props: BuddyPetPreviewProps) => {
      mocked.previews.push({ packId: props.packId, stillImages: props.stillImages })
      return h('div', { 'data-testid': 'buddy-pet-preview', 'data-pack': props.packId })
    }
  }
})

const ID = '3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8'
const NEXT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const premium: EntitlementUiGate = { allowed: true }
const avatarOn = (remainingToday = 24): AiCapabilities =>
  ({
    cohost: { tick: 4, avatar: { enabled: true, remainingToday, dailyLimit: 24 } }
  }) as unknown as AiCapabilities

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
      id: 'default',
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

function draft(requestId = ID): CohostAvatarDraft {
  return {
    requestId,
    images: {
      idle: `default/drafts/${requestId}/idle.png`,
      talk: `default/drafts/${requestId}/talk.png`,
      laugh: `default/drafts/${requestId}/laugh.png`
    },
    failed: { think: { code: 'ai-gateway-error', message: 'The model could not draw think.' } }
  }
}

function fakeBackend(status: CohostAvatarDraftStatus = {}, remaining = 24) {
  let current = status
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const kept = settings({
    source: 'generated',
    images: { idle: 'default/idle.png', talk: 'default/talk.png', laugh: 'default/laugh.png' }
  })
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
  const request = vi.fn(async () => avatarOn(remaining))
  return {
    client: {
      requestTyped,
      request,
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
        return () => set.delete(handler)
      }
    } as unknown as BuddyLookClient,
    requestTyped,
    kept,
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
  }
}

let root: Root
let container: HTMLDivElement
const patchCohostSettings = vi.fn(async () => undefined)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  patchCohostSettings.mockClear()
  mocked.openCreator.mockClear()
  mocked.previews.length = 0
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
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render({
  client,
  cohost = settings(),
  consented = true
}: {
  client: BuddyLookClient
  cohost?: CohostSettings
  consented?: boolean
}): Promise<void> {
  mocked.core = {
    account: { status: 'signed-in' },
    aiCapabilities: avatarOn(),
    aiConsent: consented,
    cohostGate: premium,
    cohostSettings: cohost,
    patchCohostSettings,
    runtimeInfo: { platform: 'darwin' },
    connection: null,
    wsStatus: 'disconnected'
  }
  await act(async () => root.render(createElement(BuddyLookSection, { client })))
  await settle()
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  await settle()
}

function tiles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="buddy-look-tile"]')]
}

describe('BuddyLookSection (plan 169 D13, plan 170 D14)', () => {
  it('shows the current look view-only, with the Default badge on bundled pictures', async () => {
    await render({ client: fakeBackend().client })
    expect(byTestId('buddy-look')?.dataset.view).toBe('current')
    expect(tiles().map((tile) => tile.dataset.state)).toEqual(['idle', 'talk', 'laugh', 'think'])
    expect(tiles().every((tile) => tile.textContent?.includes('Default'))).toBe(true)
    expect(document.querySelector('[data-testid="buddy-look-redo"]')).toBeNull()
    expect(byTestId('buddy-look-make-alive')).toBeNull()
  })

  it('no longer carries the describe-and-create form: the onboarding makes new looks', async () => {
    await render({ client: fakeBackend().client })
    expect(document.getElementById('buddy-look-description')).toBeNull()
    expect(byTestId('buddy-look-create')).toBeNull()
    expect(byTestId('buddy-look-picture')).toBeNull()
    expect(document.body.textContent).not.toContain('Upload')
  })

  it('follows a look being made elsewhere on the same client (the onboarding), and can cancel it', async () => {
    const backend = fakeBackend({ running: { requestId: NEXT, kind: 'create' } })
    await render({ client: backend.client })
    expect(byTestId('buddy-look')?.dataset.view).toBe('working')
    expect(document.querySelectorAll('[data-testid="buddy-look-skeleton"]')).toHaveLength(4)
    // One copy for a draft wherever it shows (plan 174 G-11): the line is the onboarding's.
    expect(byTestId('buddy-look-working')?.textContent).toBe(
      'Drawing the pictures. This takes one to three minutes.'
    )
    // Plan 174 G-14: the clock runs, and Cancel discards the running id.
    expect(byTestId('buddy-look-elapsed')?.textContent).toMatch(/^\d:\d\d$/)
    await click(byTestId('buddy-look-cancel'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.discard',
      { requestId: NEXT },
      { timeoutMs: 15_000 }
    )
    expect(byTestId('buddy-look')?.dataset.view).toBe('current')
    expect(byTestId('buddy-look-error')).toBeNull()
  })

  it('shows a draft: Redo only on talk, laugh and think, and the preview plays it', async () => {
    const backend = fakeBackend({ draft: draft() })
    await render({ client: backend.client })
    expect(byTestId('buddy-look')?.dataset.view).toBe('draft')
    const withRedo = tiles()
      .filter((tile) => tile.querySelector('[data-testid="buddy-look-redo"]'))
      .map((tile) => tile.dataset.state)
    expect(withRedo).toEqual(['talk', 'laugh', 'think'])
    // The failed pose says so in the shared words; the made ones show their draft picture.
    expect(tiles()[3]!.textContent).toContain('This pose did not come out. Redo it.')
    expect(tiles().map((tile) => tile.querySelector('span')?.textContent)).toEqual([
      'Idle',
      'Talk',
      'Laugh',
      'Think'
    ])
    expect(byTestId('buddy-look-keep')?.textContent).toContain('Use as my Buddy')
    expect(tiles()[1]!.querySelector('img')?.getAttribute('src')).toBe(
      `videorc-asset://buddy/default/drafts/${ID}/talk.png`
    )
    expect(mocked.previews.at(-1)).toEqual({ packId: 'still', stillImages: draft().images })

    // The tile is no tab stop (plan 174 G-18); R on its focused Redo redoes it.
    const laugh = tiles()[2]!
    expect(laugh.hasAttribute('tabindex')).toBe(false)
    const redo = laugh.querySelector<HTMLButtonElement>('[data-testid="buddy-look-redo"]')!
    await act(async () => {
      redo.focus()
      redo.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    })
    await settle()
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.redo',
      { requestId: ID, state: 'laugh' },
      { timeoutMs: 15_000 }
    )
    expect(tiles()[2]!.querySelector('[data-testid="buddy-look-skeleton"]')).not.toBeNull()
  })

  it('keeps the draft: the keep RPC, then the provider copy of the persona follows', async () => {
    const backend = fakeBackend({ draft: draft() })
    await render({ client: backend.client })
    await click(byTestId('buddy-look-keep'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.keep',
      { requestId: ID },
      { timeoutMs: 35_000 }
    )
    expect(patchCohostSettings).toHaveBeenCalledWith({ persona: backend.kept.persona })
    expect(byTestId('buddy-look')?.dataset.view).toBe('current')
  })

  it('deletes the draft behind a question (plan 174 S0.3, G-1)', async () => {
    const backend = fakeBackend({ draft: draft() })
    await render({ client: backend.client })
    expect(byTestId('buddy-look-discard')?.textContent).toContain('Delete…')
    await click(byTestId('buddy-look-discard'))
    expect(byTestId('buddy-look-delete-dialog')?.textContent).toContain('Delete the new look?')
    await click(byTestId('buddy-look-delete-cancel'))
    expect(backend.requestTyped).not.toHaveBeenCalledWith(
      'cohost.avatar.discard',
      expect.anything(),
      expect.anything()
    )
    expect(byTestId('buddy-look')?.dataset.view).toBe('draft')
    await click(byTestId('buddy-look-discard'))
    await click(byTestId('buddy-look-delete-confirm'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.discard',
      { requestId: ID },
      { timeoutMs: 15_000 }
    )
    expect(byTestId('buddy-look')?.dataset.view).toBe('current')
  })

  it('offers Make it Alive once the look is your own, with the reference', async () => {
    await render({
      client: fakeBackend().client,
      cohost: settings({ source: 'generated', images: { idle: 'default/idle.png' } })
    })
    // A look that only has idle shows it for the other poses.
    expect(tiles()[1]!.textContent).toContain('Uses idle')
    await click(byTestId('buddy-look-make-alive'))
    expect(mocked.openCreator).toHaveBeenCalledWith({ reference: 'persona-idle' })
  })

  it('keeps Redo off without cloud AI consent, and says why (plan 174 G-5)', async () => {
    await render({ client: fakeBackend({ draft: draft() }).client, consented: false })
    const redos = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-look-redo"]')
    ]
    expect(redos).toHaveLength(3)
    expect(redos.every((button) => button.disabled)).toBe(true)
    expect(document.querySelector('[data-slot="disabled-reason-text"]')?.textContent).toBe(
      'Allow cloud AI to create a Buddy.'
    )
  })

  it('prices Redo at one image and counts the images left (plan 174 G-14)', async () => {
    await render({ client: fakeBackend({ draft: draft() }, 7).client })
    expect(document.querySelector('[data-testid="buddy-look-redo"]')?.textContent).toContain(
      'Redo · 1 image'
    )
    expect(byTestId('buddy-look-images-left')?.textContent).toBe('7 images left today')
    expect(document.querySelector('[data-slot="disabled-reason-text"]')).toBeNull()
  })
})
