import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store is tested against its own small registry, so the tests do not
// move every time a slice adds a kind.
vi.mock('@/lib/notifications/kinds', async (original) => {
  const actual = await original<typeof import('@/lib/notifications/kinds')>()
  return {
    ...actual,
    NOTIFICATION_KINDS: {
      problem: { tone: 'warning', life: 'condition', mayBe: ['urgent', 'news'] },
      news: { tone: 'news', life: 'event' },
      finished: { tone: 'done', life: 'event' },
      failure: { tone: 'urgent', life: 'event' },
      answer: { tone: 'done', life: 'event', answersAPress: true },
      work: { tone: 'news', life: 'progress' }
    }
  }
})

import type { NotificationKindId } from '@/lib/notifications/kinds'
import { FLAP_WINDOW_MS, REALERT_AFTER_MS } from '@/lib/notifications/policy'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'
import type {
  NotificationCount,
  NotificationEntry,
  NotificationInput
} from '@/lib/notifications/types'

const kind = (id: string): NotificationKindId => id as NotificationKindId

describe('the notification store (plan 250)', () => {
  let clock = 0
  let live = false
  let quiet = true
  let store: NotificationStore
  let counts: NotificationCount[] = []
  const door = { show: vi.fn(), resolved: vi.fn(), dismiss: vi.fn() }

  const problem = (patch: Partial<NotificationInput> = {}): NotificationInput => ({
    key: 'microphone',
    kind: kind('problem'),
    title: 'Microphone is silent',
    ...patch
  })
  const only = (): NotificationEntry => {
    expect(store.snapshot()).toHaveLength(1)
    return store.snapshot()[0]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    clock = 1_000_000
    live = false
    quiet = true
    counts = []
    store = createNotificationStore({
      now: () => clock,
      live: () => live,
      quiet: () => quiet,
      onCount: (count) => counts.push(count)
    })
    store.setPopUpDoor(door)
  })

  describe('one entry per subject', () => {
    it('a second report about the same subject updates the entry in place', () => {
      store.publish(problem({ detail: 'No sound for 5 s.' }))
      clock += 1_000
      store.publish(problem({ detail: 'No sound for 6 s.' }))
      expect(only()).toMatchObject({ detail: 'No sound for 6 s.', state: 'open', occurrences: 1 })
      expect(door.show).toHaveBeenCalledTimes(1)
    })

    it('two systems on one subject: the watchdog leads, the worse tone wins', () => {
      store.publish(problem({ source: 'health', tone: 'urgent', title: 'Microphone lost' }))
      store.publish(
        problem({
          source: 'watchdog:7',
          lead: true,
          detail: 'No sound for 40 s.',
          actions: [{ id: 'unmute', label: 'Unmute', kind: 'fix', run: () => {} }]
        })
      )
      expect(only()).toMatchObject({
        tone: 'urgent',
        title: 'Microphone is silent',
        detail: 'No sound for 40 s.',
        actions: [{ id: 'unmute', label: 'Unmute', kind: 'fix' }]
      })
    })

    it('resolves only when every report on it has cleared', () => {
      store.publish(problem({ source: 'health', tone: 'urgent', title: 'Microphone lost' }))
      store.publish(problem({ source: 'watchdog:7', lead: true }))
      store.resolve('microphone', { source: 'watchdog:7', title: 'Microphone has sound again' })
      expect(only()).toMatchObject({ state: 'open', title: 'Microphone lost', tone: 'urgent' })
      clock += 38_000
      store.resolve('microphone', { source: 'health', title: 'Microphone is back' })
      expect(only()).toMatchObject({
        state: 'resolved',
        tone: 'done',
        peakTone: 'urgent',
        title: 'Microphone is back',
        detail: 'It lasted 38 s.',
        actions: []
      })
    })

    it('a recovery from a system that reported nothing changes nothing', () => {
      store.publish(problem({ source: 'health' }))
      store.resolve('microphone', { source: 'watchdog:7' })
      store.resolve('nothing-here')
      expect(only().state).toBe('open')
    })

    it('says how long it lasted in the recovery words', () => {
      store.publish(problem({ key: 'stream-delivery', title: 'Your stream is choppy' }))
      clock += 38_000
      store.resolve('stream-delivery', {
        title: 'Your stream is smooth again',
        was: 'It was choppy'
      })
      expect(only()).toMatchObject({
        title: 'Your stream is smooth again',
        detail: 'It was choppy for 38 s.'
      })
    })

    it('a withdrawn report leaves no resolved entry', () => {
      store.publish(problem({ source: 'watchdog:7' }))
      store.withdraw('microphone', 'watchdog:7')
      expect(store.snapshot()).toEqual([])
      expect(door.dismiss).toHaveBeenCalledWith('microphone')
    })
  })

  describe('what pops up', () => {
    it('idle: a warning pops up for 8 s with its first action', () => {
      const run = vi.fn()
      store.publish(problem({ actions: [{ id: 'open', label: 'Open Audio', kind: 'door', run }] }))
      expect(door.show).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'microphone' }),
        8_000,
        expect.objectContaining({ label: 'Open Audio' })
      )
    })

    it('recording or live with quiet on: only an urgent problem pops up, once', () => {
      live = true
      store.publish(problem())
      store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
      expect(door.show).not.toHaveBeenCalled()
      store.publish(problem({ key: 'stream', tone: 'urgent', title: 'Your stream is frozen' }))
      store.publish(problem({ key: 'stream', tone: 'urgent', title: 'Your stream is frozen' }))
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(door.show.mock.calls[0][1]).toBe(15_000)
    })

    it('quiet off: warnings and finished work pop up while live', () => {
      live = true
      quiet = false
      store.publish(problem())
      store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
      expect(door.show).toHaveBeenCalledTimes(2)
    })

    it('news never pops up', () => {
      store.publish({ key: 'blip', kind: kind('news'), title: 'Microphone silenced for a moment' })
      expect(door.show).not.toHaveBeenCalled()
    })

    it('the late answer to a press pops up while live and quiet', () => {
      live = true
      store.publish({ key: 'clip:1', kind: kind('answer'), title: 'Clip saved' })
      expect(door.show.mock.calls[0][1]).toBe(4_000)
    })

    it('a warning that becomes urgent is one entry that pops up', () => {
      live = true
      store.publish(problem())
      store.markRead('microphone')
      store.publish(problem({ tone: 'urgent', title: 'Microphone lost' }))
      expect(only()).toMatchObject({ tone: 'urgent', read: false })
      expect(door.show).toHaveBeenCalledTimes(1)
    })

    it('nothing pops up while the list is open', () => {
      store.setListOpen(true)
      store.publish(problem({ tone: 'urgent' }))
      expect(door.show).not.toHaveBeenCalled()
      expect(only().tone).toBe('urgent')
    })

    it('a recovery never pops up: the door only hears that it resolved', () => {
      store.publish(problem())
      store.resolve('microphone', { title: 'Microphone is back' })
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(door.resolved).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Microphone is back', state: 'resolved' })
      )
    })

    it('work in progress shows no toast; finishing follows the table', () => {
      store.publish({ key: 'mp4:1', kind: kind('work'), title: 'Exporting MP4' })
      expect(door.show).not.toHaveBeenCalled()
      expect(only()).toMatchObject({ state: 'running' })
      store.publish({ key: 'mp4:1', kind: kind('work'), state: 'done', title: 'MP4 ready' })
      expect(only()).toMatchObject({ state: 'done', tone: 'done', title: 'MP4 ready' })
      expect(door.show).toHaveBeenCalledTimes(1)
      store.publish({
        key: 'mp4:2',
        kind: kind('work'),
        state: 'failed',
        title: 'MP4 export failed'
      })
      expect(store.snapshot().find((entry) => entry.key === 'mp4:2')).toMatchObject({
        state: 'failed',
        tone: 'warning'
      })
    })
  })

  describe('what the number counts', () => {
    const last = (): NotificationCount => store.count()

    it('counts unread problems and finished work, never news', () => {
      store.publish(problem())
      store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
      store.publish({ key: 'blip', kind: kind('news'), title: 'A blip' })
      expect(last()).toEqual({ unread: 2, urgent: 0, tone: 'warning' })
      expect(counts.at(-1)).toEqual(last())
    })

    it('a warning that cleared on its own stops counting and stays in the list', () => {
      store.publish(problem())
      store.resolve('microphone')
      expect(last()).toEqual({ unread: 0, urgent: 0, tone: null })
      expect(only().state).toBe('resolved')
    })

    it('an urgent problem that cleared counts until it has been seen', () => {
      store.publish(problem({ tone: 'urgent' }))
      store.resolve('microphone')
      expect(last()).toEqual({ unread: 1, urgent: 0, tone: null })
      store.markAllRead()
      expect(last().unread).toBe(0)
    })

    it('reading keeps the tone while the problem is open', () => {
      store.publish(problem({ tone: 'urgent' }))
      store.markAllRead()
      expect(last()).toEqual({ unread: 0, urgent: 1, tone: 'urgent' })
    })
  })

  describe('flapping', () => {
    it('cleared and back within 60 s is the same episode', () => {
      store.publish(problem({ detail: 'No sound.' }))
      store.markRead('microphone')
      clock += 10_000
      store.resolve('microphone')
      clock += FLAP_WINDOW_MS - 1
      store.publish(problem({ detail: 'No sound.' }))
      expect(only()).toMatchObject({
        state: 'open',
        read: true,
        detail: 'No sound. Came back once.',
        openedAt: 1_000_000
      })
      store.resolve('microphone')
      clock += 1_000
      store.publish(problem({ detail: 'No sound.' }))
      expect(only().detail).toBe('No sound. Came back 2 times.')
      expect(door.show).toHaveBeenCalledTimes(1)
    })

    it('back after longer is a new episode: unread, but no pop-up inside five minutes', () => {
      store.publish(problem())
      store.markRead('microphone')
      store.resolve('microphone')
      clock += FLAP_WINDOW_MS
      store.publish(problem())
      expect(only()).toMatchObject({ state: 'open', read: false, openedAt: clock })
      expect(door.show).toHaveBeenCalledTimes(1)
      store.resolve('microphone')
      clock += REALERT_AFTER_MS
      store.publish(problem())
      expect(door.show).toHaveBeenCalledTimes(2)
    })

    it('a blip that repeats is one counted entry with the time of the last one', () => {
      const blip = {
        key: 'microphone-blip',
        kind: kind('news'),
        title: 'Microphone silenced for a moment'
      }
      store.publish(blip)
      clock += 5_000
      store.publish(blip)
      clock += 5_000
      store.publish(blip)
      expect(only()).toMatchObject({ occurrences: 3, detail: '3 times.', updatedAt: clock })
    })
  })

  describe('when the session ends', () => {
    it('resolves the conditions that belong to it and leaves the rest', () => {
      store.publish(problem({ sessionId: 's1', detail: 'No sound.' }))
      store.publish(problem({ key: 'shortcuts', title: "Global shortcuts didn't register" }))
      store.publish(problem({ key: 'other', sessionId: 's2' }))
      store.sessionEnded('livestream', 's1')
      const byKey = Object.fromEntries(store.snapshot().map((entry) => [entry.key, entry]))
      expect(byKey.microphone).toMatchObject({
        state: 'resolved',
        title: 'Microphone is silent',
        detail: 'No sound. Ended with the livestream.'
      })
      expect(byKey.shortcuts.state).toBe('open')
      expect(byKey.other.state).toBe('open')
      store.sessionEnded('recording')
      expect(store.snapshot().find((entry) => entry.key === 'other')).toMatchObject({
        state: 'resolved',
        detail: 'Ended with the recording.'
      })
    })
  })

  describe('clearing', () => {
    it('Clear on a finished entry removes it', () => {
      store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
      store.clear('saved')
      expect(store.snapshot()).toEqual([])
    })

    it('Clear on an open problem means "I know": it goes, and tells its reporter', () => {
      const onClear = vi.fn()
      store.publish(problem({ source: 'watchdog:7', onClear }))
      store.clear('microphone')
      expect(store.snapshot()).toEqual([])
      expect(store.count()).toEqual({ unread: 0, urgent: 0, tone: null })
      expect(onClear).toHaveBeenCalledTimes(1)
      expect(door.dismiss).toHaveBeenCalledWith('microphone')
      // The same report again: still cleared.
      store.publish(problem({ source: 'watchdog:7', onClear, detail: 'No sound for 50 s.' }))
      expect(store.snapshot()).toEqual([])
      expect(store.has('microphone')).toBe(false)
    })

    it('a cleared problem comes back when it gets worse', () => {
      store.publish(problem())
      store.clear('microphone')
      store.publish(problem({ tone: 'urgent', title: 'Microphone lost' }))
      expect(only()).toMatchObject({ tone: 'urgent', read: false })
      expect(door.show).toHaveBeenCalledTimes(2)
    })

    it('a cleared problem comes back when it ends and starts again, not when it flaps', () => {
      store.publish(problem())
      store.clear('microphone')
      store.resolve('microphone')
      expect(store.snapshot()).toEqual([])
      clock += 5_000
      store.publish(problem())
      expect(store.snapshot()).toEqual([])
      store.resolve('microphone')
      clock += FLAP_WINDOW_MS
      store.publish(problem())
      expect(only().state).toBe('open')
    })

    it('Clear all removes what is no longer true and keeps open problems', () => {
      store.publish(problem({ tone: 'urgent' }))
      store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
      store.publish(problem({ key: 'gone', title: 'Gone' }))
      store.resolve('gone')
      store.publish({ key: 'mp4', kind: kind('work'), title: 'Exporting MP4' })
      store.clearAll()
      expect(store.snapshot().map((entry) => entry.key)).toEqual(['microphone', 'mp4'])
    })
  })

  describe('how long it keeps things', () => {
    it('keeps the newest 50 and never drops an open problem', () => {
      store.publish(problem())
      for (let index = 0; index < 55; index += 1) {
        clock += 1
        store.publish({ key: `saved:${index}`, kind: kind('finished'), title: 'Recording saved' })
      }
      const keys = store.snapshot().map((entry) => entry.key)
      expect(keys).toHaveLength(50)
      expect(keys[0]).toBe('microphone')
      expect(keys).toContain('saved:54')
      expect(keys).not.toContain('saved:5')
    })
  })

  describe('actions', () => {
    it('runs the function behind an entry button and marks the entry read', async () => {
      const run = vi.fn()
      store.publish(problem({ actions: [{ id: 'unmute', label: 'Unmute', kind: 'fix', run }] }))
      await store.runAction('microphone', 'unmute')
      await store.runAction('microphone', 'missing')
      expect(run).toHaveBeenCalledTimes(1)
      expect(only().read).toBe(true)
    })

    it('tells its subscribers, with a stable snapshot between changes', () => {
      const listener = vi.fn()
      const off = store.subscribe(listener)
      store.publish(problem())
      const first = store.snapshot()
      expect(store.snapshot()).toBe(first)
      expect(listener).toHaveBeenCalledTimes(1)
      off()
      store.publish(problem({ detail: 'again' }))
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
})
