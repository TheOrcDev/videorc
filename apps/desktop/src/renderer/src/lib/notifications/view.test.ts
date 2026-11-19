import { describe, expect, it } from 'vitest'

import type { NotificationEntry } from '@/lib/notifications/types'
import { groupNotifications, hasClearable, notificationTimeWords } from '@/lib/notifications/view'

function entry(patch: Partial<NotificationEntry>): NotificationEntry {
  return {
    key: 'k',
    kind: 'watchdog',
    tone: 'warning',
    peakTone: 'warning',
    life: 'condition',
    state: 'open',
    title: 'Title',
    openedAt: 0,
    updatedAt: 0,
    occurrences: 1,
    read: false,
    actions: [],
    ...patch
  }
}

describe('the list (plan 250, "The dropdown")', () => {
  it('splits what is still true from the rest, and labels only when both show', () => {
    const open = entry({ key: 'open' })
    const work = entry({ key: 'work', state: 'running', life: 'progress' })
    const done = entry({ key: 'done', state: 'resolved', tone: 'done' })
    expect(groupNotifications([open, work, done])).toEqual({
      now: [open, work],
      earlier: [done],
      labelled: true
    })
    expect(groupNotifications([done]).labelled).toBe(false)
    expect(hasClearable([open, work])).toBe(false)
    expect(hasClearable([open, done])).toBe(true)
  })

  it('an open problem shows how long it has been open', () => {
    const open = entry({ openedAt: 1_000 })
    expect(notificationTimeWords(open, 1_000)).toBe('0:00')
    expect(notificationTimeWords(open, 41_000)).toBe('0:40')
    expect(notificationTimeWords(open, 1_000 + 2 * 60_000)).toBe('2 min')
    expect(notificationTimeWords(open, 1_000 + 3 * 3_600_000)).toBe('3 h')
  })

  it('everything else shows how long ago it happened', () => {
    const done = entry({ state: 'resolved', updatedAt: 0, resolvedAt: 10_000 })
    expect(notificationTimeWords(done, 20_000)).toBe('now')
    expect(notificationTimeWords(done, 10_000 + 50_000)).toBe('1 min')
    expect(notificationTimeWords(done, 10_000 + 14 * 60_000)).toBe('14 min')
    expect(notificationTimeWords(done, 10_000 + 26 * 3_600_000)).toBe('1 d')
  })
})
