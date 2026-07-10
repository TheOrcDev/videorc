import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceBounds } from '../shared/backend'
import {
  NativePreviewMutationQueue,
  NativePreviewPlacementQueue,
  runPreparedNativePreviewMutation
} from './native-preview-operation-queue'

describe('NativePreviewMutationQueue', () => {
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
