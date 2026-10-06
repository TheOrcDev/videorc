import { describe, expect, it } from 'vitest'

import type { LiveChatEventDetails, LiveChatMessage, StreamPlatform } from '@/lib/backend'

import {
  AUTO_SHOW_MAX_AGE_MS,
  AUTO_SHOW_MAX_PENDING,
  activityAutoShowEligible,
  enqueueAutoShow,
  seedAutoShowQueue,
  takeNextAutoShow
} from './activity-auto-highlight'

// Rows shaped like the backend's plan 055 fixtures (stream-activity.test.ts
// uses the same construction).
let sequence = 0
function row(
  platform: StreamPlatform,
  authorName: string,
  eventType: LiveChatMessage['eventType'],
  details: LiveChatEventDetails | undefined,
  messageText = '',
  receivedAt = `2026-09-24T10:00:${String(sequence).padStart(2, '0')}Z`
): LiveChatMessage {
  sequence += 1
  return {
    id: `s:${platform}:${sequence}`,
    providerMessageId: String(sequence),
    platform,
    sessionId: 's',
    authorId: `${authorName}-id`,
    authorName,
    authorBadges: [],
    authorRoles: [],
    publishedAt: receivedAt,
    receivedAt,
    messageText,
    fragments: [],
    eventType,
    isDeleted: false,
    ...(details ? { details } : {})
  }
}

const NOW = Date.parse('2026-09-24T10:00:30Z')

const celebrations: { label: string; message: LiveChatMessage }[] = [
  { label: 'follow', message: row('twitch', 'f', 'follow', { kind: 'follow' }) },
  {
    label: 'subscription',
    message: row('twitch', 's', 'membership', {
      kind: 'subscription',
      subscription: 'sub',
      tier: '1000',
      isPrime: false
    })
  },
  {
    label: 'membership',
    message: row('youtube', 'm', 'membership', { kind: 'membership', membership: 'new' })
  },
  { label: 'cheer', message: row('twitch', 'c', 'paid', { kind: 'cheer', bits: 100 }, 'Cheer100') },
  { label: 'kicks', message: row('kick', 'k', 'paid', { kind: 'kicks', amount: 50 }) },
  {
    label: 'super-chat',
    message: row(
      'youtube',
      'sc',
      'paid',
      {
        kind: 'super-chat',
        amountDisplay: '$5.00',
        amountMicros: 5_000_000,
        currency: 'USD'
      },
      'great stream'
    )
  },
  {
    label: 'super-sticker',
    message: row('youtube', 'ss', 'paid', {
      kind: 'super-sticker',
      amountDisplay: '$2.00',
      amountMicros: 2_000_000,
      currency: 'USD'
    })
  },
  { label: 'raid', message: row('twitch', 'r', 'system', { kind: 'raid', viewerCount: 42 }) },
  {
    label: 'watch-streak',
    message: row('twitch', 'w', 'membership', { kind: 'watch-streak', streakCount: 5 })
  }
]

describe('activityAutoShowEligible (plan 156, D2)', () => {
  for (const { label, message } of celebrations) {
    it(`auto-shows a ${label}`, () => {
      expect(activityAutoShowEligible(message)).toBe(true)
    })
  }

  it('never auto-shows an announcement', () => {
    const announcement = row('twitch', 'mod', 'system', { kind: 'announcement' }, 'Be nice')
    expect(activityAutoShowEligible(announcement)).toBe(false)
  })

  it('never auto-shows a deleted row', () => {
    const deleted = { ...celebrations[1].message, isDeleted: true }
    expect(activityAutoShowEligible(deleted)).toBe(false)
  })

  it('never auto-shows a details-less notice', () => {
    expect(activityAutoShowEligible(row('twitch', 'sys', 'system', undefined, 'text'))).toBe(false)
  })

  it('skips a community-gift single: its community notice fires once', () => {
    const single = row('twitch', 'generous', 'membership', {
      kind: 'subscription',
      subscription: 'sub-gift',
      tier: '1000',
      isPrime: false,
      recipientName: 'lucky',
      communityGiftId: 'gift-batch-1'
    })
    expect(activityAutoShowEligible(single)).toBe(false)
    const community = row('twitch', 'generous', 'membership', {
      kind: 'subscription',
      subscription: 'community-sub-gift',
      tier: '1000',
      isPrime: false,
      giftCount: 5,
      communityGiftId: 'gift-batch-1'
    })
    expect(activityAutoShowEligible(community)).toBe(true)
    const standalone = row('twitch', 'gifter', 'membership', {
      kind: 'subscription',
      subscription: 'sub-gift',
      tier: '1000',
      isPrime: false,
      recipientName: 'lucky'
    })
    expect(activityAutoShowEligible(standalone)).toBe(true)
  })
})

describe('seedAutoShowQueue (plan 156, D7)', () => {
  it('marks the backlog seen with nothing pending', () => {
    const backlog = celebrations.map((entry) => entry.message)
    const queue = seedAutoShowQueue(backlog)
    expect(queue.pending).toEqual([])
    for (const message of backlog) expect(queue.seen.has(message.id)).toBe(true)
    // Nothing from the backlog ever fires.
    expect(enqueueAutoShow(queue, backlog)).toBe(queue)
  })
})

describe('enqueueAutoShow (plan 156, D4)', () => {
  it('appends unseen eligible ids and marks ineligible ids seen', () => {
    const follow = row('twitch', 'f2', 'follow', { kind: 'follow' })
    const announcement = row('twitch', 'mod2', 'system', { kind: 'announcement' }, 'rules')
    const queue = enqueueAutoShow(seedAutoShowQueue([]), [follow, announcement])
    expect(queue.pending).toEqual([follow.id])
    expect(queue.seen.has(announcement.id)).toBe(true)
    // Already-seen rows never re-enter, and no-change returns the same object.
    expect(enqueueAutoShow(queue, [follow, announcement])).toBe(queue)
  })

  it(`keeps at most ${AUTO_SHOW_MAX_PENDING} pending, dropping the oldest`, () => {
    const follows = Array.from({ length: AUTO_SHOW_MAX_PENDING + 2 }, (_, index) =>
      row('twitch', `fan${index}`, 'follow', { kind: 'follow' })
    )
    const queue = enqueueAutoShow(seedAutoShowQueue([]), follows)
    expect(queue.pending).toEqual(follows.slice(2).map((message) => message.id))
  })
})

describe('takeNextAutoShow (plan 156, D4)', () => {
  it('pops in FIFO order', () => {
    const first = row('twitch', 'one', 'follow', { kind: 'follow' }, '', '2026-09-24T10:00:10Z')
    const second = row('twitch', 'two', 'follow', { kind: 'follow' }, '', '2026-09-24T10:00:20Z')
    const messages = [first, second]
    const queue = enqueueAutoShow(seedAutoShowQueue([]), messages)
    const popped = takeNextAutoShow(queue, messages, NOW)
    expect(popped.message?.id).toBe(first.id)
    const next = takeNextAutoShow(popped.queue, messages, NOW)
    expect(next.message?.id).toBe(second.id)
    expect(takeNextAutoShow(next.queue, messages, NOW).message).toBeNull()
  })

  it('skips vanished, since-deleted and stale entries', () => {
    const vanished = row('twitch', 'gone', 'follow', { kind: 'follow' }, '', '2026-09-24T10:00:20Z')
    const stale = row('twitch', 'old', 'follow', { kind: 'follow' }, '', '2026-09-24T09:00:00Z')
    const removed = row('twitch', 'del', 'follow', { kind: 'follow' }, '', '2026-09-24T10:00:21Z')
    const fresh = row('twitch', 'new', 'follow', { kind: 'follow' }, '', '2026-09-24T10:00:25Z')
    const queue = enqueueAutoShow(seedAutoShowQueue([]), [vanished, stale, removed, fresh])
    // Cap is 3 (plan 156, D4): the oldest pending id was dropped.
    expect(queue.pending).toEqual([stale.id, removed.id, fresh.id])
    // By drain time, `removed` was moderated away and `vanished` left the
    // snapshot entirely; `stale` outlived the freshness window.
    const atDrain = [stale, { ...removed, isDeleted: true }, fresh]
    const popped = takeNextAutoShow(queue, atDrain, NOW)
    expect(popped.message?.id).toBe(fresh.id)
    expect(popped.queue.pending).toEqual([])
    expect(NOW - Date.parse(stale.receivedAt)).toBeGreaterThan(AUTO_SHOW_MAX_AGE_MS)
  })

  it('a deleted row never enters the queue at all', () => {
    const deleted = {
      ...row('twitch', 'muted', 'follow', { kind: 'follow' }, '', '2026-09-24T10:00:22Z'),
      isDeleted: true
    }
    const queue = enqueueAutoShow(seedAutoShowQueue([]), [deleted])
    expect(queue.pending).toEqual([])
    expect(queue.seen.has(deleted.id)).toBe(true)
  })

  it('returns null on an empty queue without allocating', () => {
    const queue = seedAutoShowQueue([])
    const result = takeNextAutoShow(queue, [], NOW)
    expect(result.message).toBeNull()
    expect(result.queue).toBe(queue)
  })
})
