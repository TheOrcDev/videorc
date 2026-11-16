import { describe, expect, it } from 'vitest'
import { cloudTerminalOwner, waitForCloudProviderOutput } from './cloud-provider-lifecycle'
import type { CloudStatus } from '@/lib/backend'

const status = (patch: Partial<CloudStatus> = {}): CloudStatus => ({
  phase: 'live',
  entitled: true,
  connected: true,
  directFallbackAvailable: false,
  settings: { enabled: true, holdMaxSeconds: 60, holdMaxChoices: [] },
  show: { id: 'show', nodeId: 'managed', resumable: false, kind: 'talk' },
  liveInterval: { id: 'interval', requestedAt: '2026-01-01T00:00:00Z' },
  ...patch
})
const leg = (state: 'live' | 'connecting' | 'failed') => ({
  targetId: 'youtube',
  platform: 'youtube' as const,
  label: 'YouTube',
  state,
  orientation: 'horizontal' as const,
  message: ''
})
describe('cloud provider readiness', () => {
  it('waits for actual own live leg rather than a live room or native encoder', async () => {
    let reads = 0
    let sleeps = 0
    await waitForCloudProviderOutput({
      showId: 'show',
      targetId: 'youtube',
      current: () => true,
      read: async () => status({ legs: [leg(++reads === 3 ? 'live' : 'connecting')] }),
      sleep: async () => {
        sleeps++
      }
    })
    expect(reads).toBe(3)
    expect(sleeps).toBe(2)
  })
  it('bounds missing readiness and names provider activation as pending', async () => {
    let reads = 0
    await expect(
      waitForCloudProviderOutput({
        showId: 'show',
        targetId: 'youtube',
        current: () => true,
        read: async () => {
          reads++
          return status()
        },
        sleep: async () => {}
      })
    ).rejects.toThrow('pending')
    expect(reads).toBe(8)
  })
  it('rejects cancellation, stale ownership, replacement interval and failed destinations', async () => {
    for (const next of [
      status({ legs: [leg('failed')] }),
      status({ connected: false, phase: 'ending' }),
      status({ show: { id: 'other', nodeId: 'managed', resumable: false } })
    ]) {
      await expect(
        waitForCloudProviderOutput({
          showId: 'show',
          targetId: 'youtube',
          current: () => true,
          read: async () => next,
          sleep: async () => {}
        })
      ).rejects.toThrow()
    }
    let reads = 0
    await expect(
      waitForCloudProviderOutput({
        showId: 'show',
        targetId: 'youtube',
        current: () => true,
        read: async () =>
          status({
            liveInterval: { id: ++reads === 1 ? 'one' : 'two', requestedAt: '' },
            legs: [leg('connecting')]
          }),
        sleep: async () => {}
      })
    ).rejects.toThrow('interval changed')
    await expect(
      waitForCloudProviderOutput({
        showId: 'show',
        targetId: 'youtube',
        current: () => false,
        read: async () => status(),
        sleep: async () => {}
      })
    ).rejects.toThrow('cancelled')
  })
})
describe('cloud terminal settlement admission', () => {
  it('settles explicit remote termination, not disconnect, missing state, or successor show', () => {
    expect(cloudTerminalOwner(status(), status({ show: undefined, endReason: 'quota' }))).toBe(
      'show'
    )
    expect(cloudTerminalOwner(status(), status({ show: undefined }))).toBeNull()
    expect(cloudTerminalOwner(status(), status({ connected: false }))).toBeNull()
    expect(cloudTerminalOwner(null, status({ endReason: 'ended' }))).toBeNull()
    expect(
      cloudTerminalOwner(
        status(),
        status({ show: { id: 'successor', nodeId: 'managed', resumable: false } })
      )
    ).toBeNull()
  })
  it('handoff never settles the successor', () => {
    expect(
      cloudTerminalOwner(
        status(),
        status({ show: undefined, endReason: 'ended', stoppedBy: 'hand-off' })
      )
    ).toBeNull()
  })
})
