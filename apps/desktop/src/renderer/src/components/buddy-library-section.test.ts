// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import type { BuddyLookClient } from '@/hooks/use-buddy-look'
import type {
  AiCapabilities,
  CohostSettings,
  BuddyLibraryEntry,
  BuddyLibraryState
} from '@/lib/backend'
import { BUDDY_INVITATION_STORAGE_KEY } from '@/lib/buddy-library-view'
import { BUDDY_LIBRARY_COPY } from '@/lib/buddy-onboarding-copy'
import { BUDDY_OFFICIAL_CATALOG, officialAliveFallback } from '../../../shared/buddy-library'

import { BuddyLibrarySection } from './buddy-library-section'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  signIn: vi.fn(),
  openCreator: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/hooks/use-account', () => ({ useVideorcAccount: () => ({ signIn: mocked.signIn }) }))
vi.mock('@/lib/buddy-pet-creator-nav', () => ({ openBuddyPetCreator: mocked.openCreator }))
vi.mock('@/components/buddy-pet-preview-lazy', async () => {
  const { createElement: h } = await import('react')
  return {
    LazyBuddyPetPreview: (props: BuddyPetPreviewProps) =>
      h('div', { 'data-testid': 'buddy-pet-preview', 'data-pack': props.packId })
  }
})

const GRUM = '7c9e6679-7425-40de-944b-e07fc1ee9a51'
const PEBBLE = '0b6f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'

function entry(id: string, name: string): BuddyLibraryEntry {
  return {
    id,
    name,
    description: `${name}, as asked`,
    personality: `${name} personality`,
    context: `${name} about`,
    createdAt: '2026-10-09T10:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
    poses: {
      idle: `videorc-asset://buddy/library/${id}/idle-0a1b2c3d.png`,
      talk: null,
      laugh: null,
      think: null
    },
    alive: null
  }
}

function library(patch: Partial<BuddyLibraryState> = {}): BuddyLibraryState {
  return {
    signedIn: true,
    official: BUDDY_OFFICIAL_CATALOG.map(({ description: _description, alive, ...rest }) => ({
      ...rest,
      alive: officialAliveFallback({ alive })
    })),
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
      name: 'Buddy',
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

function fakeBackend(initial: BuddyLibraryState = library(), refuseSync = false) {
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
      case 'cohost.library.saveToLibrary':
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
    } as unknown as BuddyLookClient,
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

async function render(
  client: BuddyLookClient,
  cohost: CohostSettings = settings(),
  aiCapabilities: AiCapabilities | null = null
): Promise<void> {
  mocked.core = {
    account: { status: 'signed-in' },
    aiCapabilities,
    aiConsent: true,
    cohostGate: { allowed: true },
    cohostSettings: cohost,
    patchCohostSettings: vi.fn(async () => undefined),
    runtimeInfo: { platform: 'darwin' },
    setAiConsent: vi.fn(),
    connection: null,
    wsStatus: 'disconnected'
  }
  await act(async () => root.render(createElement(BuddyLibrarySection, { client })))
  await settle()
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)
const card = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="buddy-library-card"][data-id="${id}"]`)!

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await settle()
}

async function openMenu(id: string): Promise<HTMLElement[]> {
  const trigger = card(id).querySelector<HTMLElement>('[data-testid="buddy-library-more"]')!
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  await settle()
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

describe('BuddyLibrarySection: My Buddies (plan 170 D16)', () => {
  it('groups the official five and yours, badges the active one and uses another', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const official = byTestId('buddy-library-official')!
    const mine = byTestId('buddy-library-mine')!
    expect(official.textContent).toContain(BUDDY_LIBRARY_COPY.official)
    expect(mine.textContent).toContain(BUDDY_LIBRARY_COPY.mine)
    expect(
      [...official.querySelectorAll<HTMLElement>('[data-testid="buddy-library-card"]')].map(
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
      [...mine.querySelectorAll<HTMLElement>('[data-testid="buddy-library-card"]')].map(
        (element) => element.dataset.id
      )
    ).toEqual([GRUM, PEBBLE])
    // The active one: badged, no Use.
    expect(card(GRUM).querySelector('[data-testid="buddy-library-active"]')?.textContent).toBe(
      'Active'
    )
    expect(card(GRUM).querySelector('[data-testid="buddy-library-use"]')).toBeNull()
    expect(card(GRUM).querySelector('img')?.getAttribute('src')).toBe(
      `videorc-asset://buddy/library/${GRUM}/idle-0a1b2c3d.png`
    )
    await click(
      card('official:orc').querySelector<HTMLElement>('[data-testid="buddy-library-use"]')
    )
    expect(backend.calls('cohost.library.use')).toEqual([{ avatarId: 'official:orc' }])
  })

  it('syncs as the tab opens; a refused automatic sync stays quiet', async () => {
    const backend = fakeBackend(library(), true)
    await render(backend.client)
    expect(backend.calls('cohost.library.sync')).toEqual([{ reason: 'tab' }])
    expect(byTestId('buddy-library-error')).toBeNull()
  })

  it('shows a running job calmly: the syncing mark, the busy card, every action waiting', async () => {
    await render(fakeBackend(library({ busy: { kind: 'use', avatarId: 'official:robot' } })).client)
    expect(card('official:robot').dataset.busy).toBe('true')
    expect(
      card('official:orc').querySelector<HTMLButtonElement>('[data-testid="buddy-library-use"]')!
        .disabled
    ).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(fakeBackend(library({ busy: { kind: 'sync' } })).client)
    expect(byTestId('buddy-library-syncing')).not.toBeNull()
  })

  it('says what failed in the backend words', async () => {
    await render(
      fakeBackend(library({ error: { code: 'network', message: 'Could not reach Videorc.' } }))
        .client
    )
    expect(byTestId('buddy-library-error')?.textContent).toBe('Could not reach Videorc.')
  })

  it('signed out: the official five only, with the sign-in line', async () => {
    await render(
      fakeBackend(library({ signedIn: false, mine: null, activeAvatarId: 'official:golem' })).client
    )
    expect(document.querySelectorAll('[data-testid="buddy-library-card"]')).toHaveLength(5)
    const signedOut = byTestId('buddy-library-signed-out')!
    expect(signedOut.textContent).toContain(BUDDY_LIBRARY_COPY.signedOut)
    await click(signedOut.querySelector('button'))
    expect(mocked.signIn).toHaveBeenCalledOnce()
  })

  it('a library it could not list says why, not that it is empty', async () => {
    // QA 2026-10-11: offline, My Buddies said "Buddies you create show up
    // here" while the account had three.
    const message = 'Could not reach Videorc. Check your connection and try again.'
    await render(fakeBackend(library({ mine: null, error: { code: 'network', message } })).client)
    const mine = byTestId('buddy-library-mine')!
    expect(mine.textContent).not.toContain(BUDDY_LIBRARY_COPY.emptyMine)
    expect(byTestId('buddy-library-error')?.textContent).toBe(message)
  })

  it('an empty library says where your Buddies will show up', async () => {
    await render(fakeBackend(library({ mine: [] })).client)
    expect(byTestId('buddy-library-empty')?.textContent).toBe(BUDDY_LIBRARY_COPY.emptyMine)
  })

  it('offers the Buddy picked on videorc.com with Use', async () => {
    const backend = fakeBackend(library({ activeAvatarId: null, serverActiveAvatarId: PEBBLE }))
    await render(backend.client)
    expect(byTestId('buddy-library-picked-elsewhere')?.textContent).toContain(
      'Pebble was picked on videorc.com.'
    )
    await click(byTestId('buddy-library-picked-elsewhere-use'))
    expect(backend.calls('cohost.library.use')).toEqual([{ avatarId: PEBBLE }])
  })

  it('menus: your own get Rename, Edit personality, Make it Alive and Delete; an official one without its pack only Make it Alive', async () => {
    // Official Buddies whose pack is here or downloadable show Alive and no
    // menu (plan 172 D12); the menu case is an official one with no pack.
    await render(
      fakeBackend(
        library({
          official: library().official.map((entry) =>
            entry.slug === 'goblin' ? { ...entry, alive: 'none' as const } : entry
          )
        })
      ).client
    )
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
    const input = document.getElementById('buddy-library-name') as HTMLInputElement
    expect(input.value).toBe('Pebble')
    const save = byTestId<HTMLButtonElement>('buddy-library-save')!
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
    const about = document.getElementById('buddy-library-about') as HTMLTextAreaElement
    expect(about.value).toBe('Pebble about')
    expect(
      (document.getElementById('buddy-library-personality') as HTMLTextAreaElement).value
    ).toBe('Pebble personality')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        about,
        'I stream on Fridays.'
      )
      about.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(byTestId('buddy-library-save'))
    expect(backend.calls('cohost.library.update')).toEqual([
      { avatarId: PEBBLE, context: 'I stream on Fridays.' }
    ])
  })

  it('deletes one of yours only after the confirm', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const items = await openMenu(PEBBLE)
    await click(items.find((item) => item.textContent?.includes('Delete')))
    const dialog = byTestId('buddy-library-delete-dialog')!
    expect(dialog.textContent).toContain('Delete Pebble?')
    expect(dialog.textContent).toContain(BUDDY_LIBRARY_COPY.deleteBody)
    expect(backend.calls('cohost.library.delete')).toEqual([])
    await click(byTestId('buddy-library-delete-confirm'))
    expect(backend.calls('cohost.library.delete')).toEqual([{ avatarId: PEBBLE }])
  })

  it('Make it Alive uses the Buddy first, then opens the creator once it is the Buddy', async () => {
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

  it('says Alive on Buddies that move, and keeps Make it Alive for the rest (plan 172 D12)', async () => {
    const PACK = '0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a'
    const states = ['bundled', 'downloaded', 'available', 'none', 'none'] as const
    await render(
      fakeBackend(
        library({
          official: library().official.map((entry, index) => ({ ...entry, alive: states[index]! })),
          mine: [
            { ...entry(GRUM, 'Grum'), alive: { packId: PACK, cellSize: 640 } },
            entry(PEBBLE, 'Pebble')
          ]
        })
      ).client
    )
    const tagged = (id: string) =>
      card(id).querySelector('[data-testid="buddy-library-alive-tag"]')?.textContent ?? null
    expect(
      ['official:golem', 'official:orc', 'official:goblin', 'official:pirate', GRUM, PEBBLE].map(
        tagged
      )
    ).toEqual([
      BUDDY_LIBRARY_COPY.alive,
      BUDDY_LIBRARY_COPY.alive,
      BUDDY_LIBRARY_COPY.alive,
      null,
      BUDDY_LIBRARY_COPY.alive,
      null
    ])
    // QA 2026-10-11: the tag sits on the art (Nib's ear ran through it), so
    // it has the opaque floating fill under its glass, never see-through.
    const tag = card('official:golem').querySelector('[data-testid="buddy-library-alive-tag"]')!
    expect(tag.className.split(/\s+/)).toContain('bg-popover')
    // An alive official Buddy has nothing more to offer; one without a pack does.
    expect(card('official:orc').querySelector('[data-testid="buddy-library-more"]')).toBeNull()
    const labels = (items: HTMLElement[]) => items.map((item) => item.textContent?.trim())
    expect(labels(await openMenu('official:pirate'))).toEqual(['Make it Alive'])
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await settle()
    expect(labels(await openMenu(GRUM))).toEqual(['Rename', 'Edit personality', 'Delete'])
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await settle()
    expect(labels(await openMenu(PEBBLE))).toContain('Make it Alive')
  })

  it('says what a pack or import job is doing while it runs', async () => {
    const backend = fakeBackend(
      library({ busy: { kind: 'alive-download', avatarId: 'official:orc' } })
    )
    await render(backend.client)
    expect(byTestId('buddy-library-busy')?.textContent).toBe("Downloading Golmar's moves.")
    expect(card('official:orc').dataset.busy).toBe('true')
    await act(async () =>
      backend.emit(
        'cohost.library.changed',
        library({ busy: { kind: 'alive-upload', avatarId: GRUM } })
      )
    )
    await settle()
    expect(byTestId('buddy-library-busy')?.textContent).toBe("Saving Grum's moves to your library.")
    await act(async () =>
      backend.emit(
        'cohost.library.changed',
        library({ activeAvatarId: null, busy: { kind: 'import' } })
      )
    )
    await settle()
    expect(byTestId('buddy-library-busy')?.textContent).toBe('Saving Buddy to your library.')
    await act(async () => backend.emit('cohost.library.changed', library()))
    await settle()
    expect(byTestId('buddy-library-busy')).toBeNull()
  })

  it('offers Save to my library for a Buddy made only here (plan 172 D10)', async () => {
    const keeps = {
      cohost: { buddyLibrary: { enabled: true, count: 2, limit: 30, alive: true } }
    } as unknown as AiCapabilities
    const own = settings({
      name: 'Mossback',
      source: 'uploaded',
      images: { idle: 'default/idle-0a0a0a0a.png' }
    })
    const backend = fakeBackend(library({ activeAvatarId: null }))
    await render(backend.client, own, keeps)
    const offer = byTestId('buddy-library-local-only')!
    expect(offer.textContent).toContain('Mossback is only on this computer.')
    await click(byTestId('buddy-library-save-to-library'))
    expect(backend.calls('cohost.library.saveToLibrary')).toEqual([undefined])
    // Not for a linked Buddy, nor when the web cannot keep it.
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(fakeBackend(library({ activeAvatarId: GRUM })).client, own, keeps)
    expect(byTestId('buddy-library-local-only')).toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(fakeBackend(library({ activeAvatarId: null })).client, own, null)
    expect(byTestId('buddy-library-local-only')).toBeNull()
  })

  it('Make it Alive on the active Buddy opens the creator at once', async () => {
    const backend = fakeBackend()
    await render(backend.client)
    const items = await openMenu(GRUM)
    await click(items.find((item) => item.textContent?.includes('Make it Alive')))
    expect(backend.calls('cohost.library.use')).toEqual([])
    expect(mocked.openCreator).toHaveBeenCalledWith({ reference: 'persona-idle' })
  })

  it('invites the untouched default Buddy into the onboarding, until dismissed', async () => {
    const backend = fakeBackend(library({ activeAvatarId: 'official:golem' }))
    await render(backend.client, settings({ source: 'default' }))
    expect(byTestId('buddy-library-invitation')?.textContent).toContain(
      BUDDY_LIBRARY_COPY.invitation
    )
    await click(byTestId('buddy-library-invitation-start'))
    const sheet = await vi.waitFor(() => {
      const element = byTestId('buddy-onboarding')
      expect(element).not.toBeNull()
      return element!
    })
    expect(sheet.dataset.step).toBe('1')
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await settle()
    await click(byTestId('buddy-library-invitation-dismiss'))
    expect(byTestId('buddy-library-invitation')).toBeNull()
    expect(localStorage.getItem(BUDDY_INVITATION_STORAGE_KEY)).toBe('1')
  })

  it('never invites a Buddy of your own, or once dismissed on this machine', async () => {
    await render(fakeBackend(library({ activeAvatarId: GRUM })).client, settings())
    expect(byTestId('buddy-library-invitation')).toBeNull()
    await act(async () => root.unmount())
    localStorage.setItem(BUDDY_INVITATION_STORAGE_KEY, '1')
    root = createRoot(container)
    await render(
      fakeBackend(library({ activeAvatarId: 'official:golem' })).client,
      settings({ source: 'default' })
    )
    expect(byTestId('buddy-library-invitation')).toBeNull()
  })

  it('New Buddy opens the onboarding on step 1', async () => {
    await render(fakeBackend().client)
    await click(byTestId('buddy-library-new'))
    const sheet = await vi.waitFor(() => {
      const element = byTestId('buddy-onboarding')
      expect(element).not.toBeNull()
      return element!
    })
    expect(sheet.dataset.step).toBe('1')
  })
})
