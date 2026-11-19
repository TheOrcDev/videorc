// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  problem: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast }))
vi.mock('@/lib/user-error', () => ({ toastUserError: vi.fn() }))

import {
  resetStreamManagerNotificationsForTests,
  showRelayedPopUp,
  startStreamManagerNotifications,
  streamManagerNotificationSource
} from '@/lib/stream-manager-notifications'
import type {
  NotificationActRequest,
  NotificationPopUp,
  NotificationsSnapshot,
  RelayedNotification
} from '../../../shared/notifications-relay'

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
  actions: [
    { id: 'unmute', label: 'Unmute', kind: 'fix' },
    { id: 'open-audio', label: 'Open Audio', kind: 'door' }
  ]
}
const snapshot: NotificationsSnapshot = {
  entries: [entry],
  count: { unread: 1, urgent: 1, tone: 'urgent' },
  quiet: true
}

describe("the Stream Manager's copy of the list (plan 250 S8)", () => {
  let acts: NotificationActRequest[] = []
  let onList: ((snapshot: NotificationsSnapshot | null) => void) | null = null
  let onPopUp: ((popUp: NotificationPopUp) => void) | null = null
  let first: NotificationsSnapshot | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    resetStreamManagerNotificationsForTests()
    acts = []
    first = null
    ;(window as unknown as { videorc: unknown }).videorc = {
      getNotifications: vi.fn(async () => first),
      onNotifications: vi.fn((callback: typeof onList) => {
        onList = callback
        return () => {
          onList = null
        }
      }),
      onNotificationPopUp: vi.fn((callback: typeof onPopUp) => {
        onPopUp = callback
        return () => {
          onPopUp = null
        }
      }),
      notificationActFromCommentsWindow: vi.fn(async (request: NotificationActRequest) => {
        acts.push(request)
        return true
      })
    }
  })

  afterEach(() => {
    resetStreamManagerNotificationsForTests()
    delete (window as unknown as { videorc?: unknown }).videorc
    vi.unstubAllGlobals()
  })

  it('reads the list main kept, then follows every push', async () => {
    first = snapshot
    const stop = startStreamManagerNotifications()
    await vi.waitFor(() => expect(streamManagerNotificationSource.snapshot()).toHaveLength(1))
    const listener = vi.fn()
    const off = streamManagerNotificationSource.subscribe(listener)
    onList?.({ ...snapshot, entries: [] })
    expect(streamManagerNotificationSource.snapshot()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    stop()
    expect(onList).toBeNull()
    expect(onPopUp).toBeNull()
  })

  it('a push that arrives before the first answer wins', async () => {
    first = { ...snapshot, entries: [] }
    startStreamManagerNotifications()
    onList?.(snapshot)
    await Promise.resolve()
    await Promise.resolve()
    expect(streamManagerNotificationSource.snapshot()).toHaveLength(1)
  })

  it('sends a press back as a key and an action id, and says which are doors', async () => {
    startStreamManagerNotifications()
    onList?.(snapshot)
    await streamManagerNotificationSource.runAction('microphone', 'unmute')
    await streamManagerNotificationSource.runAction('microphone', 'open-audio')
    await streamManagerNotificationSource.runAction('microphone', 'no-such-action')
    streamManagerNotificationSource.clear('microphone')
    streamManagerNotificationSource.clearAll()
    streamManagerNotificationSource.markAllRead()
    streamManagerNotificationSource.setListOpen(true)
    expect(acts).toEqual([
      { type: 'run', key: 'microphone', actionId: 'unmute', door: false },
      { type: 'run', key: 'microphone', actionId: 'open-audio', door: true },
      { type: 'clear', key: 'microphone' },
      { type: 'clear-all' },
      { type: 'mark-all-read' },
      { type: 'list-open', open: true }
    ])
  })

  it('pops an urgent entry up here, with its first action', () => {
    showRelayedPopUp({ type: 'show', entry, durationMs: 15_000, action: entry.actions[0] })
    expect(toast.problem).toHaveBeenCalledWith(
      'Microphone is silent',
      expect.objectContaining({
        id: 'notification:microphone',
        description: 'No sound for 40 s.',
        duration: 15_000,
        action: expect.objectContaining({ label: 'Unmute' })
      })
    )
    const options = toast.problem.mock.calls[0][1] as {
      action: { onClick: () => void }
      onDismiss: () => void
    }
    options.action.onClick()
    // The press marks it read in the store; closing after it says nothing more.
    options.onDismiss()
    expect(acts).toEqual([{ type: 'run', key: 'microphone', actionId: 'unmute', door: false }])
  })

  it('closing the pop-up by hand marks the entry read', () => {
    showRelayedPopUp({ type: 'show', entry, durationMs: 15_000 })
    ;(toast.problem.mock.calls[0][1] as { onDismiss: () => void }).onDismiss()
    expect(acts).toEqual([{ type: 'mark-read', key: 'microphone' }])
  })

  it('a recovery replaces the toast for 4 s, and a dismissal takes it away', () => {
    showRelayedPopUp({ type: 'resolved', key: 'microphone', title: 'Microphone is back' })
    expect(toast.success).toHaveBeenCalledWith(
      'Microphone is back',
      expect.objectContaining({ id: 'notification:microphone', duration: 4_000 })
    )
    showRelayedPopUp({ type: 'dismiss', key: 'microphone' })
    expect(toast.dismiss).toHaveBeenCalledWith('notification:microphone')
  })
})
