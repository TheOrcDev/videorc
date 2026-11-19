import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/notifications/kinds', async (original) => {
  const actual = await original<typeof import('@/lib/notifications/kinds')>()
  return {
    ...actual,
    NOTIFICATION_KINDS: {
      problem: { tone: 'warning', life: 'condition', mayBe: ['urgent', 'news'] },
      finished: { tone: 'done', life: 'event' }
    }
  }
})

const toast = vi.hoisted(() => ({
  problem: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast }))
const toastUserError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/user-error', () => ({ toastUserError }))
const openNotificationSettings = vi.hoisted(() => vi.fn())
vi.mock('@/lib/section-doors', () => ({ openNotificationSettings }))

import type { NotificationKindId } from '@/lib/notifications/kinds'
import {
  applyNotificationAct,
  notificationsSnapshot,
  startNotificationRelay
} from '@/lib/notifications/relay'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'
import {
  notificationsSnapshotSchema,
  type NotificationActRequest,
  type NotificationPopUp,
  type NotificationsSnapshot
} from '../../../../shared/notifications-relay'

const kind = (id: string): NotificationKindId => id as NotificationKindId

describe("the main window's notification relay (plan 250 S8)", () => {
  let store: NotificationStore
  let pushed: NotificationsSnapshot[] = []
  let popUps: NotificationPopUp[] = []
  let streamManagerInFront = false
  let act: ((request: NotificationActRequest) => void) | null = null
  const api = {
    pushNotifications: vi.fn(async (snapshot: NotificationsSnapshot | null) => {
      if (snapshot) pushed.push(snapshot)
      return true
    }),
    pushNotificationPopUp: vi.fn(async (popUp: NotificationPopUp) => {
      if (popUp.type === 'show' && !streamManagerInFront) return false
      popUps.push(popUp)
      return true
    }),
    onNotificationActRequest: vi.fn((callback: (request: NotificationActRequest) => void) => {
      act = callback
      return () => {
        act = null
      }
    })
  }
  const flush = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  const publishUrgent = (): void =>
    store.publish({
      key: 'microphone',
      kind: kind('problem'),
      tone: 'urgent',
      title: 'Microphone is silent',
      detail: 'No sound for 40 s.',
      actions: [
        { id: 'unmute', label: 'Unmute', kind: 'fix', run: unmute },
        { id: 'open-audio', label: 'Open Audio', kind: 'door', run: () => {} }
      ]
    })
  const unmute = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    pushed = []
    popUps = []
    streamManagerInFront = false
    store = createNotificationStore()
  })

  it('pushes the list as plain entries the contract accepts, once per change', async () => {
    const stop = startNotificationRelay(store, api, () => true)
    await flush()
    // A Stream Manager that is already open learns the (empty) list at once.
    expect(pushed).toHaveLength(1)
    publishUrgent()
    store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
    await flush()
    // Two changes in one turn travel as one push.
    expect(pushed).toHaveLength(2)
    const last = pushed.at(-1)!
    expect(notificationsSnapshotSchema.parse(last, 'snapshot')).toEqual(last)
    expect(last.count).toEqual({ unread: 2, urgent: 1, tone: 'urgent' })
    expect(last.quiet).toBe(true)
    expect(last.entries[0]).toMatchObject({
      key: 'microphone',
      actions: [
        { id: 'unmute', label: 'Unmute', kind: 'fix' },
        { id: 'open-audio', label: 'Open Audio', kind: 'door' }
      ]
    })
    expect(JSON.stringify(last)).not.toContain('run')
    stop()
    expect(act).toBeNull()
  })

  it('says what the quiet rule is doing, for the footer', () => {
    expect(notificationsSnapshot(store, false).quiet).toBe(false)
  })

  it('runs what the Stream Manager presses on the store', async () => {
    startNotificationRelay(store, api, () => true)
    publishUrgent()
    act?.({ type: 'run', key: 'microphone', actionId: 'unmute', door: false })
    await flush()
    expect(unmute).toHaveBeenCalledTimes(1)
    expect(store.snapshot()[0].read).toBe(true)

    act?.({ type: 'open-settings' })
    expect(openNotificationSettings).toHaveBeenCalledTimes(1)

    act?.({ type: 'clear', key: 'microphone' })
    expect(store.snapshot()).toEqual([])
  })

  it('marks read and clears all for it', () => {
    store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
    applyNotificationAct(store, { type: 'mark-read', key: 'saved' })
    expect(store.count().unread).toBe(0)
    store.publish({ key: 'other', kind: kind('finished'), title: 'MP4 ready' })
    applyNotificationAct(store, { type: 'mark-all-read' })
    expect(store.count().unread).toBe(0)
    applyNotificationAct(store, { type: 'clear-all' })
    expect(store.snapshot()).toEqual([])
  })

  it("nothing pops up while the Stream Manager's list is open, whatever the main window's is", async () => {
    startNotificationRelay(store, api, () => true)
    act?.({ type: 'list-open', open: true })
    // The main window's own list closing must not hide that one is still open.
    store.setListOpen(true)
    store.setListOpen(false)
    publishUrgent()
    await flush()
    expect(api.pushNotificationPopUp).not.toHaveBeenCalled()
    expect(toast.problem).not.toHaveBeenCalled()
    act?.({ type: 'list-open', open: false })
    store.resolve('microphone')
    store.publish({ key: 'stream', kind: kind('problem'), tone: 'urgent', title: 'Frozen' })
    await flush()
    expect(api.pushNotificationPopUp).toHaveBeenCalledTimes(1)
  })

  describe('an urgent pop-up shows in the window the streamer is in', () => {
    it('in the Stream Manager when it is in front, and not in the main window', async () => {
      streamManagerInFront = true
      startNotificationRelay(store, api, () => true)
      publishUrgent()
      await flush()
      expect(popUps).toEqual([
        expect.objectContaining({
          type: 'show',
          durationMs: 15_000,
          entry: expect.objectContaining({ key: 'microphone', title: 'Microphone is silent' }),
          action: { id: 'unmute', label: 'Unmute', kind: 'fix' }
        })
      ])
      expect(toast.problem).not.toHaveBeenCalled()

      // The recovery replaces the toast where it is showing.
      store.resolve('microphone', { title: 'Microphone is back' })
      await flush()
      expect(popUps.at(-1)).toEqual({
        type: 'resolved',
        key: 'microphone',
        title: 'Microphone is back'
      })
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('in the main window otherwise', async () => {
      startNotificationRelay(store, api, () => true)
      publishUrgent()
      await flush()
      expect(popUps).toEqual([])
      expect(toast.problem).toHaveBeenCalledWith(
        'Microphone is silent',
        expect.objectContaining({ duration: 15_000 })
      )
      store.clear('microphone')
      expect(toast.dismiss).toHaveBeenCalledWith('notification:microphone')
    })

    it('in the main window when main cannot be asked', async () => {
      api.pushNotificationPopUp.mockRejectedValueOnce(new Error('no main'))
      startNotificationRelay(store, api, () => true)
      publishUrgent()
      await flush()
      expect(toast.problem).toHaveBeenCalledTimes(1)
    })

    it('a problem that cleared while main was being asked shows nothing', async () => {
      startNotificationRelay(store, api, () => true)
      publishUrgent()
      // Resolved before main has answered where the toast should go.
      store.resolve('microphone', { title: 'Microphone is back' })
      await flush()
      expect(toast.problem).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('a toast that reached the Stream Manager after its problem cleared is taken back', async () => {
      streamManagerInFront = true
      startNotificationRelay(store, api, () => true)
      publishUrgent()
      store.clear('microphone')
      await flush()
      expect(popUps.at(-1)).toEqual({ type: 'dismiss', key: 'microphone' })
    })

    it('a toast showing in the Stream Manager is dismissed there on Clear', async () => {
      streamManagerInFront = true
      startNotificationRelay(store, api, () => true)
      publishUrgent()
      await flush()
      store.clear('microphone')
      await flush()
      expect(popUps.at(-1)).toEqual({ type: 'dismiss', key: 'microphone' })
      expect(toast.dismiss).not.toHaveBeenCalled()
    })
  })
})
