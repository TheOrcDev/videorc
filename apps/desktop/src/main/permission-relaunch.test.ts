import { describe, expect, it, vi } from 'vitest'

import type { BackendInterruptionLease } from './backend-interruption'
import { relaunchForPermissionWithInterruptionLease } from './permission-relaunch'

const lease = (): BackendInterruptionLease => ({
  id: 'lease-1',
  expiresInMs: 30_000,
  consumed: false,
  consume: vi.fn().mockResolvedValue(undefined),
  renew: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined)
})

describe('relaunchForPermissionWithInterruptionLease (plan 203 S2)', () => {
  it('refuses while the sampled capture state is active or unknown', async () => {
    const acquire = vi.fn(async () => lease())
    const relaunch = vi.fn()

    await expect(
      relaunchForPermissionWithInterruptionLease(
        () => true,
        () => true,
        acquire,
        relaunch
      )
    ).resolves.toEqual({ relaunched: false, reason: 'capture-active' })
    expect(acquire).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('refuses when the backend will not admit the interruption (a start won the race)', async () => {
    const relaunch = vi.fn()

    await expect(
      relaunchForPermissionWithInterruptionLease(
        () => false,
        () => true,
        async () => null,
        relaunch
      )
    ).resolves.toEqual({ relaunched: false, reason: 'backend-busy' })
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('relaunches only while holding the backend lease', async () => {
    const held = lease()
    const relaunch = vi.fn()

    await expect(
      relaunchForPermissionWithInterruptionLease(
        () => false,
        () => true,
        async () => held,
        relaunch
      )
    ).resolves.toEqual({ relaunched: true })
    expect(held.consume).toHaveBeenCalledOnce()
    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('relaunches without a lease when no backend is connected (nothing to interrupt)', async () => {
    const acquire = vi.fn(async () => lease())
    const relaunch = vi.fn()

    await expect(
      relaunchForPermissionWithInterruptionLease(
        () => false,
        () => false,
        acquire,
        relaunch
      )
    ).resolves.toEqual({ relaunched: true })
    expect(acquire).not.toHaveBeenCalled()
    expect(relaunch).toHaveBeenCalledOnce()
  })
})
