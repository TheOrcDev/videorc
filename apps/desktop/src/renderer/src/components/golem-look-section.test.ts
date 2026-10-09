// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GolemPetPreviewProps } from '@/components/golem-pet-preview'
import type { GolemLookClient } from '@/hooks/use-golem-look'
import type {
  AiCapabilities,
  CohostAvatarDraft,
  CohostAvatarDraftStatus,
  CohostSettings
} from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { prepareGolemLookPicture, type GolemLookPictureDeps } from '@/lib/golem-look-view'
import { GOLEM_GENERATE_CONSENT_OFF } from '@/lib/golem-persona-view'

import { GolemLookSection } from './golem-look-section'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  openCreator: vi.fn(),
  previews: [] as { packId: string; stillImages: unknown }[]
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/golem-pet-creator-nav', () => ({ openGolemPetCreator: mocked.openCreator }))
vi.mock('@/components/golem-pet-preview-lazy', async () => {
  const { createElement: h } = await import('react')
  return {
    LazyGolemPetPreview: (props: GolemPetPreviewProps) => {
      mocked.previews.push({ packId: props.packId, stillImages: props.stillImages })
      return h('div', { 'data-testid': 'golem-pet-preview', 'data-pack': props.packId })
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
    } as unknown as GolemLookClient,
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
  consented = true,
  preparePicture
}: {
  client: GolemLookClient
  cohost?: CohostSettings
  consented?: boolean
  preparePicture?: (file: File) => ReturnType<typeof prepareGolemLookPicture>
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
  await act(async () =>
    root.render(
      preparePicture
        ? createElement(GolemLookSection, { client, preparePicture })
        : createElement(GolemLookSection, { client })
    )
  )
  await settle()
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  await settle()
}

async function type(value: string): Promise<void> {
  const input = document.getElementById('golem-look-description') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pickFile(file: File): Promise<void> {
  const input = byTestId<HTMLInputElement>('golem-look-picture-input')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

function tiles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="golem-look-tile"]')]
}

describe('GolemLookSection (plan 169 D13)', () => {
  it('keeps Create my Golem disabled until there is a description or a picture', async () => {
    const backend = fakeBackend()
    await render({ client: backend.client })
    const create = byTestId<HTMLButtonElement>('golem-look-create')!
    expect(create.textContent).toContain('Create my Golem')
    expect(create.textContent).toContain('⌘↵')
    expect(create.disabled).toBe(true)
    expect(byTestId('golem-look-hint')?.textContent).toBe('24 images left today · uses 4')
    await type('   ')
    expect(create.disabled).toBe(true)
    await type('A grumpy stone golem')
    expect(create.disabled).toBe(false)
    await click(create)
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.create',
      { description: 'A grumpy stone golem' },
      { timeoutMs: 15_000 }
    )
    // Working: four skeletons, idle first, the others after it.
    expect(byTestId('golem-look')?.dataset.view).toBe('working')
    expect(document.querySelectorAll('[data-testid="golem-look-skeleton"]')).toHaveLength(4)
    expect(tiles()[0]!.textContent).toContain('Drawing the character')
    expect(tiles()[1]!.textContent).toContain('Next, from idle')
  })

  it('shows the current look view-only, with the Default badge on bundled pictures', async () => {
    await render({ client: fakeBackend().client })
    expect(tiles().map((tile) => tile.dataset.state)).toEqual(['idle', 'talk', 'laugh', 'think'])
    expect(tiles().every((tile) => tile.textContent?.includes('Default'))).toBe(true)
    expect(document.querySelector('[data-testid="golem-look-redo"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Upload')
    expect(byTestId('golem-look-make-alive')).toBeNull()
  })

  it('downscales the picture before sending it (1024 px, re-encoded)', async () => {
    const backend = fakeBackend()
    const draws: { width: number; height: number }[] = []
    const deps: GolemLookPictureDeps = {
      decode: async () => ({ width: 3000, height: 2000, source: 'bitmap' }),
      draw: async (_source, width, height) => {
        draws.push({ width, height })
        return {
          transparent: false,
          encode: async (type) => new Blob([new Uint8Array(1000)], { type })
        }
      },
      toBase64: async (blob) => `encoded-${blob.type}`
    }
    await render({
      client: backend.client,
      preparePicture: (file) => prepareGolemLookPicture(file, deps)
    })
    await pickFile(new File([new Uint8Array(5000)], 'cat.jpg', { type: 'image/jpeg' }))
    expect(draws).toEqual([{ width: 1024, height: 683 }])
    expect(byTestId('golem-look-picture')?.textContent).toContain('cat.jpg')
    const create = byTestId<HTMLButtonElement>('golem-look-create')!
    expect(create.disabled).toBe(false)
    await click(create)
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.create',
      { inspirationBase64: 'encoded-image/jpeg' },
      { timeoutMs: 15_000 }
    )
  })

  it('says why a picture cannot be used', async () => {
    await render({ client: fakeBackend().client })
    await pickFile(new File(['GIF89a'], 'anim.gif', { type: 'image/gif' }))
    expect(byTestId('golem-look-error')?.textContent).toBe('Choose a PNG, JPEG or WebP picture.')
    expect(byTestId<HTMLButtonElement>('golem-look-create')!.disabled).toBe(true)
  })

  it('shows a draft: Redo only on talk, laugh and think, and the preview plays it', async () => {
    const backend = fakeBackend({ draft: draft() })
    await render({ client: backend.client })
    expect(byTestId('golem-look')?.dataset.view).toBe('draft')
    const withRedo = tiles()
      .filter((tile) => tile.querySelector('[data-testid="golem-look-redo"]'))
      .map((tile) => tile.dataset.state)
    expect(withRedo).toEqual(['talk', 'laugh', 'think'])
    // The failed pose says why; the made ones show their draft picture.
    expect(tiles()[3]!.textContent).toContain('The model could not draw think.')
    expect(tiles()[1]!.querySelector('img')?.getAttribute('src')).toBe(
      `videorc-asset://golem/default/drafts/${ID}/talk.png`
    )
    expect(mocked.previews.at(-1)).toEqual({ packId: 'still', stillImages: draft().images })
    expect(byTestId('golem-look-create')).toBeNull()

    // R on a focused tile redoes it.
    const laugh = tiles()[2]!
    await act(async () => {
      laugh.focus()
      laugh.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    })
    await settle()
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.redo',
      { requestId: ID, state: 'laugh' },
      { timeoutMs: 15_000 }
    )
    expect(tiles()[2]!.querySelector('[data-testid="golem-look-skeleton"]')).not.toBeNull()
  })

  it('keeps the draft: the keep RPC, then the provider copy of the persona follows', async () => {
    const backend = fakeBackend({ draft: draft() })
    await render({ client: backend.client })
    await click(byTestId('golem-look-keep'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.keep',
      { requestId: ID },
      { timeoutMs: 35_000 }
    )
    expect(patchCohostSettings).toHaveBeenCalledWith({ persona: backend.kept.persona })
    expect(byTestId('golem-look')?.dataset.view).toBe('current')
  })

  it('tries again with the inputs, or discards the draft', async () => {
    const backend = fakeBackend({ draft: draft() })
    await render({ client: backend.client })
    const tryAgain = byTestId<HTMLButtonElement>('golem-look-try-again')!
    expect(tryAgain.disabled).toBe(true)
    await type('A goblin merchant')
    expect(tryAgain.disabled).toBe(false)
    await click(tryAgain)
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.create',
      { description: 'A goblin merchant' },
      { timeoutMs: 15_000 }
    )
    // The run ends with a failed idle: back to the draft, with the reason.
    await act(async () =>
      backend.emit('cohost.avatar.progress', {
        requestId: NEXT,
        state: 'idle',
        phase: 'failed',
        error: { code: 'avatar-timeout', message: 'The model took too long. Try again.' }
      })
    )
    await settle()
    expect(byTestId('golem-look')?.dataset.view).toBe('draft')
    expect(byTestId('golem-look-error')?.textContent).toBe('The model took too long. Try again.')
    await click(byTestId('golem-look-discard'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.discard',
      { requestId: ID },
      { timeoutMs: 15_000 }
    )
    expect(byTestId('golem-look')?.dataset.view).toBe('current')
  })

  it('offers Make it Alive once the look is your own, with the reference and notes', async () => {
    await render({
      client: fakeBackend().client,
      cohost: settings({ source: 'generated', images: { idle: 'default/idle.png' } })
    })
    // A look that only has idle shows it for the other poses.
    expect(tiles()[1]!.textContent).toContain('Uses idle')
    await type('  A mossy stone golem ')
    await click(byTestId('golem-look-make-alive'))
    expect(mocked.openCreator).toHaveBeenCalledWith({
      reference: 'persona-idle',
      notes: 'A mossy stone golem'
    })
  })

  it('disables everything without cloud AI consent and says so once', async () => {
    await render({ client: fakeBackend().client, consented: false })
    expect(byTestId('golem-look-hint')?.textContent).toBe(GOLEM_GENERATE_CONSENT_OFF)
    expect(byTestId<HTMLButtonElement>('golem-look-create')!.disabled).toBe(true)
    expect(
      (document.getElementById('golem-look-description') as HTMLTextAreaElement).disabled
    ).toBe(true)
    expect(byTestId<HTMLButtonElement>('golem-look-picture-pick')!.disabled).toBe(true)
  })
})
