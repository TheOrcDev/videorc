import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceBounds } from '../shared/backend'
import {
  NATIVE_PREVIEW_MUTATION_QUEUE_CAPACITY,
  NativePreviewMutationQueue,
  NativePreviewMutationQueueCapacityError,
  NativePreviewBackendBoundsRefusedError,
  NativePreviewPlacementQueue,
  NativePreviewPumpOwnership,
  handoffNativePreviewPumpOwnership,
  runPreparedNativePreviewMutation,
  scenePlacementFailureAction,
  type NativePreviewPlacementFailure,
  type NativePreviewPlacementRetryClock
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

  // #1272: a scene or camera switch holds the backend surface lifecycle, the
  // bounds push answers surface-busy, and the popup emits no further move.
  // The failed placement must land on its own once the backend frees up.
  it('retries a refused placement until it lands, with nothing else to move the window', async () => {
    const clock = new ManualRetryClock()
    const attemptsX: number[] = []
    const failures: NativePreviewPlacementFailure[] = []
    let refusals = 2
    const queue = new NativePreviewPlacementQueue(
      async ({ bounds }) => {
        attemptsX.push(bounds.screenX)
        if (bounds.screenX === 500 && refusals > 0) {
          refusals -= 1
          throw new Error(
            'The preview surface is busy with another lifecycle operation; retry shortly.'
          )
        }
      },
      (_error, failure) => failures.push(failure),
      () => 0,
      250,
      [100, 250, 500],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await queue.waitForIdle()
    queue.enqueue({ bounds: surfaceBounds(500), generation: 1 })
    await queue.waitForIdle()
    expect(queue.retryScheduled).toBe(true)
    expect(clock.delays).toEqual([100])

    await clock.fire()
    expect(clock.delays).toEqual([100, 250])
    await clock.fire()

    expect(attemptsX).toEqual([0, 500, 500, 500])
    expect(failures).toEqual([
      { attempt: 1, outcome: 'retry', retryInMs: 100 },
      { attempt: 2, outcome: 'retry', retryInMs: 250 }
    ])
    expect(queue.retryScheduled).toBe(false)
    // Landed: an echo of the same rect is coalesced, not re-applied.
    expect(queue.enqueue({ bounds: surfaceBounds(500), generation: 1 })).toBe(false)
    expect(queue.metrics()).toMatchObject({ applied: 2, failed: 2, retried: 2 })
  })

  it('gives up after its last backoff and says so once', async () => {
    const clock = new ManualRetryClock()
    const failures: NativePreviewPlacementFailure[] = []
    let attempts = 0
    const queue = new NativePreviewPlacementQueue(
      async () => {
        attempts += 1
        throw new Error('preview presenter bounds require an active preview surface')
      },
      (_error, failure) => failures.push(failure),
      () => 0,
      250,
      [100, 250],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(10), generation: 1 })
    await queue.waitForIdle()
    await clock.fire()
    await clock.fire()

    expect(attempts).toBe(3)
    expect(failures.map((failure) => failure.outcome)).toEqual(['retry', 'retry', 'gave-up'])
    expect(failures.at(-1)).toEqual({ attempt: 3, outcome: 'gave-up', retryInMs: null })
    expect(queue.retryScheduled).toBe(false)
    expect(clock.pending).toBe(0)
  })

  it('lets a newer placement replace a scheduled retry instead of moving the picture back', async () => {
    const clock = new ManualRetryClock()
    const appliedX: number[] = []
    let refuseNext = true
    const queue = new NativePreviewPlacementQueue(
      async ({ bounds }) => {
        if (refuseNext) {
          refuseNext = false
          throw new Error('surface-busy')
        }
        appliedX.push(bounds.screenX)
      },
      () => undefined,
      () => 0,
      250,
      [100],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(100), generation: 1 })
    await queue.waitForIdle()
    expect(queue.retryScheduled).toBe(true)

    queue.enqueue({ bounds: surfaceBounds(200), generation: 1 })
    await queue.waitForIdle()
    expect(queue.retryScheduled).toBe(false)
    expect(clock.pending).toBe(0)
    expect(appliedX).toEqual([200])
  })

  it('runs a fresh push of the refused rect at once rather than waiting out the backoff', async () => {
    const clock = new ManualRetryClock()
    const attemptsX: number[] = []
    let refuseNext = true
    const queue = new NativePreviewPlacementQueue(
      async ({ bounds }) => {
        attemptsX.push(bounds.screenX)
        if (refuseNext) {
          refuseNext = false
          throw new Error('surface-busy')
        }
      },
      () => undefined,
      () => 0,
      250,
      [2_000],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(300), generation: 1 })
    await queue.waitForIdle()
    expect(queue.enqueue({ bounds: surfaceBounds(300), generation: 1 })).toBe(true)
    await queue.waitForIdle()

    expect(attemptsX).toEqual([300, 300])
    expect(queue.retryScheduled).toBe(false)
    expect(queue.metrics()).toMatchObject({ applied: 1, failed: 1, retried: 0 })
  })

  it('drops the retry when the rect returns to where the last placement landed', async () => {
    const clock = new ManualRetryClock()
    const appliedX: number[] = []
    let refuse = false
    const queue = new NativePreviewPlacementQueue(
      async ({ bounds }) => {
        if (refuse) {
          throw new Error('surface-busy')
        }
        appliedX.push(bounds.screenX)
      },
      () => undefined,
      () => 0,
      250,
      [100],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await queue.waitForIdle()
    refuse = true
    queue.enqueue({ bounds: surfaceBounds(50), generation: 1 })
    await queue.waitForIdle()
    expect(queue.retryScheduled).toBe(true)

    expect(queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })).toBe(false)
    expect(queue.retryScheduled).toBe(false)
    expect(clock.pending).toBe(0)
    expect(appliedX).toEqual([0])
  })

  it('does not retry a placement a queued one already replaces', async () => {
    const clock = new ManualRetryClock()
    const failures: NativePreviewPlacementFailure[] = []
    const appliedX: number[] = []
    let releaseFirst!: () => void
    const firstMayFail = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queue = new NativePreviewPlacementQueue(
      async ({ bounds }) => {
        if (bounds.screenX === 0) {
          await firstMayFail
          throw new Error('surface-busy')
        }
        appliedX.push(bounds.screenX)
      },
      (_error, failure) => failures.push(failure),
      () => 0,
      250,
      [100],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await Promise.resolve()
    queue.enqueue({ bounds: surfaceBounds(70), generation: 1 })
    releaseFirst()
    await queue.waitForIdle()

    expect(appliedX).toEqual([70])
    expect(failures).toEqual([{ attempt: 1, outcome: 'superseded', retryInMs: null }])
    expect(queue.retryScheduled).toBe(false)
  })

  it('cancels a scheduled retry with the rest of the queued work on teardown', async () => {
    const clock = new ManualRetryClock()
    let attempts = 0
    const queue = new NativePreviewPlacementQueue(
      async () => {
        attempts += 1
        throw new Error('surface-busy')
      },
      () => undefined,
      () => 0,
      250,
      [100],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await queue.waitForIdle()
    expect(queue.cancelPending()).toBe(true)
    expect(queue.retryScheduled).toBe(false)
    expect(clock.pending).toBe(0)
    expect(attempts).toBe(1)
  })

  // Teardown (preview-surface:destroy, destroyNativePreviewSurface) can run
  // while a placement is in flight with the Preview window still open. If
  // that placement then fails, a retry would recreate the destroyed surface.
  it('never retries an in-flight placement that fails after teardown cancelled the queue', async () => {
    const clock = new ManualRetryClock()
    const failures: NativePreviewPlacementFailure[] = []
    let failInFlight!: () => void
    const inFlight = new Promise<void>((_resolve, reject) => {
      failInFlight = () => reject(new Error('surface-busy'))
    })
    let attempts = 0
    const queue = new NativePreviewPlacementQueue(
      async () => {
        attempts += 1
        await inFlight
      },
      (_error, failure) => failures.push(failure),
      () => 0,
      250,
      [100],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await Promise.resolve()
    queue.cancelPending()
    failInFlight()
    await queue.waitForIdle()
    await flushMicrotasks()

    expect(failures).toEqual([{ attempt: 1, outcome: 'cancelled', retryInMs: null }])
    expect(queue.retryScheduled).toBe(false)
    expect(clock.pending).toBe(0)
    expect(attempts).toBe(1)

    // The queue still works afterwards: a fresh placement runs normally.
    queue.enqueue({ bounds: surfaceBounds(10), generation: 2 })
    expect(attempts).toBe(2)
  })

  // A scene update's own reconcile can be refused for the very rect this
  // queue last applied (the backend lost it with the surface). Its forced
  // hand-off must run, not be coalesced against that stale `lastApplied`.
  it('runs a forced placement even when it matches the last one applied', async () => {
    const appliedX: number[] = []
    const queue = new NativePreviewPlacementQueue(async ({ bounds }) => {
      appliedX.push(bounds.screenX)
    })

    queue.enqueue({ bounds: surfaceBounds(40), generation: 1 })
    await queue.waitForIdle()
    expect(queue.enqueue({ bounds: surfaceBounds(40), generation: 1 })).toBe(false)
    expect(queue.enqueue({ bounds: surfaceBounds(40), generation: 1 }, { force: true })).toBe(true)
    await queue.waitForIdle()

    expect(appliedX).toEqual([40, 40])
  })

  // The scene update's decision, end to end with the queue: a direct create
  // fails with the surface absent and the very rect the queue last applied.
  it('retries a failed scene create for the last applied rect and still fails the update', async () => {
    const appliedX: number[] = []
    const queue = new NativePreviewPlacementQueue(async ({ bounds }) => {
      appliedX.push(bounds.screenX)
    })
    queue.enqueue({ bounds: surfaceBounds(40), generation: 1 })
    await queue.waitForIdle()

    const createFailure = new Error('Native preview proof surface could not be created')
    const action = scenePlacementFailureAction(createFailure, false)
    expect(action).toEqual({ retry: true, rethrow: true })
    expect(
      queue.enqueue({ bounds: surfaceBounds(40), generation: 1 }, { force: action.retry })
    ).toBe(true)
    await queue.waitForIdle()
    expect(appliedX).toEqual([40, 40])
  })

  it('runs an ordinary echo of a forced placement that failed for the last applied rect', async () => {
    const clock = new ManualRetryClock()
    const attemptsX: number[] = []
    let refuseForced = false
    const queue = new NativePreviewPlacementQueue(
      async ({ bounds }) => {
        attemptsX.push(bounds.screenX)
        if (refuseForced) {
          refuseForced = false
          throw new Error('surface-busy')
        }
      },
      () => undefined,
      () => 0,
      250,
      [2_000],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(40), generation: 1 })
    await queue.waitForIdle()
    refuseForced = true
    queue.enqueue({ bounds: surfaceBounds(40), generation: 1 }, { force: true })
    await queue.waitForIdle()
    expect(queue.retryScheduled).toBe(true)

    // A focus or show echo of the same rect during the backoff replaces the
    // retry, so it must run, not be coalesced against the stale record.
    expect(queue.enqueue({ bounds: surfaceBounds(40), generation: 1 })).toBe(true)
    await queue.waitForIdle()
    expect(attemptsX).toEqual([40, 40, 40])
    expect(queue.retryScheduled).toBe(false)
  })

  // #1272 end to end through the queue. The apply follows
  // applyNativePreviewHostCommands' Windows contract for a move: the proof
  // window follows the popup first, then a backend refusal is thrown as the
  // typed deferred error. The popup moves once and then stays still.
  it('lands a move the backend refuses once: the proof window follows at once and the backend half retries', async () => {
    const clock = new ManualRetryClock()
    const proofWindowRects: number[] = []
    const backendRects: number[] = []
    let backendRefusals = 1
    const queue = new NativePreviewPlacementQueue(
      async ({ bounds }) => {
        proofWindowRects.push(bounds.screenX)
        if (bounds.screenX === 620 && backendRefusals > 0) {
          backendRefusals -= 1
          throw new NativePreviewBackendBoundsRefusedError(
            new Error(
              'The preview surface is busy with another lifecycle operation; retry shortly.'
            )
          )
        }
        backendRects.push(bounds.screenX)
      },
      () => undefined,
      () => 0,
      250,
      [100],
      clock
    )
    const popupRect = surfaceBounds(620)

    queue.enqueue({ bounds: surfaceBounds(100), generation: 1 })
    await queue.waitForIdle()
    queue.enqueue({ bounds: popupRect, generation: 1 })
    await queue.waitForIdle()

    // The picture is already at the popup's rect; the backend is not yet.
    expect(proofWindowRects.at(-1)).toBe(620)
    expect(backendRects).toEqual([100])
    expect(queue.retryScheduled).toBe(true)

    await clock.fire()
    expect(proofWindowRects.at(-1)).toBe(620)
    expect(backendRects).toEqual([100, 620])
    expect(queue.retryScheduled).toBe(false)
  })

  it('decides a failed scene placement by what failed', () => {
    const refused = new NativePreviewBackendBoundsRefusedError(new Error('surface-busy'))
    // Deferred refusal: retried, the scene update carries on.
    expect(scenePlacementFailureAction(refused, true)).toEqual({ retry: true, rethrow: false })
    // Setup failure with the surface still there: fails as before, no retry.
    expect(scenePlacementFailureAction(new Error('script failed'), true)).toEqual({
      retry: false,
      rethrow: true
    })
  })

  it('names a deferred backend refusal apart from other failures', () => {
    const refusal = new Error('The preview surface is busy with another lifecycle operation')
    const error = new NativePreviewBackendBoundsRefusedError(refusal)
    expect(error).toBeInstanceOf(Error)
    expect(error.refusal).toBe(refusal)
    expect(error.message).toContain('busy with another lifecycle operation')
    expect(new Error('create failed')).not.toBeInstanceOf(NativePreviewBackendBoundsRefusedError)
  })

  it('reports idle while a retry waits, so hiding or closing never waits out a backoff', async () => {
    const clock = new ManualRetryClock()
    const queue = new NativePreviewPlacementQueue(
      async () => {
        throw new Error('surface-busy')
      },
      () => undefined,
      () => 0,
      250,
      [5_000],
      clock
    )

    queue.enqueue({ bounds: surfaceBounds(0), generation: 1 })
    await queue.waitForIdle()

    expect(queue.requestDepth).toBe(0)
    expect(queue.pendingCount).toBe(0)
    expect(queue.retryScheduled).toBe(true)
  })
})

class ManualRetryClock implements NativePreviewPlacementRetryClock {
  readonly delays: number[] = []
  private readonly scheduled = new Map<number, () => void>()
  private nextHandle = 1

  get pending(): number {
    return this.scheduled.size
  }

  schedule(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.delays.push(delayMs)
    this.scheduled.set(handle, callback)
    return handle
  }

  cancel(handle: unknown): void {
    this.scheduled.delete(handle as number)
  }

  /** Runs the one scheduled retry and lets its placement settle. */
  async fire(): Promise<void> {
    const entries = [...this.scheduled.entries()]
    expect(entries).toHaveLength(1)
    const [handle, callback] = entries[0]!
    this.scheduled.delete(handle)
    callback()
    await flushMicrotasks()
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

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
