import { describe, expect, it } from 'vitest'

import {
  cameBackWords,
  countsAsUnread,
  entriesToDrop,
  mergeReports,
  notificationCount,
  popUpDecision,
  POP_UP_MS,
  PRESS_ANSWER_POP_UP_MS,
  REALERT_AFTER_MS,
  repeatWords,
  sortEntries,
  spanWords,
  URGENT_POP_UP_MS,
  type NotificationReport,
  type PopUpQuestion
} from '@/lib/notifications/policy'
import type { NotificationEntry, NotificationTone } from '@/lib/notifications/types'

function question(patch: Partial<PopUpQuestion>): PopUpQuestion {
  return {
    change: 'opened',
    tone: 'warning',
    hasDetail: false,
    live: false,
    quiet: true,
    listOpen: false,
    now: 1_000_000,
    ...patch
  }
}

function entry(patch: Partial<NotificationEntry>): NotificationEntry {
  return {
    key: 'k',
    kind: 'watchdog',
    tone: 'warning',
    peakTone: patch.tone ?? 'warning',
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

describe('popUpDecision (plan 250, "What pops up")', () => {
  // The plan's table: tone by idle, recording or live with quiet on, quiet off.
  const table: [NotificationTone, number | null, number | null, number | null][] = [
    ['urgent', URGENT_POP_UP_MS, URGENT_POP_UP_MS, URGENT_POP_UP_MS],
    ['warning', POP_UP_MS, null, POP_UP_MS],
    ['done', POP_UP_MS, null, POP_UP_MS],
    ['news', null, null, null]
  ]
  it.each(table)('%s: idle, live and quiet, quiet off', (tone, idle, quietLive, loudLive) => {
    expect(popUpDecision(question({ tone, live: false, quiet: true }))).toBe(idle)
    expect(popUpDecision(question({ tone, live: false, quiet: false }))).toBe(idle)
    expect(popUpDecision(question({ tone, live: true, quiet: true }))).toBe(quietLive)
    expect(popUpDecision(question({ tone, live: true, quiet: false }))).toBe(loudLive)
  })

  it('the late answer to a press pops up briefly, quiet or not', () => {
    for (const live of [false, true]) {
      expect(popUpDecision(question({ tone: 'done', answersAPress: true, live }))).toBe(
        PRESS_ANSWER_POP_UP_MS
      )
      expect(
        popUpDecision(question({ tone: 'news', answersAPress: true, hasDetail: true, live }))
      ).toBe(POP_UP_MS)
      expect(
        popUpDecision(question({ tone: 'warning', answersAPress: true, popUpMs: 6_000, live }))
      ).toBe(6_000)
    }
  })

  it('nothing pops up while the list is open', () => {
    expect(popUpDecision(question({ tone: 'urgent', listOpen: true }))).toBeNull()
    expect(popUpDecision(question({ answersAPress: true, listOpen: true }))).toBeNull()
  })

  it('once per episode: an update or a flap never pops up again', () => {
    expect(popUpDecision(question({ tone: 'urgent', change: 'updated' }))).toBeNull()
    expect(popUpDecision(question({ tone: 'urgent', change: 'flapped' }))).toBeNull()
  })

  it('getting worse pops up again', () => {
    expect(
      popUpDecision(
        question({
          tone: 'urgent',
          change: 'escalated',
          live: true,
          lastPop: { at: 999_000, tone: 'warning' }
        })
      )
    ).toBe(URGENT_POP_UP_MS)
  })

  it('coming back pops up only after five minutes of being fine', () => {
    const lastPop = { at: 0, tone: 'urgent' as const }
    const back = (fineForMs: number): number | null =>
      popUpDecision(question({ tone: 'urgent', change: 'returned', lastPop, fineForMs }))
    expect(back(REALERT_AFTER_MS - 1)).toBeNull()
    expect(back(REALERT_AFTER_MS)).toBe(URGENT_POP_UP_MS)
    // It never popped up before (it opened while quiet): the table decides.
    expect(popUpDecision(question({ tone: 'urgent', change: 'returned', fineForMs: 90_000 }))).toBe(
      URGENT_POP_UP_MS
    )
    // Back and worse than what popped up last time.
    expect(
      popUpDecision(
        question({
          tone: 'urgent',
          change: 'returned',
          fineForMs: 90_000,
          lastPop: { at: 0, tone: 'warning' }
        })
      )
    ).toBe(URGENT_POP_UP_MS)
  })

  it('an event that repeats pops up again only five minutes after its last pop-up', () => {
    const repeat = (now: number): number | null =>
      popUpDecision(
        question({ tone: 'warning', change: 'repeated', now, lastPop: { at: 0, tone: 'warning' } })
      )
    expect(repeat(REALERT_AFTER_MS - 1)).toBeNull()
    expect(repeat(REALERT_AFTER_MS)).toBe(POP_UP_MS)
  })
})

describe('countsAsUnread (plan 250, "What the number counts")', () => {
  const rows: [string, Partial<NotificationEntry>, boolean][] = [
    ['an unread urgent problem', { tone: 'urgent' }, true],
    ['an unread warning', { tone: 'warning' }, true],
    ['open news', { tone: 'news' }, false],
    ['a read warning', { tone: 'warning', read: true }, false],
    [
      'a warning that cleared on its own',
      { state: 'resolved', tone: 'done', peakTone: 'warning' },
      false
    ],
    [
      'an urgent problem that cleared, not seen',
      { state: 'resolved', tone: 'done', peakTone: 'urgent' },
      true
    ],
    [
      'an urgent problem that cleared, seen',
      { state: 'resolved', tone: 'done', peakTone: 'urgent', read: true },
      false
    ],
    ['news that happened', { state: 'happened', tone: 'news', life: 'event' }, false],
    ['finished work', { state: 'happened', tone: 'done', life: 'event' }, true],
    ['an error that happened', { state: 'happened', tone: 'warning', life: 'event' }, true],
    ['work in progress', { state: 'running', tone: 'news', life: 'progress' }, false],
    ['work that finished', { state: 'done', tone: 'done', life: 'progress' }, true],
    ['work that failed', { state: 'failed', tone: 'warning', life: 'progress' }, true]
  ]
  it.each(rows)('%s', (_name, patch, counts) => {
    expect(countsAsUnread(entry(patch))).toBe(counts)
  })
})

describe('notificationCount', () => {
  it('keeps the tone while a problem is open, even with nothing unread', () => {
    expect(notificationCount([entry({ tone: 'warning', read: true })])).toEqual({
      unread: 0,
      urgent: 0,
      tone: 'warning'
    })
    expect(
      notificationCount([
        entry({ tone: 'urgent', read: true }),
        entry({ key: 'b', tone: 'warning' })
      ])
    ).toEqual({ unread: 1, urgent: 1, tone: 'urgent' })
  })

  it('drops the tone when the problem resolved, and counts what waits', () => {
    expect(
      notificationCount([
        entry({ state: 'resolved', tone: 'done', peakTone: 'urgent' }),
        entry({ key: 'b', state: 'happened', tone: 'done', life: 'event' }),
        entry({ key: 'c', state: 'happened', tone: 'news', life: 'event' })
      ])
    ).toEqual({ unread: 2, urgent: 0, tone: null })
  })

  it('a problem that happened once tints the bell until it has been seen', () => {
    const stopped = entry({ state: 'happened', tone: 'urgent', life: 'event' })
    expect(notificationCount([stopped]).tone).toBe('urgent')
    expect(notificationCount([{ ...stopped, read: true }]).tone).toBeNull()
  })
})

describe('mergeReports (plan 250, "One entry per subject")', () => {
  const report = (patch: Partial<NotificationReport>): NotificationReport => ({
    source: 'health',
    tone: 'warning',
    title: 'Microphone is silent',
    actions: [],
    lead: false,
    at: 0,
    ...patch
  })
  const action = (label: string) => ({ id: label, label, kind: 'door' as const, run: () => {} })

  it('the worse tone wins and the watchdog leads the words and the buttons', () => {
    const merged = mergeReports([
      report({ tone: 'urgent', title: 'Microphone lost', actions: [action('Open Audio')] }),
      report({
        source: 'watchdog:1',
        lead: true,
        title: 'Microphone is silent',
        detail: 'No sound for 40 s.',
        actions: [action('Unmute')]
      })
    ])
    expect(merged).toMatchObject({
      tone: 'urgent',
      title: 'Microphone is silent',
      detail: 'No sound for 40 s.'
    })
    expect(merged?.actions.map((item) => item.label)).toEqual(['Unmute', 'Open Audio'])
  })

  it('never shows more than two buttons, and never the same one twice', () => {
    const merged = mergeReports([
      report({ lead: true, actions: [action('Unmute'), action('Open Audio')] }),
      report({ source: 'other', actions: [action('Open Audio'), action('Open Health')] })
    ])
    expect(merged?.actions.map((item) => item.label)).toEqual(['Unmute', 'Open Audio'])
  })

  it('without a leader the worst report speaks, then the newest', () => {
    expect(
      mergeReports([
        report({ title: 'older', at: 1 }),
        report({ source: 'b', title: 'newer', at: 2 }),
        report({ source: 'c', title: 'worst', tone: 'urgent', at: 0 })
      ])?.title
    ).toBe('worst')
    expect(
      mergeReports([
        report({ title: 'older', at: 1 }),
        report({ source: 'b', title: 'newer', at: 2 })
      ])?.title
    ).toBe('newer')
    expect(mergeReports([])).toBeNull()
  })
})

describe('the list (plan 250, "The dropdown", "How long it keeps things")', () => {
  it('orders Now by tone, then work in progress, then the rest newest first', () => {
    const sorted = sortEntries([
      entry({ key: 'old', state: 'resolved', tone: 'done', updatedAt: 1 }),
      entry({ key: 'work', state: 'running', life: 'progress', tone: 'news', updatedAt: 9 }),
      entry({ key: 'warn', tone: 'warning', updatedAt: 5 }),
      entry({ key: 'new', state: 'happened', life: 'event', tone: 'done', updatedAt: 8 }),
      entry({ key: 'urgent', tone: 'urgent', updatedAt: 2 })
    ])
    expect(sorted.map((item) => item.key)).toEqual(['urgent', 'warn', 'work', 'new', 'old'])
  })

  it('keeps the newest 50 and never drops an open problem', () => {
    const open = Array.from({ length: 4 }, (_, index) => entry({ key: `open-${index}` }))
    const earlier = Array.from({ length: 50 }, (_, index) =>
      entry({ key: `earlier-${index}`, state: 'resolved', tone: 'done', updatedAt: index })
    )
    expect(entriesToDrop([...open, ...earlier])).toEqual([
      'earlier-0',
      'earlier-1',
      'earlier-2',
      'earlier-3'
    ])
    expect(entriesToDrop(open, 2)).toEqual([])
  })
})

describe('words', () => {
  it('says how long a problem lasted', () => {
    expect(spanWords(400)).toBe('1 s')
    expect(spanWords(38_000)).toBe('38 s')
    expect(spanWords(120_000)).toBe('2 min')
    expect(spanWords(65 * 60_000)).toBe('1 h 5 min')
    expect(spanWords(2 * 60 * 60_000)).toBe('2 h')
  })

  it('says a repeat and a comeback in the detail', () => {
    expect(repeatWords(1)).toBeUndefined()
    expect(repeatWords(2)).toBe('Twice.')
    expect(repeatWords(3)).toBe('3 times.')
    expect(cameBackWords(0)).toBeUndefined()
    expect(cameBackWords(1)).toBe('Came back once.')
    expect(cameBackWords(3)).toBe('Came back 3 times.')
  })
})
