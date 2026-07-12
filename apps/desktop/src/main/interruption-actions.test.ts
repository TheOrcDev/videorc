import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackendInterruptionLease } from './backend-interruption'
import { runBackendInterruptingAction } from './interruption-actions'

function lease(overrides: Partial<BackendInterruptionLease> = {}): BackendInterruptionLease {
  return {
    id: 'lease-1',
    expiresInMs: 30_000,
    consumed: false,
    consume: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('backend-authoritative interruption actions', () => {
  it('does not run when authoritative admission is denied', async () => {
    const action = vi.fn()

    await expect(runBackendInterruptingAction(async () => null, action)).resolves.toBe(false)
    expect(action).not.toHaveBeenCalled()
  })

  it('consumes before the action and retains the bounded lease on success', async () => {
    const order: string[] = []
    const activeLease = lease({
      consume: vi.fn(async () => {
        order.push('consume')
      })
    })

    await expect(
      runBackendInterruptingAction(
        async () => activeLease,
        () => {
          order.push('action')
        }
      )
    ).resolves.toBe(true)
    expect(order).toEqual(['consume', 'action'])
    expect(activeLease.release).not.toHaveBeenCalled()
  })

  it('renews while a destructive action remains in progress', async () => {
    vi.useFakeTimers()
    let finishAction: (() => void) | undefined
    const activeLease = lease()
    const running = runBackendInterruptingAction(
      async () => activeLease,
      () =>
        new Promise<void>((resolve) => {
          finishAction = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(2_100)

    expect(activeLease.consume).toHaveBeenCalledOnce()
    expect(activeLease.renew).toHaveBeenCalledOnce()
    finishAction?.()
    await expect(running).resolves.toBe(true)
  })

  it('releases the exact lease if consume or the destructive action fails', async () => {
    const consumeFailure = lease({ consume: vi.fn().mockRejectedValue(new Error('consume lost')) })
    const action = vi.fn()
    await expect(runBackendInterruptingAction(async () => consumeFailure, action)).rejects.toThrow(
      'consume lost'
    )
    expect(action).not.toHaveBeenCalled()
    expect(consumeFailure.release).toHaveBeenCalledOnce()

    const actionFailure = lease()
    await expect(
      runBackendInterruptingAction(
        async () => actionFailure,
        () => {
          throw new Error('restart failed')
        }
      )
    ).rejects.toThrow('restart failed')
    expect(actionFailure.release).toHaveBeenCalledOnce()
  })
})
