import { describe, expect, it } from 'vitest'

import {
  notificationActRaisesMainWindow,
  notificationActRequestSchema,
  notificationPopUpSchema,
  notificationsSnapshotSchema,
  type NotificationsSnapshot,
  type RelayedNotification
} from './notifications-relay'

const entry: RelayedNotification = {
  key: 'microphone',
  kind: 'microphone',
  tone: 'urgent',
  peakTone: 'urgent',
  life: 'condition',
  state: 'open',
  title: 'Microphone is silent',
  detail: 'No sound for 40 s.',
  openedAt: 1_000,
  updatedAt: 2_000,
  occurrences: 1,
  read: false,
  sessionId: 'session',
  actions: [
    { id: 'fix:unmute', label: 'Unmute', kind: 'fix' },
    { id: 'open-audio', label: 'Open Audio', kind: 'door' }
  ]
}

describe("the Stream Manager's notification relay (plan 250 S8)", () => {
  it('carries the list as plain entries, and refuses anything else', () => {
    const snapshot: NotificationsSnapshot = {
      entries: [entry],
      count: { unread: 1, urgent: 1, tone: 'urgent' },
      quiet: true
    }
    expect(notificationsSnapshotSchema.parse(snapshot, 'snapshot')).toEqual(snapshot)
    expect(notificationsSnapshotSchema.parse(null, 'snapshot')).toBeNull()
    // No function, no extra field, never a third button.
    expect(() =>
      notificationsSnapshotSchema.parse(
        { ...snapshot, entries: [{ ...entry, run: 'x' }] },
        'snapshot'
      )
    ).toThrow()
    expect(() =>
      notificationsSnapshotSchema.parse(
        {
          ...snapshot,
          entries: [{ ...entry, actions: [...entry.actions, entry.actions[0]] }]
        },
        'snapshot'
      )
    ).toThrow()
    expect(() =>
      notificationsSnapshotSchema.parse(
        { ...snapshot, entries: Array.from({ length: 65 }, () => entry) },
        'snapshot'
      )
    ).toThrow()
  })

  it('carries a press back as a key and an action id', () => {
    for (const request of [
      { type: 'run', key: 'microphone', actionId: 'fix:unmute', door: false },
      { type: 'clear', key: 'microphone' },
      { type: 'clear-all' },
      { type: 'mark-read', key: 'microphone' },
      { type: 'mark-all-read' },
      { type: 'list-open', open: true },
      { type: 'open-settings' }
    ] as const) {
      expect(notificationActRequestSchema.parse(request, 'act')).toEqual(request)
    }
    expect(() => notificationActRequestSchema.parse({ type: 'run', key: 'x' }, 'act')).toThrow()
    expect(() => notificationActRequestSchema.parse({ type: 'eval', code: 'x' }, 'act')).toThrow()
    expect(() =>
      notificationActRequestSchema.parse({ type: 'clear-all', key: 'extra' }, 'act')
    ).toThrow()
  })

  it('carries a pop-up, its recovery and its dismissal', () => {
    for (const popUp of [
      { type: 'show', entry, durationMs: 15_000, action: entry.actions[0] },
      { type: 'show', entry, durationMs: 15_000 },
      { type: 'resolved', key: 'microphone', title: 'Microphone is back' },
      { type: 'dismiss', key: 'microphone' }
    ] as const) {
      expect(notificationPopUpSchema.parse(popUp, 'pop-up')).toEqual(popUp)
    }
    expect(() =>
      notificationPopUpSchema.parse({ type: 'show', entry, durationMs: 9e9 }, 'pop-up')
    ).toThrow()
  })

  it('only a door brings the main window forward: a fix never steals the focus', () => {
    expect(
      notificationActRaisesMainWindow({ type: 'run', key: 'k', actionId: 'a', door: true })
    ).toBe(true)
    expect(notificationActRaisesMainWindow({ type: 'open-settings' })).toBe(true)
    expect(
      notificationActRaisesMainWindow({ type: 'run', key: 'k', actionId: 'a', door: false })
    ).toBe(false)
    expect(notificationActRaisesMainWindow({ type: 'clear', key: 'k' })).toBe(false)
    expect(notificationActRaisesMainWindow({ type: 'list-open', open: true })).toBe(false)
  })
})
