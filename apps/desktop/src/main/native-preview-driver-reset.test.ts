import { describe, expect, it } from 'vitest'

import { NativePreviewMutationQueue } from './native-preview-operation-queue'
import {
  runNativePreviewDriverReset,
  runNativePreviewExplicitProofFallback
} from './native-preview-driver-reset'

describe('native preview driver reset', () => {
  it('retires the wedged driver before resolving and attaching a replacement', async () => {
    const oldDriver = { stopped: false }
    const replacement = { attached: false }
    let currentDriver: typeof oldDriver | typeof replacement | null = oldDriver
    let retryBlocked = true

    await runNativePreviewDriverReset({
      retire: async () => {
        oldDriver.stopped = true
        currentDriver = null
      },
      allowImmediateRetry: () => {
        retryBlocked = false
      },
      reconcile: async () => {
        if (!retryBlocked && currentDriver === null) {
          replacement.attached = true
          currentDriver = replacement
        }
      }
    })

    expect(oldDriver.stopped).toBe(true)
    expect(replacement.attached).toBe(true)
    expect(currentDriver).toBe(replacement)
  })
})

describe('native preview explicit proof fallback', () => {
  type Status = { transport: 'native-surface' | 'electron-proof-surface' }

  /**
   * A compositor update on the old driver is already in flight when the smoke
   * asks for the fallback. It finishes later and writes the native status.
   */
  function scenario() {
    const queue = new NativePreviewMutationQueue()
    let status: Status = { transport: 'native-surface' }
    let releaseInFlight: () => void = () => {}
    const inFlightGate = new Promise<void>((resolve) => {
      releaseInFlight = resolve
    })
    const inFlight = queue.run(async () => {
      await inFlightGate
      status = { transport: 'native-surface' }
    }, 'update-compositor')
    const retire = async () => {
      status = { transport: 'electron-proof-surface' }
    }
    return { queue, retire, inFlight, releaseInFlight, read: () => status }
  }

  it('reports the fallback after an in-flight native update finishes first', async () => {
    const { queue, retire, releaseInFlight, read } = scenario()

    const answer = runNativePreviewExplicitProofFallback({
      serialize: (operation) => queue.run(operation, 'explicit-proof-fallback'),
      retire,
      status: read
    })
    // The old driver's update completes only now.
    releaseInFlight()

    await expect(answer).resolves.toEqual({ transport: 'electron-proof-surface' })
  })

  it('shows why: retiring outside the queue lets the in-flight update win', async () => {
    const { inFlight, retire, releaseInFlight, read } = scenario()

    await retire()
    releaseInFlight()
    await inFlight

    // The bug this helper prevents: the stale native status overwrote the fallback.
    expect(read()).toEqual({ transport: 'native-surface' })
  })

  it('runs queued mutations that arrive after it on the fallback status', async () => {
    const queue = new NativePreviewMutationQueue()
    let status: Status = { transport: 'native-surface' }
    const order: string[] = []

    const answer = runNativePreviewExplicitProofFallback({
      serialize: (operation) => queue.run(operation, 'explicit-proof-fallback'),
      retire: async () => {
        order.push('retire')
        status = { transport: 'electron-proof-surface' }
      },
      status: () => status
    })
    const later = queue.run(() => {
      order.push(`later saw ${status.transport}`)
    }, 'update-compositor')

    await Promise.all([answer, later])
    expect(order).toEqual(['retire', 'later saw electron-proof-surface'])
  })
})
