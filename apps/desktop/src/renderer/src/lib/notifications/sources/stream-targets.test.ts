import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamTargetRuntime, StreamTargetState } from '@/lib/backend'
import { publishStreamTargetNotice } from '@/lib/notifications/sources/stream-targets'
import { syncWatchdogAlerts } from '@/lib/notifications/sources/watchdog'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'
import { streamTargetNotices } from '@/lib/stream-target-notices'

function target(targetId: string, label: string, state: StreamTargetState): StreamTargetRuntime {
  return { targetId, platform: 'twitch', label, state }
}

describe('destinations as notifications (plan 250 S6)', () => {
  let store: NotificationStore
  let live: StreamTargetRuntime[]
  let previous: Map<string, StreamTargetState>

  /** One `stream.targets` snapshot, as the Studio hands it over. */
  const snapshot = (next: StreamTargetRuntime[]): void => {
    for (const notice of streamTargetNotices(previous, next)) {
      publishStreamTargetNotice(store, notice)
    }
    previous = new Map(next.map((item) => [item.targetId, item.state]))
  }
  const entry = (key: string) => store.snapshot().find((item) => item.key === key)

  beforeEach(() => {
    store = createNotificationStore()
    live = [target('tw', 'Twitch', 'live'), target('yt', 'YouTube', 'live')]
    previous = new Map()
    snapshot(live)
  })

  it('going on air is not news', () => {
    expect(store.snapshot()).toEqual([])
  })

  it('a destination that fails, reconnects and returns is one entry that ends resolved', () => {
    snapshot([target('tw', 'Twitch', 'reconnecting'), live[1]])
    expect(entry('stream-target:tw')).toMatchObject({
      state: 'open',
      tone: 'warning',
      title: 'Twitch is reconnecting',
      detail: "Viewers there see nothing until it's back. The other destination keeps streaming.",
      actions: [{ id: 'open-destinations', label: 'Open Destinations', kind: 'door' }]
    })
    snapshot([target('tw', 'Twitch', 'failed'), live[1]])
    expect(entry('stream-target:tw')).toMatchObject({
      state: 'open',
      title: 'Streaming to Twitch stopped'
    })
    snapshot([target('tw', 'Twitch', 'live'), live[1]])
    expect(store.snapshot()).toHaveLength(1)
    expect(entry('stream-target:tw')).toMatchObject({
      state: 'resolved',
      tone: 'done',
      title: 'Twitch is back',
      detail: 'It was down for 1 s.'
    })
  })

  it('is urgent when no other destination is on air: viewers see nothing', () => {
    snapshot([target('tw', 'Twitch', 'failed'), target('yt', 'YouTube', 'failed')])
    expect(entry('stream-target:tw')?.tone).toBe('urgent')
    expect(entry('stream-target:yt')?.tone).toBe('urgent')

    store.reset()
    previous = new Map([['only', 'live']])
    snapshot([target('only', 'Kick', 'reconnecting')])
    expect(entry('stream-target:only')).toMatchObject({
      tone: 'urgent',
      detail: "Viewers see nothing until it's back."
    })
  })

  it('a platform that is not receiving the stream is a warning, even alone', () => {
    previous = new Map([['only', 'live']])
    store.reset()
    snapshot([target('only', 'YouTube', 'warning')])
    expect(entry('stream-target:only')).toMatchObject({
      tone: 'warning',
      title: "YouTube isn't receiving your stream"
    })
  })

  it('the feed to Videorc Cloud is a warning: the cloud holds the show', () => {
    previous = new Map([['videorc-cloud-1', 'live']])
    store.reset()
    snapshot([target('videorc-cloud-1', 'Videorc Cloud', 'reconnecting')])
    expect(entry('stream-target:videorc-cloud-1')).toMatchObject({
      tone: 'warning',
      title: 'Reconnecting to Videorc Cloud'
    })
  })

  it("shares the destination's entry with the watchdog, whose words lead", () => {
    const deps = { fix: vi.fn(), acknowledge: vi.fn(), snooze: vi.fn() }
    snapshot([target('tw', 'Twitch', 'failed'), live[1]])
    const alert = {
      id: 'a1',
      check: 'destination-down' as const,
      severity: 'warning' as const,
      state: 'open' as const,
      since: '2026-11-19T10:00:00Z',
      title: 'Twitch has been down for 0:20',
      detail: 'YouTube is still on air.',
      source: 'desktop' as const,
      targetId: 'tw',
      fixes: [{ kind: 'open-livestream' as const, label: 'Open Destinations' }]
    }
    syncWatchdogAlerts(store, [], [alert], deps)
    expect(store.snapshot()).toHaveLength(1)
    expect(entry('stream-target:tw')).toMatchObject({
      title: 'Twitch has been down for 0:20',
      detail: 'YouTube is still on air.'
    })
    // The watchdog clears first; the destination's own report keeps it open.
    syncWatchdogAlerts(store, [alert], [], deps)
    expect(entry('stream-target:tw')).toMatchObject({
      state: 'open',
      title: 'Streaming to Twitch stopped'
    })
    snapshot([target('tw', 'Twitch', 'live'), live[1]])
    expect(entry('stream-target:tw')).toMatchObject({ state: 'resolved', title: 'Twitch is back' })
  })

  it('ends with the livestream', () => {
    snapshot([target('tw', 'Twitch', 'reconnecting'), live[1]])
    store.sessionEnded('livestream')
    expect(entry('stream-target:tw')).toMatchObject({
      state: 'resolved',
      title: 'Twitch is reconnecting'
    })
  })
})
