// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommunityPersonRow, CommunitySuggestion, CommunitySummary } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

const client = vi.hoisted(() => ({
  summary: null as CommunitySummary | null,
  people: [] as CommunityPersonRow[],
  suggestions: [] as CommunitySuggestion[],
  call: vi.fn()
}))
const studio = vi.hoisted(() => ({
  gate: { allowed: true } as EntitlementUiGate,
  patch: vi.fn(async () => undefined)
}))

vi.mock('@/hooks/use-community', () => ({
  useCommunityClient: () => ({
    call: client.call,
    summary: client.summary,
    revision: 0,
    ready: true,
    offline: false,
    bump: () => undefined
  })
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    cohostGate: studio.gate,
    cohostSettings: null,
    patchCohostSettings: studio.patch
  })
}))
// happy-dom lays nothing out: the list draws every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 32 })),
    getTotalSize: () => count * 32
  })
}))
vi.mock('@/components/community/community-preview', () => ({
  CommunityPreview: () => null
}))

const { default: CommunityTab } = await import('@/components/community/community-tab')

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client.summary = null
  client.people = []
  client.suggestions = []
  studio.gate = { allowed: true }
  client.call.mockImplementation(async (method: string) => {
    if (method === 'cohost.community.list') return { people: client.people }
    if (method === 'cohost.community.suggestions') return { suggestions: client.suggestions }
    if (method === 'cohost.community.forgetAll') return { accepted: true }
    throw new Error(`unexpected ${method}`)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(CommunityTab))
  })
  // The list asks after its 150 ms debounce.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
}

const text = (): string => container.textContent ?? ''
const account = (platform: 'twitch' | 'kick' | 'x', name: string) => ({
  accountKey: `${platform}:${name}`,
  platform,
  authorId: name,
  name,
  firstSeenAt: '2026-10-01T18:00:00Z',
  lastSeenAt: '2026-10-01T18:00:00Z'
})

describe('Buddy → Community (plan 225 D12)', () => {
  it('starts empty: the next-stream line and no regulars yet', async () => {
    await mount()
    expect(text()).toContain('Videorc starts remembering your chat from your next stream.')
    expect(text()).toContain('No regulars yet')
    // No suggestions: the section is not there at all.
    expect(container.querySelector('[data-testid="community-links"]')).toBeNull()
    expect(text()).toContain(
      "YouTube viewers are remembered for 30 days after they chat (YouTube's rules)."
    )
  })

  it('shows the backfill while it reads past streams', async () => {
    client.summary = {
      people: 40,
      regulars: 2,
      streams: 12,
      newRegularsThisWeek: 0,
      linksPending: 0,
      backfill: { state: 'running', done: 5, total: 12 }
    }
    await mount()
    expect(text()).toContain(
      'Videorc knows 40 people from your 12 streams on this computer. 2 are regulars.'
    )
    expect(text()).toContain('Reading your past streams… 5 of 12')
    expect(container.querySelector('[data-slot="progress"]')).not.toBeNull()
  })

  it('lists people with their platforms, and the links that need you', async () => {
    client.people = [
      {
        id: 'p-ada',
        name: 'Ada',
        platforms: ['twitch', 'youtube'],
        streams: 14,
        regular: true,
        lastSeenAt: new Date().toISOString(),
        status: 'normal'
      },
      {
        id: 'p-bot',
        name: 'Nightbot',
        platforms: ['twitch'],
        streams: 9,
        regular: false,
        status: 'bot'
      }
    ]
    client.suggestions = [
      {
        accountA: account('kick', 'MaxPlays'),
        accountB: account('twitch', 'maxplays'),
        reason: 'name',
        createdAt: '2026-11-01T18:00:00Z'
      },
      {
        accountA: account('x', 'pixel'),
        accountB: account('twitch', 'pixel42'),
        reason: 'link-cancelled',
        createdAt: '2026-11-01T18:00:00Z'
      }
    ]
    await mount()
    const rows = container.querySelectorAll('[data-testid="community-person-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Ada')
    expect(rows[0]?.textContent).toContain('Regular')
    expect(rows[0]?.textContent).toContain('14 streams · today')
    expect(rows[1]?.textContent).toContain('Bot')
    const links = container.querySelectorAll('[data-testid="community-link-row"]')
    expect(links).toHaveLength(2)
    expect(links[1]?.textContent).toContain('!link cancelled')
    expect(links[0]?.textContent).toContain('Same person')
    expect(links[0]?.textContent).toContain('Not the same')
  })

  it('keeps the Premium rows on screen, locked and disabled, never hidden', async () => {
    studio.gate = {
      allowed: false,
      featureId: 'cohost',
      reason: 'Buddy Live is part of Premium.',
      upgradeUrl: 'https://videorc.com/premium'
    } as unknown as EntitlementUiGate
    await mount()
    const premium = container.querySelector('[data-testid="community-premium"]')
    expect(premium?.textContent).toContain('Buddy remembers')
    expect(premium?.textContent).toContain('Community sync')
    expect(premium?.textContent).toContain(
      'Buddy remembers what your regulars tell it with Premium.'
    )
    const switches = premium?.querySelectorAll('[role="switch"]') ?? []
    expect(
      [...switches].every(
        (element) =>
          element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('data-disabled')
      )
    ).toBe(true)
  })

  it('asks before forgetting everyone, then forgets', async () => {
    await mount()
    const forget = container.querySelector<HTMLButtonElement>(
      '[data-testid="community-forget-all"]'
    )
    await act(async () => forget?.click())
    expect(document.body.textContent).toContain('Forget everyone?')
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="community-forget-all-confirm"]'
    )
    await act(async () => confirm?.click())
    expect(client.call).toHaveBeenCalledWith('cohost.community.forgetAll', undefined)
  })
})
