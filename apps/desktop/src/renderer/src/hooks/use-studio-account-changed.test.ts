import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  message: vi.fn(),
  problem: vi.fn(),
  dismiss: vi.fn()
}))
// The rest of the module stays real: the notification store guards its words
// with the toast door's own text guard.
vi.mock('@/lib/toast', async (original) => ({
  ...(await original<typeof import('@/lib/toast')>()),
  toast
}))

import { AccountSnapshotCommitCoordinator } from '@/lib/account-snapshot-policy'
import { notifications } from '@/lib/notifications'

import { handleAccountChangedEvent } from './use-studio'

// Plan 215 A5 (D7): a sign-out the server made used to be silent. The
// sidebar read "Sign in", nobody noticed, and X chat failed at the next Go
// Live with words that blamed X.
describe('account.changed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notifications.reset()
  })

  it('applies the backend account and says when the server signed the desktop out', async () => {
    const coordinator = new AccountSnapshotCommitCoordinator()
    const setAccount = vi.fn()

    handleAccountChangedEvent(
      { account: { status: 'signed-out' }, reason: 'session-expired' },
      { coordinator, setAccount }
    )

    expect(setAccount).toHaveBeenCalledWith({ status: 'signed-out' })
    // Plan 250: an entry behind the bell with Sign in as its fix. Its words
    // load lazily (plan 224 budget room), so it lands a tick after the event.
    const expired = () => notifications.snapshot().find((entry) => entry.key === 'account-session')
    await vi.waitFor(() => expect(expired()).toBeDefined())
    expect(expired()).toMatchObject({
      state: 'open',
      tone: 'warning',
      title: 'Your Videorc sign-in expired',
      detail: 'Sign in again.',
      actions: [{ id: 'sign-in', label: 'Sign in', kind: 'fix' }]
    })
    // Idle, so it waits behind the bell: no toast (the owner, 2026-11-22).
    expect(toast.warning).not.toHaveBeenCalled()

    // The next sign-in resolves it.
    handleAccountChangedEvent(
      { account: { status: 'signed-in', username: 'orc_dev' }, reason: 'signed-in' },
      { coordinator, setAccount }
    )
    await vi.waitFor(() => expect(expired()?.state).toBe('resolved'))
  })

  it('stays quiet on a sign-in or an explicit sign-out, and yields to one in flight', () => {
    const coordinator = new AccountSnapshotCommitCoordinator()
    const setAccount = vi.fn()

    handleAccountChangedEvent(
      { account: { status: 'signed-in', username: 'orc_dev' }, reason: 'signed-in' },
      { coordinator, setAccount }
    )
    expect(setAccount).toHaveBeenCalledTimes(1)
    expect(setAccount).toHaveBeenLastCalledWith({ status: 'signed-in', username: 'orc_dev' })
    expect(toast.warning).not.toHaveBeenCalled()

    // The renderer's own sign-in is still exchanging its code: that call
    // commits its answer, so the event leaves the snapshot alone.
    coordinator.beginMutation()
    handleAccountChangedEvent(
      { account: { status: 'signed-out' }, reason: 'signed-out' },
      { coordinator, setAccount }
    )
    expect(setAccount).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
