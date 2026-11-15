// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostSettings } from '@/lib/backend'
import type { AvatarTabId } from '@/lib/avatar-tabs'
import { closeBuddyPetCreator, openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

import { AvatarTab } from './avatar-tab'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

// The sections have their own tests; here a marker shows where each sits, so
// the page's test is about the page: its tabs, its status row and its order.
vi.mock('@/components/buddy-library-section', async () => {
  const { createElement } = await import('react')
  return { BuddyLibrarySection: () => createElement('section', { 'data-testid': 'buddy-library' }) }
})
vi.mock('@/components/buddy-persona-section', async () => {
  const { createElement } = await import('react')
  return { BuddyPersonaSection: () => createElement('section', { 'data-testid': 'buddy-persona' }) }
})
vi.mock('@/components/buddy-pet-settings', async () => {
  const { createElement } = await import('react')
  return { BuddyPetSettings: () => createElement('section', { 'data-testid': 'buddy-pet' }) }
})
vi.mock('@/components/buddy-greetings-section', async () => {
  const { createElement } = await import('react')
  return {
    BuddyGreetingsSection: () => createElement('section', { 'data-testid': 'buddy-greetings' })
  }
})
vi.mock('@/components/buddy-pet-creator', async () => {
  const { createElement } = await import('react')
  return {
    BuddyPetCreator: () => createElement('div', { 'data-testid': 'buddy-pet-creator' })
  }
})
vi.mock('@/hooks/use-buddy-look', () => ({
  BuddyLookClientProvider: ({ children }: { children: ReactNode }) => children
}))

let root: Root
let container: HTMLDivElement
const onTabChange = vi.fn((_tab: AvatarTabId) => undefined)

function persona(overrides: Partial<CohostSettings['persona']> = {}): CohostSettings['persona'] {
  return {
    id: 'p1',
    name: 'Archie',
    personality: '',
    bubbleStyle: 'speech',
    images: { idle: 'p1/idle-0a1b2c3d.png' },
    source: 'generated',
    avatar: { kind: 'still' },
    motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
    reactions: {},
    ...overrides
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onTabChange.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => closeBuddyPetCreator())
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render({
  name = 'Archie',
  showOnStream = false,
  showInRecording = false,
  tab
}: {
  name?: string
  showOnStream?: boolean
  showInRecording?: boolean
  tab?: AvatarTabId
} = {}): Promise<void> {
  mocked.core = {
    cohostSettings: { persona: persona({ name }) },
    overlayLayout: { buddy: { showOnStream, showInRecording } },
    runtimeInfo: { platform: 'darwin' }
  }
  await act(async () =>
    root.render(
      createElement(AvatarTab, tab === undefined ? {} : { tab, onTabChange: onTabChange })
    )
  )
}

function stripTabs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-videorc-avatar-tab]')]
}

function selectedTab(): string | null {
  return (
    document
      .querySelector('[data-videorc-avatar-tab][data-active]')
      ?.getAttribute('data-videorc-avatar-tab') ?? null
  )
}

function status(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="avatar-status"]')
  expect(element).toBeTruthy()
  return element!
}

function follows(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

describe('the Avatar page (plan 239)', () => {
  it('lists Profile and Greetings in its strip and opens on Profile', async () => {
    await render()
    expect(document.querySelector('[data-testid="avatar-tab"]')).toBeTruthy()
    expect(stripTabs().map((tab) => tab.textContent)).toEqual(['Profile', 'Greetings'])
    expect(selectedTab()).toBe('profile')
  })

  it("leads Profile with the avatar's status row, then My avatars, the name and the look", async () => {
    await render()
    const row = status()
    const library = document.querySelector('[data-testid="buddy-library"]')!
    const personaSection = document.querySelector('[data-testid="buddy-persona"]')!
    const look = document.querySelector('[data-testid="buddy-pet"]')!
    expect(follows(row, library)).toBe(true)
    expect(follows(library, personaSection)).toBe(true)
    expect(follows(personaSection, look)).toBe(true)
    // The greetings are their own tab; the status row lives on Profile only.
    expect(document.querySelector('[data-testid="buddy-greetings"]')).toBeNull()
    // The avatar's own picture and name: the emblem artwork stays with avatars.
    const emblem = row.querySelector('[data-slot="buddy-emblem"]')
    expect(emblem?.getAttribute('data-picture')).toBe('own')
    expect(emblem?.getAttribute('src')).toBe('videorc-asset://buddy/p1/idle-0a1b2c3d.png')
    expect(row.querySelector('[data-slot="avatar-status-name"]')?.textContent).toBe('Archie')
    expect(row.querySelector('[data-slot="sidekick-mark"]')).toBeNull()
    expect(row.textContent).not.toContain('Sidekick')
  })

  it('says where viewers see it, and holds no third copy of the on-stream switches', async () => {
    await render({ showOnStream: true, showInRecording: true })
    const placement = status().querySelector<HTMLElement>('[data-slot="avatar-placement"]')!
    expect(placement.dataset.placement).toBe('both')
    expect(placement.textContent).toBe('On stream and in recordings')
    await render({ showOnStream: false, showInRecording: true })
    expect(status().querySelector('[data-slot="avatar-placement"]')?.textContent).toBe(
      'In recordings, not on stream'
    )
    // The switches keep their homes: the Scene canvas and the Stream Manager.
    expect(status().querySelector('[role="switch"]')).toBeNull()
  })

  it('opens the Scene page from its status row, with that page key', async () => {
    const navigations: unknown[] = []
    const listen = (event: Event): void => void navigations.push((event as CustomEvent).detail)
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, listen)
    try {
      await render()
      const place = [...status().querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Place on Scene')
      )!
      expect(place.textContent).toContain('⌘3')
      await act(async () => place.click())
      expect(navigations).toEqual([{ tab: 'layouts' }])
    } finally {
      window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, listen)
    }
  })

  it('says how to put it on stream in its status row while it is not (plan 174 G-2)', async () => {
    await render({ showOnStream: false })
    const note = status().querySelector('[data-testid="buddy-on-stream-note"]')
    expect(note?.textContent).toBe(
      "Archie isn't on stream yet. In Stream Manager, turn on “Archie on stream” to show it."
    )
    // One note, in the status row, nowhere else.
    expect(document.querySelectorAll('[data-testid="buddy-on-stream-note"]')).toHaveLength(1)
    // On stream already (with or without the recording): no note.
    await render({ showOnStream: true })
    expect(document.querySelector('[data-testid="buddy-on-stream-note"]')).toBeNull()
    // Recording only still is not the stream.
    await render({ showOnStream: false, showInRecording: true })
    expect(document.querySelector('[data-testid="buddy-on-stream-note"]')).toBeTruthy()
  })

  it("falls back to the default avatar's name, Flint (plan 239 D2)", async () => {
    await render({ name: '  ' })
    expect(status().querySelector('[data-slot="avatar-status-name"]')?.textContent).toBe('Flint')
    expect(status().querySelector('[data-testid="buddy-on-stream-note"]')?.textContent).toContain(
      '“Flint on stream”'
    )
  })

  it('shows the greetings on their own tab, and asks the shell to change tabs', async () => {
    await render({ tab: 'greetings' })
    expect(selectedTab()).toBe('greetings')
    expect(document.querySelector('[data-testid="buddy-greetings"]')).toBeTruthy()
    expect(document.querySelector('[data-slot="avatar-status"]')).toBeNull()
    expect(document.querySelector('[data-testid="buddy-library"]')).toBeNull()
    const profile = document.querySelector<HTMLElement>('[data-videorc-avatar-tab="profile"]')!
    await act(async () => profile.click())
    expect(onTabChange).toHaveBeenLastCalledWith('profile')
  })

  it('switches its own tab when rendered without the shell', async () => {
    await render()
    const greetings = document.querySelector<HTMLElement>('[data-videorc-avatar-tab="greetings"]')!
    await act(async () => greetings.click())
    expect(selectedTab()).toBe('greetings')
    expect(document.querySelector('[data-testid="buddy-greetings"]')).toBeTruthy()
  })

  it('opens the Alive creator over Profile, hiding the sections under it', async () => {
    await render()
    expect(document.querySelector('[data-testid="buddy-pet-creator"]')).toBeNull()
    await act(async () => openBuddyPetCreator())
    expect(document.querySelector('[data-testid="buddy-pet-creator"]')).toBeTruthy()
    expect(status().parentElement?.classList.contains('hidden')).toBe(true)
    await act(async () => closeBuddyPetCreator())
    expect(document.querySelector('[data-testid="buddy-pet-creator"]')).toBeNull()
  })
})
