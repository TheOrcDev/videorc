import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  message: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast }))

import { AccountSnapshotCommitCoordinator } from '@/lib/account-snapshot-policy'

import { handleAccountChangedEvent } from './use-studio'

// Plan 215 A5 (D7): a sign-out the server made used to be silent. The
// sidebar read "Sign in", nobody noticed, and X chat failed at the next Go
// Live with words that blamed X.
describe('account.changed', () => {
  beforeEach(() => {
    toast.warning.mockClear()
  })

  it('applies the backend account and says when the server signed the desktop out', () => {
    const coordinator = new AccountSnapshotCommitCoordinator()
    const setAccount = vi.fn()

    handleAccountChangedEvent(
      { account: { status: 'signed-out' }, reason: 'session-expired' },
      { coordinator, setAccount }
    )

    expect(setAccount).toHaveBeenCalledWith({ status: 'signed-out' })
    expect(toast.warning).toHaveBeenCalledWith(
      'Your Videorc sign-in expired',
      expect.objectContaining({
        id: 'account-session-expired',
        description: 'Sign in again.',
        action: expect.objectContaining({ label: 'Sign in' })
      })
    )
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
