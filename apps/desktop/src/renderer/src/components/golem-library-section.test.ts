// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GolemPetPreviewProps } from '@/components/golem-pet-preview'
import type { GolemLookClient } from '@/hooks/use-golem-look'
import type {
  AiCapabilities,
  CohostSettings,
  GolemLibraryEntry,
  GolemLibraryState
} from '@/lib/backend'
import { GOLEM_INVITATION_STORAGE_KEY } from '@/lib/golem-library-view'
import { GOLEM_LIBRARY_COPY } from '@/lib/golem-onboarding-copy'
import { GOLEM_OFFICIAL_CATALOG } from '../../../shared/golem-library'

import { GolemLibrarySection } from './golem-library-section'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  signIn: vi.fn(),
  openCreator: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/hooks/use-account', () => ({ useVideorcAccount: () => ({ signIn: mocked.signIn }) }))
vi.mock('@/lib/golem-pet-creator-nav', () => ({ openGolemPetCreator: mocked.openCreator }))
vi.mock('@/components/golem-pet-preview-lazy', async () => {
  const { createElement: h } = await import('react')
  return {
    LazyGolemPetPreview: (props: GolemPetPreviewProps) =>
      h('div', { 'data-testid': 'golem-pet-preview', 'data-pack': props.packId })
  }
})

const GRUM = '7c9e6679-7425-40de-944b-e07fc1ee9a51'
const PEBBLE = '0b6f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'

function entry(id: string, name: string): GolemLibraryEntry {
  return {
    id,
    name,
    description: `${name}, as asked`,
    personality: `${name} personality`,
    context: `${name} about`,
    createdAt: '2026-10-09T10:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
    poses: {
      idle: `videorc-asset://golem/library/${id}/idle-0a1b2c3d.png`,
      talk: null,
      laugh: null,
      think: null
    }
  }
}

function library(patch: Partial<GolemLibraryState> = {}): GolemLibraryState {
  return {
    signedIn: true,
    official: GOLEM_OFFICIAL_CATALOG.map(({ description: _description, ...rest }) => rest),
    mine: [entry(GRUM, 'Grum'), entry(PEBBLE, 'Pebble')],
    activeAvatarId: GRUM,
    serverActiveAvatarId: null,
    limit: 30,
    busy: null,
    ...patch
  }
}

function settings(persona: Partial<CohostSettings['persona']> = {}): CohostSettings {
  return {
    persona: {
      id: 'default',
      name: 'Golem',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'generated',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {},
      ...persona
    }
  } as unknown as CohostSettings
}

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function fakeBackend(initial: GolemLibraryState = library(), refuseSync = false) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const requestTyped = vi.fn(async (method: string, _params?: unknown) => {
    switch (method) {
      case 'cohost.library.get':
        return initial
      case 'cohost.library.sync':
        if (refuseSync) throw new Refused('cohost-library-not-implemented', 'Not available yet.')
        return { accepted: true }
      case 'cohost.library.use':
      case 'cohost.library.update':
      case 'cohost.library.delete':
        return { accepted: true }
      case 'cohost.avatar.draft.get':
        return {}
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  return {
    client: {
      requestTyped,
      request: vi.fn(
        async () =>
          ({
            cohost: { avatar: { enabled: true, remainingToday: 20, dailyLimit: 24 } }
          }) as unknown as AiCapabilities
      ),
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
        return () => set.delete(handler)
      }
    } as unknown as GolemLookClient,
    requestTyped,
    calls: (method: string) =>
      requestTyped.mock.calls.filter(([name]) => name === method).map(([, params]) => params),
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocked.signIn.mockClear()
  mocked.openCreator.mockClear()
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

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(client: GolemLookClient, cohost: CohostSettings = settings()): Promise<void> {
  mocked.core = {
    account: { status: 'signed-in' },
    aiCapabilities: null,
    aiConsent: true,
    cohostGate: { allowed: true },
    cohostSettings: cohost,
    patchCohostSettings: vi.fn(async () => undefined),
    runtimeInfo: { platform: 'darwin' },
    setAiConsent: vi.fn(),
    connection: null,
    wsStatus: 'disconnected'
  }
  await act(async () => root.render(createElement(GolemLibrarySection, { client })))
  await settle()
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)
const card = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="golem-library-card"][data-id="${id}"]`)!

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await settle()
}

async function openMenu(id: string): Promise<HTMLElement[]> {
  const trigger = card(id).querySelector<HTMLElement>('[data-testid="golem-library-more"]')!
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  await settle()
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

describe('GolemLibrarySection: My Golems (plan 170 D16)', () => {
  it('groups the official five and yours, badges the active one and uses another', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const official = byTestId('golem-library-official')!
    const mine = byTestId('golem-library-mine')!
    expect(official.textContent).toContain(GOLEM_LIBRARY_COPY.official)
    expect(mine.textContent).toContain(GOLEM_LIBRARY_COPY.mine)
    expect(
      [...official.querySelectorAll<HTMLElement>('[data-testid="golem-library-card"]')].map(
        (element) => element.dataset.id
      )
    ).toEqual([
      'official:golem',
      'official:orc',
      'official:goblin',
      'official:pirate',
      'official:robot'
    ])
    expect(
      [...mine.querySelectorAll<HTMLElement>('[data-testid="golem-library-card"]')].map(
        (element) => element.dataset.id
      )
    ).toEqual([GRUM, PEBBLE])
    // The active one: badged, no Use.
    expect(card(GRUM).querySelector('[data-testid="golem-library-active"]')?.textContent).toBe(
      'Active'
    )
    expect(card(GRUM).querySelector('[data-testid="golem-library-use"]')).toBeNull()
    expect(card(GRUM).querySelector('img')?.getAttribute('src')).toBe(
      `videorc-asset://golem/library/${GRUM}/idle-0a1b2c3d.png`
    )
    await click(
      card('official:orc').querySelector<HTMLElement>('[data-testid="golem-library-use"]')
    )
    expect(backend.calls('cohost.library.use')).toEqual([{ avatarId: 'official:orc' }])
  })

  it('syncs as the tab opens; a refused automatic sync stays quiet', async () => {
    const backend = fakeBackend(library(), true)
    await render(backend.client)
    expect(backend.calls('cohost.library.sync')).toEqual([{ reason: 'tab' }])
    expect(byTestId('golem-library-error')).toBeNull()
  })

  it('shows a running job calmly: the syncing mark, the busy card, every action waiting', async () => {
    await render(fakeBackend(library({ busy: { kind: 'use', avatarId: 'official:robot' } })).client)
    expect(card('official:robot').dataset.busy).toBe('true')
    expect(
      card('official:orc').querySelector<HTMLButtonElement>('[data-testid="golem-library-use"]')!
        .disabled
    ).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(fakeBackend(library({ busy: { kind: 'sync' } })).client)
    expect(byTestId('golem-library-syncing')).not.toBeNull()
  })

  it('says what failed in the backend words', async () => {
    await render(
      fakeBackend(library({ error: { code: 'network', message: 'Could not reach Videorc.' } }))
        .client
    )
    expect(byTestId('golem-library-error')?.textContent).toBe('Could not reach Videorc.')
  })

  it('signed out: the official five only, with the sign-in line', async () => {
    await render(
      fakeBackend(library({ signedIn: false, mine: null, activeAvatarId: 'official:golem' })).client
    )
    expect(document.querySelectorAll('[data-testid="golem-library-card"]')).toHaveLength(5)
    const signedOut = byTestId('golem-library-signed-out')!
    expect(signedOut.textContent).toContain(GOLEM_LIBRARY_COPY.signedOut)
    await click(signedOut.querySelector('button'))
    expect(mocked.signIn).toHaveBeenCalledOnce()
  })

  it('an empty library says where your Golems will show up', async () => {
    await render(fakeBackend(library({ mine: [] })).client)
    expect(byTestId('golem-library-empty')?.textContent).toBe(GOLEM_LIBRARY_COPY.emptyMine)
  })

  it('offers the Golem picked on videorc.com with Use', async () => {
    const backend = fakeBackend(library({ activeAvatarId: null, serverActiveAvatarId: PEBBLE }))
    await render(backend.client)
    expect(byTestId('golem-library-picked-elsewhere')?.textContent).toContain(
      'Pebble was picked on videorc.com.'
    )
    await click(byTestId('golem-library-picked-elsewhere-use'))
    expect(backend.calls('cohost.library.use')).toEqual([{ avatarId: PEBBLE }])
  })

  it('menus: your own get Rename, Edit personality, Make it Alive and Delete; official only Make it Alive', async () => {
    await render(fakeBackend().client)
    const labels = (items: HTMLElement[]) => items.map((item) => item.textContent?.trim())
    expect(labels(await openMenu(PEBBLE))).toEqual([
      'Rename',
      'Edit personality',
      'Make it Alive',
      'Delete'
    ])
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await settle()
    expect(labels(await openMenu('official:goblin'))).toEqual(['Make it Alive'])
  })

  it('renames one of yours', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const items = await openMenu(PEBBLE)
    await click(items.find((item) => item.textContent?.includes('Rename')))
    const input = document.getElementById('golem-library-name') as HTMLInputElement
    expect(input.value).toBe('Pebble')
    const save = byTestId<HTMLButtonElement>('golem-library-save')!
    expect(save.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        ' Rocky '
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(save)
    expect(backend.calls('cohost.library.update')).toEqual([{ avatarId: PEBBLE, name: 'Rocky' }])
  })

  it('edits the personality and About you of one of yours', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const items = await openMenu(PEBBLE)
    await click(items.find((item) => item.textContent?.includes('Edit personality')))
    const about = document.getElementById('golem-library-about') as HTMLTextAreaElement
    expect(about.value).toBe('Pebble about')
    expect(
      (document.getElementById('golem-library-personality') as HTMLTextAreaElement).value
    ).toBe('Pebble personality')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        about,
        'I stream on Fridays.'
      )
      about.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(byTestId('golem-library-save'))
    expect(backend.calls('cohost.library.update')).toEqual([
      { avatarId: PEBBLE, context: 'I stream on Fridays.' }
    ])
  })

  it('deletes one of yours only after the confirm', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const items = await openMenu(PEBBLE)
    await click(items.find((item) => item.textContent?.includes('Delete')))
    const dialog = byTestId('golem-library-delete-dialog')!
    expect(dialog.textContent).toContain('Delete Pebble?')
    expect(dialog.textContent).toContain(GOLEM_LIBRARY_COPY.deleteBody)
    expect(backend.calls('cohost.library.delete')).toEqual([])
    await click(byTestId('golem-library-delete-confirm'))
    expect(backend.calls('cohost.library.delete')).toEqual([{ avatarId: PEBBLE }])
  })

  it('Make it Alive uses the Golem first, then opens the creator once it is the Golem', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const items = await openMenu(PEBBLE)
    await click(items.find((item) => item.textContent?.includes('Make it Alive')))
    expect(backend.calls('cohost.library.use')).toEqual([{ avatarId: PEBBLE }])
    expect(mocked.openCreator).not.toHaveBeenCalled()
    await act(async () =>
      backend.emit('cohost.library.changed', library({ activeAvatarId: PEBBLE }))
    )
    await settle()
    expect(mocked.openCreator).toHaveBeenCalledWith({ reference: 'persona-idle' })
  })

  it('Make it Alive on the active Golem opens the creator at once', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const items = await openMenu(GRUM)
    await click(items.find((item) => item.textContent?.includes('Make it Alive')))
    expect(backend.calls('cohost.library.use')).toEqual([])
    expect(mocked.openCreator).toHaveBeenCalledWith({ reference: 'persona-idle' })
  })

  it('invites the untouched default Golem into the onboarding, until dismissed', async () => {
    const backend = fakeBackend(library({ activeAvatarId: 'official:golem' }))
    await render(backend.client, settings({ source: 'default' }))
    expect(byTestId('golem-library-invitation')?.textContent).toContain(
      GOLEM_LIBRARY_COPY.invitation
    )
    await click(byTestId('golem-library-invitation-start'))
    const sheet = await vi.waitFor(() => {
      const element = byTestId('golem-onboarding')
      expect(element).not.toBeNull()
      return element!
    })
    expect(sheet.dataset.step).toBe('1')
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await settle()
    await click(byTestId('golem-library-invitation-dismiss'))
    expect(byTestId('golem-library-invitation')).toBeNull()
    expect(localStorage.getItem(GOLEM_INVITATION_STORAGE_KEY)).toBe('1')
  })

  it('never invites a Golem of your own, or once dismissed on this machine', async () => {
    await render(fakeBackend(library({ activeAvatarId: GRUM })).client, settings())
    expect(byTestId('golem-library-invitation')).toBeNull()
    await act(async () => root.unmount())
    localStorage.setItem(GOLEM_INVITATION_STORAGE_KEY, '1')
    root = createRoot(container)
    await render(
      fakeBackend(library({ activeAvatarId: 'official:golem' })).client,
      settings({ source: 'default' })
    )
    expect(byTestId('golem-library-invitation')).toBeNull()
  })

  it('New Golem opens the onboarding on step 1', async () => {
    await render(fakeBackend().client)
    await click(byTestId('golem-library-new'))
    const sheet = await vi.waitFor(() => {
      const element = byTestId('golem-onboarding')
      expect(element).not.toBeNull()
      return element!
    })
    expect(sheet.dataset.step).toBe('1')
  })
})
