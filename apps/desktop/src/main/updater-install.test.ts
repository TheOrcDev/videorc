import { describe, expect, it, vi } from 'vitest'

import type { BackendInterruptionLease } from './backend-interruption'
import { installUpdateWithInterruptionLease } from './updater-install'

const lease = (): BackendInterruptionLease => ({
  id: 'lease-1',
  expiresInMs: 30_000,
  consumed: false,
  consume: vi.fn().mockResolvedValue(undefined),
  renew: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined)
})

describe('authoritative update installation admission', () => {
  it('preserves the immediate local capture guard', async () => {
    const acquire = vi.fn(async () => lease())
    const quitAndInstall = vi.fn()

    await expect(
      installUpdateWithInterruptionLease(() => true, acquire, quitAndInstall)
    ).resolves.toBe('blocked-by-local-capture-state')
    expect(acquire).not.toHaveBeenCalled()
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('blocks a start that wins after the sampled idle state', async () => {
    const quitAndInstall = vi.fn()

    await expect(
      installUpdateWithInterruptionLease(
        () => false,
        async () => null,
        quitAndInstall
      )
    ).resolves.toBe('blocked-by-backend')
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('quits only while holding the backend lease', async () => {
    const quitAndInstall = vi.fn()

    await expect(
      installUpdateWithInterruptionLease(
        () => false,
        async () => lease(),
        quitAndInstall
      )
    ).resolves.toBe('installing')
    expect(quitAndInstall).toHaveBeenCalledOnce()
  })
})
