import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WatchdogAlert } from '@/lib/backend'
import {
  syncWatchdogAlerts,
  watchdogSubjectKey,
  watchdogTone
} from '@/lib/notifications/sources/watchdog'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'

function alert(patch: Partial<WatchdogAlert> = {}): WatchdogAlert {
  return {
    id: 'a1',
    check: 'mic-muted',
    severity: 'warning',
    state: 'open',
    since: '2026-11-19T10:00:00Z',
    title: 'Your microphone is muted on the livestream',
    detail: 'Muted for 0:42.',
    source: 'desktop',
    fixes: [{ kind: 'unmute', label: 'Unmute' }],
    ...patch
  }
}

describe('the watchdog as notifications (plan 250, S2)', () => {
  let store: NotificationStore
  const deps = { fix: vi.fn(), acknowledge: vi.fn(), snooze: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    store = createNotificationStore()
  })

  it('maps each check onto its subject', () => {
    const rows: [Partial<WatchdogAlert>, string][] = [
      [{ check: 'mic-muted' }, 'microphone'],
      [{ check: 'mic-silent' }, 'microphone'],
      [{ check: 'no-voice' }, 'microphone'],
      [{ check: 'destination-down', targetId: 'tw-1' }, 'stream-target:tw-1'],
      [{ check: 'destination-down', targetId: 'all' }, 'stream-targets'],
      [{ check: 'bitrate-floor' }, 'stream-uplink'],
      [{ check: 'picture-stopped' }, 'stream-output'],
      [{ check: 'program-unreported' }, 'cloud-status'],
      [{ check: 'contribution-missing', targetId: 'host-camera' }, 'cloud-status'],
      [{ check: 'brb-long' }, 'watchdog:brb-long'],
      [{ check: 'chat-says', targetId: 'video' }, 'watchdog:chat-says:video']
    ]
    for (const [patch, key] of rows) expect(watchdogSubjectKey(alert(patch))).toBe(key)
    expect(watchdogTone({ severity: 'critical' })).toBe('urgent')
    expect(watchdogTone({ severity: 'warning' })).toBe('warning')
    expect(watchdogTone({ severity: 'notice' })).toBe('news')
  })

  it('an open mute is one entry with Unmute and "I meant to"', async () => {
    const muted = alert()
    syncWatchdogAlerts(store, [], [muted], deps)
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]).toMatchObject({
      key: 'microphone',
      tone: 'warning',
      title: 'Your microphone is muted on the livestream',
      detail: 'Muted for 0:42.',
      actions: [
        { id: 'fix:unmute', label: 'Unmute', kind: 'fix' },
        { id: 'meant-to', label: 'I meant to', kind: 'fix' }
      ]
    })
    await store.runAction('microphone', 'fix:unmute')
    expect(deps.fix).toHaveBeenCalledWith(muted, { kind: 'unmute', label: 'Unmute' })
    await store.runAction('microphone', 'meant-to')
    expect(deps.snooze).toHaveBeenCalledWith(muted, 'stream')
  })

  it('the clock in the detail updates the entry in place', () => {
    syncWatchdogAlerts(store, [], [alert()], deps)
    syncWatchdogAlerts(store, [alert()], [alert({ detail: 'Muted for 0:43.' })], deps)
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0].detail).toBe('Muted for 0:43.')
  })

  it('a cleared alert resolves its entry with the recovery words', () => {
    syncWatchdogAlerts(store, [], [alert()], deps)
    syncWatchdogAlerts(store, [alert()], [], deps)
    expect(store.snapshot()[0]).toMatchObject({ state: 'resolved', title: 'Microphone unmuted' })
  })

  it('a withdrawn, snoozed or seen alert leaves no resolved entry', () => {
    syncWatchdogAlerts(store, [], [alert()], deps)
    syncWatchdogAlerts(store, [alert()], [], deps, { withdrawn: ['a1'] })
    expect(store.snapshot()).toEqual([])

    syncWatchdogAlerts(store, [], [alert()], deps)
    syncWatchdogAlerts(store, [alert()], [alert({ state: 'snoozed' })], deps)
    expect(store.snapshot()).toEqual([])

    syncWatchdogAlerts(store, [], [alert()], deps)
    syncWatchdogAlerts(store, [alert()], [alert({ state: 'acknowledged' })], deps)
    expect(store.snapshot()).toEqual([])
  })

  it("Clear on the entry is the alert's Got it", () => {
    const critical = alert({ id: 'a2', check: 'picture-stopped', severity: 'critical', fixes: [] })
    syncWatchdogAlerts(store, [], [critical], deps)
    store.clear('stream-output')
    expect(deps.acknowledge).toHaveBeenCalledWith(critical)
    expect(store.snapshot()).toEqual([])
  })

  it('doors and fixes: only in-place fixes keep the list open', () => {
    syncWatchdogAlerts(
      store,
      [],
      [
        alert({
          id: 'a3',
          check: 'mic-silent',
          fixes: [
            { kind: 'unmute', label: 'Unmute' },
            { kind: 'open-audio', label: 'Open Audio' }
          ]
        })
      ],
      deps
    )
    expect(store.snapshot()[0].actions).toEqual([
      { id: 'fix:unmute', label: 'Unmute', kind: 'fix' },
      { id: 'fix:open-audio', label: 'Open Audio', kind: 'door' }
    ])
  })
})
