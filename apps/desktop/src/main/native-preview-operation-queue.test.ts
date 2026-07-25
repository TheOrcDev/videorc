import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceBounds } from '../shared/backend'
import {
  NATIVE_PREVIEW_MUTATION_QUEUE_CAPACITY,
  NativePreviewMutationQueue,
  NativePreviewMutationQueueCapacityError,
  NativePreviewPlacementQueue,
  NativePreviewPumpOwnership,
  handoffNativePreviewPumpOwnership,
  runPreparedNativePreviewMutation
} from './native-preview-operation-queue'

describe('NativePreviewPumpOwnership', () => {
  it('fences an active renderer present and its pending work when main takes over', () => {
    const ownership = new NativePreviewPumpOwnership()
    const activeRenderer = ownership.ticket('renderer')
    const pendingRenderer = ownership.ticket('renderer')

    ownership.setMainActive(true)

    expect(ownership.accepts(activeRenderer)).toBe(false)
    expect(ownership.accepts(pendingRenderer)).toBe(false)
    expect(ownership.accepts(ownership.ticket('main'))).toBe(true)
  })

  it('fences an active main present and its pending work when renderer takes over', () => {
    const ownership = new NativePreviewPumpOwnership()
    ownership.setMainActive(true)
    const activeMain = ownership.ticket('main')
    const pendingMain = ownership.ticket('main')

    ownership.setMainActive(false)

    expect(ownership.accepts(activeMain)).toBe(false)
    expect(ownership.accepts(pendingMain)).toBe(false)
    expect(ownership.accepts(ownership.ticket('renderer'))).toBe(true)
  })

  it('waits for a blocked active present before publishing the new owner', async () => {
    const ownership = new NativePreviewPumpOwnership()
    const activeRenderer = ownership.ticket('renderer')
    let releasePresent!: () => void
    const activePresent = new Promise<void>((resolve) => {
      releasePresent = resolve
    })
    let handoffFinished = false

    const handoff = handoffNativePreviewPumpOwnership(ownership, true, () => activePresent).then(
      (changed) => {
        handoffFinished = changed
      }
    )
    await Promise.resolve()

    expect(ownership.accepts(activeRenderer)).toBe(false)
    expect(ownership.accepts(ownership.ticket('main'))).toBe(false)
    expect(handoffFinished).toBe(false)

    releasePresent()
    await handoff

    expect(handoffFinished).toBe(true)
    expect(ownership.accepts(ownership.ticket('main'))).toBe(true)
  })
})

describe('NativePreviewMutationQueue', () => {
  it('counts only work waiting behind the active host operation as pending', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queue = new NativePreviewMutationQueue()

    const first = queue.run(async () => {
      expect(queue.depth).toBe(1)
      expect(queue.activeCount).toBe(1)
      expect(queue.pendingCount).toBe(0)
      await firstMayFinish
    }, 'first-operation')
    await Promise.resolve()

    expect(queue.activeOperationLabel).toBe('first-operation')

    const second = queue.run(() => undefined)
    expect(queue.depth).toBe(2)
    expect(queue.activeCount).toBe(1)
    expect(queue.pendingCount).toBe(1)
    expect(queue.metrics()).toMatchObject({
      currentDepth: 2,
      activeCount: 1,
      pendingCount: 1,
      maxDepth: 2
    })

    releaseFirst()
    await Promise.all([first, second])
    expect(queue.depth).toBe(0)
    expect(queue.activeCount).toBe(0)
    expect(queue.pendingCount).toBe(0)
    expect(queue.activeOperationLabel).toBeNull()
  })

  it('admits exactly its active-plus-waiting capacity and explicitly rejects overflow', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queue = new NativePreviewMutationQueue(2)
    let overflowStarted = false

    const first = queue.run(() => firstMayFinish)
    await Promise.resolve()
    const second = queue.run(() => undefined)
    const overflow = queue.run(() => {
      overflowStarted = true
    })

    await expect(overflow).rejects.toEqual(
      expect.objectContaining<Partial<NativePreviewMutationQueueCapacityError>>({
        name: 'NativePreviewMutationQueueCapacityError',
        capacity: 2,
        activeCount: 1,
        pendingCount: 1
      })
    )
    expect(overflowStarted).toBe(false)
    expect(queue.metrics()).toEqual({
      capacity: 2,
      accepted: 2,
      rejected: 1,
      currentDepth: 2,
      activeCount: 1,
      pendingCount: 1,
      maxDepth: 2
    })

    releaseFirst()
    await Promise.all([first, second])
  })

  it('accepts new reliable work after a saturated queue drains', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queue = new NativePreviewMutationQueue(1)
    const events: string[] = []

    const first = queue.run(async () => {
      events.push('first:start')
      await firstMayFinish
      events.push('first:end')
    })
    await Promise.resolve()
    await expect(queue.run(() => events.push('overflow'))).rejects.toBeInstanceOf(
      NativePreviewMutationQueueCapacityError
    )

    releaseFirst()
    await first
    await expect(queue.run(() => events.push('after-drain'))).resolves.toBe(3)

    expect(events).toEqual(['first:start', 'first:end', 'after-drain'])
    expect(queue.metrics()).toEqual({
      capacity: 1,
      accepted: 2,
      rejected: 1,
      currentDepth: 0,
      activeCount: 0,
      pendingCount: 0,
      maxDepth: 1
    })
  })

  it('declares a finite production admission limit', () => {
    expect(Number.isSafeInteger(NATIVE_PREVIEW_MUTATION_QUEUE_CAPACITY)).toBe(true)
    expect(NATIVE_PREVIEW_MUTATION_QUEUE_CAPACITY).toBe(32)
    expect(new NativePreviewMutationQueue().capacity).toBe(NATIVE_PREVIEW_MUTATION_QUEUE_CAPACITY)
  })

  it('gives each concurrent mutation exclusive ownership in call order', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const events: string[] = []
    const queue = new NativePreviewMutationQueue()

    const first = queue.run(async () => {
      events.push('first:start')
      await firstMayFinish
      events.push('first:end')
      return 'first'
    })
    const second = queue.run(async () => {
      events.push('second:start')
      events.push('second:end')
      return 'second'
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('does not report idle when a mutation is appended while a waiter is pending', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondMayFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const queue = new NativePreviewMutationQueue()
    let idle = false

    const first = queue.run(() => firstMayFinish)
    const waiter = queue.waitForIdle().then(() => {
      idle = true
    })
    const second = queue.run(() => secondMayFinish)

    releaseFirst()
    await first
    await Promise.resolve()
    expect(idle).toBe(false)

    releaseSecond()
    await Promise.all([second, waiter])
    expect(idle).toBe(true)
  })

  it('does not attach, present, or publish live state when close wins during compositor refresh', async () => {
    let releaseRefresh!: () => void
    const refreshMayFinish = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const events: string[] = []
    const queue = new NativePreviewMutationQueue()
    let presentationAllowed = true

    const compositor = runPreparedNativePreviewMutation(queue, {
      canApply: () => presentationAllowed,
      prepare: async () => {
        events.push('refresh:start')
        await refreshMayFinish
        events.push('refresh:end')
        return 'fresh-frame'
      },
      apply: () => {
        events.push('attach')
        events.push('present')
        events.push('live')
        return 'presented'
      },
      rejected: () => {
        events.push('rejected')
        return 'rejected'
      }
    })
    await Promise.resolve()
    presentationAllowed = false
    const destroy = queue.run(() => {
      events.push('destroy')
    })

    releaseRefresh()
    await expect(compositor).resolves.toBe('rejected')
    await destroy
    expect(events).toEqual(['refresh:start', 'refresh:end', 'rejected', 'destroy'])
  })
})

describe('NativePreviewPlacementQueue', () => {
  it('keeps one request in flight and applies only the newest pending placement', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const appliedX: number[] = []
    let concurrent = 0
    let maxConcurrent = 0
    const queue = new NativePreviewPlacementQueue(async ({ bounds }) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      appliedX.push(bounds.screenX)
      if (appliedX.length === 1) {
        await firstMayFinish
      }
      concurrent -= 1
    })

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await Promise.resolve()
    queue.enqueue({ bounds: surfaceBounds(10), generation: 1 })
    queue.enqueue({ bounds: surfaceBounds(20), generation: 1 })
    queue.enqueue({ bounds: surfaceBounds(30), generation: 1 })

    expect(queue.requestDepth).toBe(2)
    expect(queue.pendingCount).toBe(1)
    releaseFirst()
    await queue.waitForIdle()

    expect(appliedX).toEqual([0, 30])
    expect(maxConcurrent).toBe(1)
    expect(queue.requestDepth).toBe(0)
    expect(queue.metrics()).toMatchObject({
      received: 4,
      coalesced: 2,
      applied: 2,
      maxRequestDepth: 2
    })
  })

  it('lets lifecycle teardown discard a queued movement before it can run', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const appliedX: number[] = []
    const queue = new NativePreviewPlacementQueue(async ({ bounds }) => {
      appliedX.push(bounds.screenX)
      if (appliedX.length === 1) {
        await firstMayFinish
      }
    })

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await Promise.resolve()
    queue.enqueue({ bounds: surfaceBounds(100), generation: 1 })

    expect(queue.cancelPending()).toBe(true)
    expect(queue.pendingCount).toBe(0)
    releaseFirst()
    await queue.waitForIdle()

    expect(appliedX).toEqual([0])
  })

  it('drops unchanged focus and show echoes', async () => {
    const applied: PreviewSurfaceBounds[] = []
    const queue = new NativePreviewPlacementQueue(async ({ bounds }) => {
      applied.push(bounds)
    })
    const bounds = surfaceBounds(40)

    expect(queue.enqueue({ bounds, generation: 1 })).toBe(true)
    expect(queue.enqueue({ bounds: { ...bounds }, generation: 1 })).toBe(false)
    await queue.waitForIdle()
    expect(queue.enqueue({ bounds: { ...bounds }, generation: 1 })).toBe(false)

    expect(applied).toEqual([bounds])
  })

  it('computes placement percentiles only at telemetry cadence', () => {
    let nowMs = 1_000
    const queue = new NativePreviewPlacementQueue(
      async () => undefined,
      () => undefined,
      () => nowMs,
      250
    )

    for (let index = 0; index < 10_000; index += 1) {
      queue.metrics()
      nowMs += 1
    }

    expect(queue.telemetryRefreshCount).toBeGreaterThanOrEqual(40)
    expect(queue.telemetryRefreshCount).toBeLessThanOrEqual(41)
  })
})

function surfaceBounds(screenX: number): PreviewSurfaceBounds {
  return {
    screenX,
    screenY: 20,
    width: 640,
    height: 360,
    scaleFactor: 2,
    screenHeight: 1000,
    visible: true,
    orderAboveWindowId: 42,
    elevated: false
  }
}
