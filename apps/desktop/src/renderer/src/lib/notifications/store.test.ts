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
    // A recording with "Quiet while recording or live" off: the one row of
    // the table where every tone but news pops up, so these tests see the
    // rules that decide when. Idle is the bell only.
    live = true
    quiet = false
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

  describe('at launch (the owner, 2026-11-22: no stack of toasts when you open the app)', () => {
    let pressed = false
    const launching = (): NotificationStore => {
      pressed = false
      const fresh = createNotificationStore({
        now: () => clock,
        live: () => live,
        quiet: () => quiet,
        pressed: () => pressed,
        launchQuietMs: 60_000
      })
      fresh.setPopUpDoor(door)
      return fresh
    }

    it('what Videorc finds in the first minute waits behind the bell, counted', () => {
      const fresh = launching()
      fresh.publish(problem({ key: 'host-overloaded', title: 'This computer is overloaded' }))
      fresh.publish(problem({ key: 'global-shortcuts', title: "A shortcut didn't register" }))
      fresh.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
      fresh.publish({ key: 'failed', kind: kind('failure'), title: 'Videorc needs a restart' })
      expect(door.show).not.toHaveBeenCalled()
      expect(fresh.count()).toMatchObject({ unread: 4, tone: 'urgent' })
    })

    it('a press does not let a startup check through, but its own answer speaks', () => {
      const fresh = launching()
      pressed = true
      fresh.publish(problem({ key: 'host-overloaded', title: 'This computer is overloaded' }))
      expect(door.show).not.toHaveBeenCalled()
      fresh.publish({ key: 'clip', kind: kind('answer'), title: 'Clip saved' })
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(door.show.mock.calls[0][0]).toMatchObject({ key: 'clip' })
    })

    it('an urgent problem pops up in a recording the streamer started in that minute', () => {
      const fresh = launching()
      fresh.publish({ key: 'early', kind: kind('failure'), title: 'Recording stopped' })
      expect(door.show).not.toHaveBeenCalled()
      pressed = true
      live = true
      fresh.publish({ key: 'late', kind: kind('failure'), title: 'Your stream stopped' })
      expect(door.show).toHaveBeenCalledTimes(1)
    })

    it('after the first minute the plan 250 rules apply again; launch entries never pop up late', () => {
      const fresh = launching()
      fresh.publish(problem({ detail: 'No sound for 5 s.' }))
      clock += 61_000
      fresh.publish(problem({ detail: 'No sound for 66 s.' }))
      expect(door.show).not.toHaveBeenCalled()
      fresh.publish(problem({ key: 'disk-space', title: 'Recording space is low' }))
      expect(door.show).toHaveBeenCalledTimes(1)
    })
  })

  describe('what pops up', () => {
    it('idle: nothing Videorc noticed pops up, at any time; it waits behind the bell', () => {
      live = false
      clock += 10 * 60_000
      store.publish(problem())
      store.publish(problem({ key: 'stream', tone: 'urgent', title: 'Videorc needs a restart' }))
      store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
      expect(door.show).not.toHaveBeenCalled()
      expect(store.count()).toMatchObject({ unread: 3, tone: 'urgent' })
      // The answer to a press still speaks.
      store.publish({ key: 'clip:1', kind: kind('answer'), title: 'Clip saved' })
      expect(door.show).toHaveBeenCalledTimes(1)
    })

    it('a warning pops up for 8 s with its first action', () => {
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
      quiet = true
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
      quiet = true
      store.publish({ key: 'clip:1', kind: kind('answer'), title: 'Clip saved' })
      expect(door.show.mock.calls[0][1]).toBe(4_000)
    })

    it('a warning that becomes urgent is one entry that pops up', () => {
      live = true
      quiet = true
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
        detail: 'Came back once. No sound.',
        openedAt: 1_000_000
      })
      store.resolve('microphone')
      clock += 1_000
      store.publish(problem({ detail: 'No sound.' }))
      expect(only().detail).toBe('Came back 2 times. No sound.')
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

    it('one happening two systems report is not a repeat', () => {
      store.publish({
        key: 'failed:s1',
        kind: kind('failure'),
        title: 'The disk is full',
        once: true
      })
      store.markRead('failed:s1')
      store.publish({
        key: 'failed:s1',
        kind: kind('failure'),
        title: 'The disk is full',
        detail: 'Free some space.',
        once: true
      })
      expect(only()).toMatchObject({ occurrences: 1, detail: 'Free some space.', read: true })
      expect(door.show).toHaveBeenCalledTimes(1)
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
      // Not a recovery: no green tick, and the problem's toast simply goes.
      expect(byKey.microphone).toMatchObject({
        state: 'resolved',
        tone: 'news',
        title: 'Microphone is silent',
        detail: 'No sound. Ended with the livestream.'
      })
      expect(door.resolved).not.toHaveBeenCalled()
      expect(door.dismiss).toHaveBeenCalledWith('microphone')
      expect(byKey.shortcuts.state).toBe('open')
      expect(byKey.other.state).toBe('open')
      store.sessionEnded('recording')
      expect(store.snapshot().find((entry) => entry.key === 'other')).toMatchObject({
        state: 'resolved',
        detail: 'Ended with the recording.'
      })
    })
  })

  describe('which session ended', () => {
    it('a test of the id leaves another kind of session alone', () => {
      store.publish(problem({ sessionId: 's1' }))
      store.publish(problem({ key: 'cloud-status', sessionId: 'cloud:sh_1' }))
      store.sessionEnded('recording', (id) => !id.startsWith('cloud:'))
      const byKey = Object.fromEntries(store.snapshot().map((entry) => [entry.key, entry.state]))
      expect(byKey).toEqual({ microphone: 'resolved', 'cloud-status': 'open' })
    })
  })

  describe('the next session', () => {
    it('the same subject in the next session is a new problem, not a flap', () => {
      live = true
      store.publish(problem({ tone: 'urgent', sessionId: 's1' }))
      store.markRead('microphone')
      clock += 5_000
      store.sessionEnded('livestream', 's1')
      clock += 5_000
      store.publish(problem({ tone: 'urgent', sessionId: 's2' }))
      // Inside the flap window and inside five minutes, and still news: it
      // is unread, it pops up, and it says nothing about coming back.
      expect(only()).toMatchObject({
        state: 'open',
        read: false,
        sessionId: 's2',
        openedAt: clock,
        detail: undefined
      })
      expect(door.show).toHaveBeenCalledTimes(2)
    })
  })

  describe('the next session, after a problem that had already cleared', () => {
    it('is a new problem too: unread, and it pops up', () => {
      live = true
      store.publish(problem({ tone: 'urgent', sessionId: 's1' }))
      store.markRead('microphone')
      clock += 5_000
      store.resolve('microphone', { title: 'Microphone is back' })
      const resolved = only()
      store.sessionEnded('livestream', 's1')
      // The session's end changes nothing about a row that had recovered.
      expect(only()).toEqual(resolved)
      clock += 5_000
      store.publish(problem({ tone: 'urgent', sessionId: 's2' }))
      expect(only()).toMatchObject({
        state: 'open',
        read: false,
        sessionId: 's2',
        openedAt: clock,
        detail: undefined
      })
      expect(door.show).toHaveBeenCalledTimes(2)
    })
  })

  describe('an urgent problem that swings', () => {
    it('pops up once, not on every swing back to urgent', () => {
      live = true
      store.publish(problem({ tone: 'urgent' }))
      for (let swing = 0; swing < 3; swing += 1) {
        clock += 10_000
        store.publish(problem({ tone: 'warning' }))
        clock += 10_000
        store.publish(problem({ tone: 'urgent' }))
      }
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(only()).toMatchObject({ tone: 'urgent', read: false })
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

    it('Clear all and a reset take the toasts of what they remove with them', () => {
      const onClear = vi.fn()
      store.publish(problem({ tone: 'urgent' }))
      store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved', onClear })
      store.clearAll()
      // The finished entry's toast would have a button that does nothing.
      expect(door.dismiss.mock.calls).toEqual([['saved']])
      expect(onClear).toHaveBeenCalledTimes(1)
      store.reset()
      expect(door.dismiss).toHaveBeenLastCalledWith('microphone')
      expect(store.snapshot()).toEqual([])
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
