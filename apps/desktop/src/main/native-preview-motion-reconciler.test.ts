import { describe, expect, it, vi } from 'vitest'

import { NativePreviewMotionReconciler } from './native-preview-motion-reconciler'

describe('NativePreviewMotionReconciler', () => {
  it('coalesces a move storm to one display-cadence reconciliation', () => {
    const callbacks: Array<() => void> = []
    const reconcile = vi.fn()
    const reconciler = new NativePreviewMotionReconciler(reconcile, {
      schedule: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
      cancel: vi.fn()
    })

    reconciler.request()
    reconciler.request()
    reconciler.request()

    expect(callbacks).toHaveLength(1)
    expect(reconcile).not.toHaveBeenCalled()
    callbacks[0]()
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('flushes the newest geometry immediately at movement end', () => {
    const cancel = vi.fn()
    const reconcile = vi.fn()
    const reconciler = new NativePreviewMotionReconciler(reconcile, {
      schedule: () => 42,
      cancel
    })

    reconciler.request()
    reconciler.flush()

    expect(cancel).toHaveBeenCalledWith(42)
    expect(reconcile).toHaveBeenCalledOnce()
    reconciler.cancel()
    expect(reconcile).toHaveBeenCalledOnce()
  })
})
