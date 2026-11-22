import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudStatus } from '@/lib/backend'
import {
  announceCloud,
  publishCloudController,
  publishCloudRejoin,
  publishCloudStatus,
  withdrawCloudController,
  withdrawCloudRejoin
} from '@/lib/notifications/sources/cloud'
import { sessionEndedNotifications } from '@/lib/notifications/sources/health'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'
import { guardToastText, TOAST_DETAILS_SAVED } from '@/lib/toast'

const base: CloudStatus = {
  phase: 'hold',
  entitled: true,
  settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [1800] },
  show: { id: 'sh_1', nodeId: 'livekit', resumable: true, kind: 'solo' },
  connected: true,
  directFallbackAvailable: false
}
const takenOver = (name: string): CloudStatus => ({
  ...base,
  onAir: {
    name,
    kind: 'computer',
    source: 'feed',
    waiting: false,
    thisDevice: false,
    since: '2026-11-16T20:01:02.000Z'
  },
  stoppedBy: 'taken-over'
})

describe('Videorc Cloud as notifications (plan 250 S6)', () => {
  let store: NotificationStore
  let live = false
  const door = { show: vi.fn(), resolved: vi.fn(), dismiss: vi.fn() }
  const entry = (key: string) => store.snapshot().find((item) => item.key === key)

  beforeEach(() => {
    vi.clearAllMocks()
    live = false
    // The real guard, as the app wires it: a device name must survive it.
    store = createNotificationStore({
      live: () => live,
      guardText: (text) => guardToastText(text).text
    })
    store.setPopUpDoor(door)
  })

  // Plan 243 R2 B-M2: a device name is the streamer's own text, and braces,
  // tags and entities are all valid in one. The entry shows it exactly and
  // never hands it to the raw-provider-text guard, which would hide the
  // sentence and log the name for support.
  describe('another device continued the show', () => {
    const logs = ['warn', 'error', 'log', 'info', 'debug'] as const

    it.each(['Alice {work}', '<b>x</b>', '&amp;', 'MacBook "Pro" {"a":1}'])(
      'shows %s exactly and logs nothing',
      (name) => {
        for (const level of logs) vi.spyOn(console, level).mockImplementation(() => {})
        publishCloudStatus(base, takenOver(name), store)
        expect(entry('cloud-taken-over')).toMatchObject({
          tone: 'news',
          title: `Your show continues on ${name}`,
          actions: [{ label: 'Open Studio', kind: 'door' }]
        })
        expect(entry('cloud-taken-over')?.title).not.toBe(TOAST_DETAILS_SAVED)
        for (const level of logs) expect(console[level]).not.toHaveBeenCalled()
        vi.restoreAllMocks()
      }
    )

    it('is said once per take-over, names the kind without a name, and never pops up', () => {
      const { name: _name, ...nameless } = takenOver('x').onAir!
      const next = { ...takenOver('x'), onAir: nameless }
      publishCloudStatus(base, next, store)
      publishCloudStatus(next, next, store)
      expect(entry('cloud-taken-over')).toMatchObject({
        title: 'Your show continues on another computer',
        occurrences: 1
      })
      expect(door.show).not.toHaveBeenCalled()
    })
  })

  it('says an external show end once, and never an end requested here', () => {
    const ended: CloudStatus = { ...base, phase: 'off', endReason: 'ended-elsewhere' }
    publishCloudStatus(base, ended, store)
    publishCloudStatus(ended, ended, store)
    expect(entry('cloud-ended-elsewhere:sh_1')).toMatchObject({
      tone: 'news',
      title: 'The show was ended from videorc.com',
      occurrences: 1
    })
    // The next show ended from the web is its own row, not the first one's.
    const next: CloudStatus = { ...base, show: { ...base.show!, id: 'sh_2' } }
    publishCloudStatus(next, { ...next, phase: 'off', endReason: 'ended-elsewhere' }, store)
    expect(entry('cloud-ended-elsewhere:sh_2')).toMatchObject({ occurrences: 1, read: false })
    expect(entry('cloud-ended-elsewhere:sh_1')).toBeDefined()
    store.reset()
    publishCloudStatus(base, { ...base, phase: 'off', endReason: 'ended-by-host' }, store)
    expect(store.snapshot()).toEqual([])
  })

  it('what is wrong with the show is one condition, updated in place', () => {
    live = true
    const lost: CloudStatus = { ...base, directFallbackAvailable: true }
    publishCloudStatus(base, lost, store)
    expect(entry('cloud-status')).toMatchObject({
      state: 'open',
      tone: 'warning',
      title: 'Videorc Cloud lost your show',
      detail: 'Stop, then go live again to stream directly from this computer.',
      sessionId: 'cloud:sh_1',
      actions: [{ label: 'Open Destinations', kind: 'door' }]
    })
    const restarted: CloudStatus = {
      ...lost,
      restart: { at: '2026-11-19T10:00:00Z', destinationsResent: true }
    }
    publishCloudStatus(lost, restarted, store)
    expect(store.snapshot()).toHaveLength(1)
    expect(entry('cloud-status')).toMatchObject({
      title: 'Videorc Cloud restarted your show',
      detail: 'Your platforms reconnect in a few seconds.'
    })
    // A warning while live and quiet waits behind the bell.
    expect(door.show).not.toHaveBeenCalled()
    expect(store.count()).toMatchObject({ unread: 1, tone: 'warning' })
  })

  it("outlives this computer's own session: the show goes on in the cloud", () => {
    const lost: CloudStatus = { ...base, directFallbackAvailable: true }
    publishCloudStatus(base, lost, store)
    sessionEndedNotifications(store, 'record+stream')
    expect(entry('cloud-status')?.state).toBe('open')
  })

  it('a show that is gone takes its open problem with it', () => {
    const lost: CloudStatus = { ...base, directFallbackAvailable: true }
    publishCloudStatus(base, lost, store)
    publishCloudStatus(lost, { ...lost, phase: 'off', show: undefined }, store)
    expect(entry('cloud-status')).toMatchObject({ state: 'resolved', tone: 'news' })
    expect(entry('cloud-status')?.detail).toContain('Ended with the livestream.')
  })

  it('a Go Live that streamed directly says why, once', () => {
    const fallback: CloudStatus = {
      ...base,
      show: undefined,
      fallback: { sessionId: 's1', reason: 'cloud-full', at: '2026-11-19T10:00:00Z' }
    }
    publishCloudStatus({ ...base, show: undefined }, fallback, store)
    publishCloudStatus(fallback, fallback, store)
    expect(entry('cloud-status')).toMatchObject({
      title: 'Videorc Cloud is full right now',
      detail: "You're streaming directly from this computer.",
      sessionId: 'session',
      occurrences: 1
    })
  })

  it('past the month hours is news', () => {
    const past: CloudStatus = { ...base, allowancePast: { seconds: 600 } }
    publishCloudStatus(base, past, store)
    publishCloudStatus(past, past, store)
    expect(entry('cloud-allowance')).toMatchObject({
      tone: 'news',
      title: "You're 10 min past this month's cloud hours",
      detail: 'The show keeps going.',
      occurrences: 1
    })
  })

  it('"Videorc Cloud is on" waits behind the bell, counted, with the way to its section, and tells the backend', async () => {
    const requestTyped = vi.fn(async () => base)
    const commit = vi.fn()
    announceCloud({ requestTyped } as never, commit, store)
    expect(entry('cloud-announce')).toMatchObject({
      tone: 'news',
      title: 'Videorc Cloud is on',
      actions: [{ label: 'Open Destinations', kind: 'door' }]
    })
    expect(door.show).not.toHaveBeenCalled()
    expect(store.count().unread).toBe(1)
    await vi.waitFor(() => expect(commit).toHaveBeenCalledWith(base))
    expect(requestTyped).toHaveBeenCalledWith('cloud.announce.seen')
  })

  it('"You control this show here now" answers Continue here, and goes when the devices are on', async () => {
    live = true
    const turnOn = vi.fn()
    publishCloudController(['camera', 'microphone', 'screen'], turnOn, store)
    expect(entry('cloud-controller')).toMatchObject({
      state: 'open',
      title: 'You control this show here now',
      detail: 'Camera and microphone stay off here until you turn them on. Also off: screen.',
      actions: [{ id: 'turn-on', label: 'Turn on', kind: 'fix' }]
    })
    expect(door.show).toHaveBeenCalledTimes(1)
    await store.runAction('cloud-controller', 'turn-on')
    expect(turnOn).toHaveBeenCalledTimes(1)
    withdrawCloudController(store)
    expect(store.snapshot()).toEqual([])
  })

  it('going back into the room by itself is one entry: it runs, then says how it ended', () => {
    live = true
    publishCloudRejoin('running', store)
    expect(entry('cloud-rejoin')).toMatchObject({
      state: 'running',
      tone: 'news',
      title: 'Reconnecting to your show'
    })
    publishCloudRejoin('done', store)
    expect(entry('cloud-rejoin')).toMatchObject({ state: 'done', title: 'Back in your show' })
    publishCloudRejoin('failed', store)
    expect(entry('cloud-rejoin')).toMatchObject({
      state: 'failed',
      tone: 'warning',
      title: "Couldn't reconnect to your show",
      detail: 'Press Resume in the Studio to go back in.',
      actions: [{ label: 'Open Studio', kind: 'door' }]
    })
    // What already said how it ended stays; only a running one is taken back.
    withdrawCloudRejoin(store)
    expect(store.snapshot()).toHaveLength(1)
    publishCloudRejoin('running', store)
    withdrawCloudRejoin(store)
    expect(store.snapshot()).toEqual([])
  })
})
