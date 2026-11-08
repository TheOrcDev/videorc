// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PersonCardBody } from '@/components/community/person-card-body'
import type { CommunityPerson } from '@/lib/backend'
import type { CommunityRelayCall } from '../../../../shared/community-relay'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ada: CommunityPerson = {
  id: 'p-ada',
  name: 'Ada',
  accounts: [
    {
      accountKey: 'twitch:t1',
      platform: 'twitch',
      authorId: 't1',
      name: 'Ada',
      handle: 'ada',
      firstSeenAt: '2026-03-02T18:00:00Z',
      lastSeenAt: '2026-11-08T18:00:00Z'
    },
    {
      accountKey: 'youtube:UCada',
      platform: 'youtube',
      authorId: 'UCada',
      name: 'ada_dev',
      firstSeenAt: '2026-10-20T18:00:00Z',
      lastSeenAt: '2026-11-01T18:00:00Z'
    }
  ],
  streams: 14,
  messages: 812,
  inARow: 5,
  bestInARow: 6,
  regular: true,
  firstSeenAt: '2026-03-02T18:00:00Z',
  lastSeenAt: '2026-11-08T18:00:00Z',
  support: { bits: 4500, giftedSubs: 3 },
  note: 'Learning Rust',
  status: 'normal',
  youtube: true,
  suggestions: [
    {
      accountA: {
        accountKey: 'kick:k9',
        platform: 'kick',
        authorId: 'k9',
        name: 'MaxPlays',
        firstSeenAt: '2026-10-01T18:00:00Z',
        lastSeenAt: '2026-10-01T18:00:00Z'
      },
      accountB: {
        accountKey: 'twitch:t1',
        platform: 'twitch',
        authorId: 't1',
        name: 'Ada',
        firstSeenAt: '2026-03-02T18:00:00Z',
        lastSeenAt: '2026-11-08T18:00:00Z'
      },
      reason: 'name',
      createdAt: '2026-11-01T18:00:00Z'
    }
  ]
}

async function mount(
  person: CommunityPerson,
  options: { locked?: boolean } = {}
): Promise<ReturnType<typeof vi.fn>> {
  const call = vi.fn(async (method: string) => {
    if (method === 'cohost.community.person') return person
    if (method === 'cohost.community.wave') return { accepted: true }
    throw new Error(`unexpected ${method}`)
  })
  await act(async () => {
    root.render(
      createElement(PersonCardBody, {
        call: call as unknown as CommunityRelayCall,
        memoryLock: options.locked
          ? createElement('p', null, 'Buddy remembers what your regulars tell it with Premium.')
          : null,
        target: { platform: 'twitch', authorId: 't1', name: 'Ada' }
      })
    )
  })
  return call
}

const text = (): string => container.textContent ?? ''

describe('the person card (plan 225 D11)', () => {
  it('loads the person on open by the row account and shows the card lines', async () => {
    const call = await mount(ada)
    expect(call).toHaveBeenCalledWith('cohost.community.person', {
      platform: 'twitch',
      authorId: 't1',
      name: 'Ada'
    })
    expect(text()).toContain('Twitch · ada')
    expect(text()).toContain('YouTube · ada_dev')
    expect(text()).toContain('14 streams · since March 2026 · 5 in a row · 812 messages')
    expect(text()).toContain('4,500 bits · 3 gifted subs')
    expect(text()).toContain('Might be the same as MaxPlays on Kick')
    expect(text()).toContain(
      "YouTube viewers are remembered for 30 days after they chat (YouTube's rules)."
    )
    // Linked: each account can be split off.
    expect(
      [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Not the same')
    ).toHaveLength(3)
    expect(container.querySelector('textarea')?.value).toBe('Learning Rust')
  })

  it('keeps Buddy remembers on screen behind its lock, never hidden', async () => {
    await mount(ada, { locked: true })
    expect(container.querySelector('[data-testid="person-card-memory-lock"]')).not.toBeNull()
    expect(text()).toContain('Buddy remembers what your regulars tell it with Premium.')
  })

  it('waves through the bubble call and never anything that posts', async () => {
    const call = await mount(ada)
    const wave = container.querySelector<HTMLButtonElement>('[data-testid="person-card-wave"]')
    await act(async () => {
      wave?.click()
    })
    expect(call).toHaveBeenCalledWith('cohost.community.wave', { personId: 'p-ada' })
    expect(call.mock.calls.map(([method]) => method)).not.toContain('liveChat.send')
  })

  it('refuses Same person as… for an X account, with the reason', async () => {
    await mount({
      ...ada,
      youtube: false,
      suggestions: [],
      accounts: [{ ...ada.accounts[0]!, accountKey: 'x:1', platform: 'x', authorId: '1' }]
    })
    const same = container.querySelector<HTMLButtonElement>(
      '[data-testid="person-card-same-person"]'
    )
    expect(same?.disabled).toBe(true)
    expect(text()).not.toContain('YouTube viewers are remembered')
  })
})
