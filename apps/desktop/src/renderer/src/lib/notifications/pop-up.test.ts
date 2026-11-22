import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/notifications/kinds', async (original) => {
  const actual = await original<typeof import('@/lib/notifications/kinds')>()
  return {
    ...actual,
    NOTIFICATION_KINDS: {
      problem: { tone: 'warning', life: 'condition', mayBe: ['urgent', 'news'] },
      watchdog: actual.NOTIFICATION_KINDS.watchdog,
      news: { tone: 'news', life: 'event' },
      finished: { tone: 'done', life: 'event' },
      answer: { tone: 'done', life: 'event', answersAPress: true }
    }
  }
})

type ToastOptions = {
  id: string
  description?: string
  duration: number
  action?: { label: string; onClick: () => void }
  onDismiss?: () => void
  onAutoClose?: () => void
}
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

import type { NotificationKindId } from '@/lib/notifications/kinds'
import { createNotificationPopUpDoor, notificationToastId } from '@/lib/notifications/pop-up'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'
import type { NotificationInput, NotificationTone } from '@/lib/notifications/types'

const kind = (id: string): NotificationKindId => id as NotificationKindId
const optionsOf = (mock: ReturnType<typeof vi.fn>, call = 0): ToastOptions =>
  mock.mock.calls[call][1] as ToastOptions

describe('pop-ups (plan 250, "What pops up")', () => {
  let live = false
  let quiet = true
  let store: NotificationStore

  const problem = (tone: NotificationTone, patch: Partial<NotificationInput> = {}) =>
    store.publish({ key: 'subject', kind: kind('problem'), tone, title: 'A problem', ...patch })
  const shown = (): number =>
    toast.problem.mock.calls.length +
    toast.warning.mock.calls.length +
    toast.success.mock.calls.length +
    toast.info.mock.calls.length

  beforeEach(() => {
    vi.clearAllMocks()
    // A recording with quiet off: the row where the door is used. Idle is
    // the bell only; the table below holds every row.
    live = true
    quiet = false
    store = createNotificationStore({ live: () => live, quiet: () => quiet })
    store.setPopUpDoor(createNotificationPopUpDoor(store))
  })

  // The plan's table, through the real door: [idle, live and quiet, quiet off].
  const table: [string, () => void, ReturnType<typeof vi.fn>, (number | null)[]][] = [
    ['urgent', () => problem('urgent'), toast.problem, [null, 15_000, 15_000]],
    ['warning', () => problem('warning'), toast.warning, [null, null, 8_000]],
    [
      'done',
      () => store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' }),
      toast.success,
      [null, null, 8_000]
    ],
    [
      'news',
      () => store.publish({ key: 'blip', kind: kind('news'), title: 'A blip' }),
      toast.info,
      [null, null, null]
    ],
    [
      'the late answer to a press',
      () => store.publish({ key: 'clip', kind: kind('answer'), title: 'Clip saved' }),
      toast.success,
      [4_000, 4_000, 4_000]
    ]
  ]
  it.each(table)('%s', (_name, publish, show, [idle, quietLive, loudLive]) => {
    const modes: [boolean, boolean, number | null][] = [
      [false, true, idle],
      [true, true, quietLive],
      [true, false, loudLive]
    ]
    for (const [isLive, isQuiet, expected] of modes) {
      vi.clearAllMocks()
      live = isLive
      quiet = isQuiet
      store.reset()
      publish()
      if (expected === null) {
        expect(shown()).toBe(0)
      } else {
        expect(show).toHaveBeenCalledTimes(1)
        expect(optionsOf(show).duration).toBe(expected)
        expect(shown()).toBe(1)
      }
    }
  })

  it('is one toast per subject, with the entry words and its first action', () => {
    const run = vi.fn()
    problem('urgent', {
      title: 'Your stream is frozen',
      detail: 'No new frames for 12 s.',
      actions: [{ id: 'health', label: 'Open Health', kind: 'door', run }]
    })
    expect(toast.problem).toHaveBeenCalledWith(
      'Your stream is frozen',
      expect.objectContaining({
        id: notificationToastId('subject'),
        description: 'No new frames for 12 s.',
        duration: 15_000
      })
    )
    optionsOf(toast.problem).action?.onClick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.snapshot()[0].read).toBe(true)
  })

  it('once per episode: new words on an open entry show nothing more', () => {
    live = true
    problem('urgent', { detail: 'For 5 s.' })
    problem('urgent', { detail: 'For 6 s.' })
    expect(toast.problem).toHaveBeenCalledTimes(1)
  })

  it('closed by hand marks the entry read; timed out leaves it unread', () => {
    problem('warning')
    optionsOf(toast.warning).onAutoClose?.()
    expect(store.snapshot()[0].read).toBe(false)
    expect(store.count().unread).toBe(1)

    store.reset()
    vi.clearAllMocks()
    problem('warning')
    optionsOf(toast.warning).onDismiss?.()
    expect(store.snapshot()[0].read).toBe(true)
  })

  it('a recovery replaces a toast still showing for 4 s, and never pops up alone', () => {
    problem('warning')
    store.resolve('subject', { title: 'All good again' })
    expect(toast.success).toHaveBeenCalledWith(
      'All good again',
      expect.objectContaining({ id: notificationToastId('subject'), duration: 4_000 })
    )

    store.reset()
    vi.clearAllMocks()
    problem('warning')
    optionsOf(toast.warning).onAutoClose?.()
    store.resolve('subject', { title: 'All good again' })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('the recovery toast is still the entry: closed by hand it is read, and Clear closes it', () => {
    problem('urgent')
    store.resolve('subject', { title: 'All good again' })
    // An urgent problem that cleared counts until it has been seen.
    expect(store.count().unread).toBe(1)
    optionsOf(toast.success).onDismiss?.()
    expect(store.snapshot()[0].read).toBe(true)
    expect(store.count().unread).toBe(0)

    store.reset()
    vi.clearAllMocks()
    problem('urgent')
    store.resolve('subject', { title: 'All good again' })
    store.clear('subject')
    expect(toast.dismiss).toHaveBeenCalledWith(notificationToastId('subject'))
  })

  it('Clear takes the toast with it, without counting as seen-by-toast twice', () => {
    problem('urgent')
    store.clear('subject')
    expect(toast.dismiss).toHaveBeenCalledWith(notificationToastId('subject'))
    // sonner reports the programmatic close as a dismissal: nothing to mark.
    expect(() => optionsOf(toast.problem).onDismiss?.()).not.toThrow()
  })

  it('a failed action says so with a toast, because it answers the press', async () => {
    problem('warning', {
      actions: [
        { id: 'retry', label: 'Retry', kind: 'fix', run: () => Promise.reject(new Error('no')) }
      ]
    })
    optionsOf(toast.warning).action?.onClick()
    await vi.waitFor(() => expect(toastUserError).toHaveBeenCalledTimes(1))
    expect(toastUserError).toHaveBeenCalledWith(expect.any(Error), { action: 'retry' })
  })

  it('a watchdog alert while live and quiet: a warning waits, a critical one pops up once', async () => {
    const { syncWatchdogAlerts } = await import('@/lib/notifications/sources/watchdog')
    live = true
    quiet = true
    const deps = { fix: vi.fn(), acknowledge: vi.fn(), snooze: vi.fn() }
    const base = {
      state: 'open' as const,
      since: '2026-11-19T10:00:00Z',
      source: 'desktop' as const,
      detail: 'For 0:42.'
    }
    const warning = {
      ...base,
      id: 'a',
      check: 'mic-muted' as const,
      severity: 'warning' as const,
      title: 'Your microphone is muted on the livestream'
    }
    syncWatchdogAlerts(store, [], [warning], deps)
    expect(shown()).toBe(0)
    expect(store.count().unread).toBe(1)
    const critical = {
      ...base,
      id: 'b',
      check: 'picture-stopped' as const,
      severity: 'critical' as const,
      title: 'Your picture has stopped'
    }
    syncWatchdogAlerts(store, [warning], [warning, critical], deps)
    syncWatchdogAlerts(store, [warning, critical], [warning, critical], deps)
    expect(toast.problem).toHaveBeenCalledTimes(1)
    expect(optionsOf(toast.problem).duration).toBe(15_000)
    expect(shown()).toBe(1)
  })
})
