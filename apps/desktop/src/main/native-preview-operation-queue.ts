import type { PreviewSurfaceBounds } from '../shared/backend'
import { previewSurfaceBoundsChanged } from '../shared/native-preview-bounds'

export class NativePreviewMutationQueue {
  private tail: Promise<void> = Promise.resolve()
  private queuedCount = 0

  get depth(): number {
    return this.queuedCount
  }

  run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    this.queuedCount += 1
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result.finally(() => {
      this.queuedCount = Math.max(0, this.queuedCount - 1)
    })
  }

  async waitForIdle(): Promise<void> {
    while (this.queuedCount > 0) {
      const observedTail = this.tail
      await observedTail
      if (observedTail === this.tail && this.queuedCount === 0) {
        return
      }
    }
  }
}

export interface PreparedNativePreviewMutation<Prepared, Result> {
  canApply: () => boolean
  prepare: () => Prepared | Promise<Prepared>
  apply: (prepared: Prepared) => Result | Promise<Result>
  rejected: () => Result | Promise<Result>
}

export function runPreparedNativePreviewMutation<Prepared, Result>(
  queue: NativePreviewMutationQueue,
  mutation: PreparedNativePreviewMutation<Prepared, Result>
): Promise<Result> {
  return queue.run(async () => {
    if (!mutation.canApply()) {
      return mutation.rejected()
    }
    const prepared = await mutation.prepare()
    if (!mutation.canApply()) {
      return mutation.rejected()
    }
    return mutation.apply(prepared)
  })
}

export interface NativePreviewPlacementRequest {
  bounds: PreviewSurfaceBounds
  generation: number
}

type NativePreviewPlacementApply = (request: NativePreviewPlacementRequest) => Promise<void>
type NativePreviewPlacementErrorHandler = (error: unknown) => void
const PLACEMENT_ROUND_TRIP_SAMPLE_LIMIT = 900

export interface NativePreviewPlacementMetrics {
  received: number
  coalesced: number
  applied: number
  currentRequestDepth: number
  maxRequestDepth: number
  roundTripP95Ms?: number
}

export class NativePreviewPlacementQueue {
  private active: NativePreviewPlacementRequest | null = null
  private pending: NativePreviewPlacementRequest | null = null
  private lastApplied: NativePreviewPlacementRequest | null = null
  private readonly idleWaiters = new Set<() => void>()
  private receivedCount = 0
  private coalescedCount = 0
  private appliedCount = 0
  private maxRequestDepth = 0
  private readonly roundTripSamplesMs: number[] = []

  constructor(
    private readonly apply: NativePreviewPlacementApply,
    private readonly onError: NativePreviewPlacementErrorHandler = () => undefined,
    private readonly nowMs: () => number = () => Date.now()
  ) {}

  get requestDepth(): number {
    return Number(this.active !== null) + Number(this.pending !== null)
  }

  get pendingCount(): number {
    return Number(this.pending !== null)
  }

  enqueue(request: NativePreviewPlacementRequest): boolean {
    this.receivedCount += 1
    const desired = this.pending ?? this.active ?? this.lastApplied
    if (desired && placementRequestsEqual(desired, request)) {
      this.coalescedCount += 1
      return false
    }
    if (this.active) {
      if (this.pending) {
        this.coalescedCount += 1
      }
      this.pending = request
    } else {
      this.start(request)
    }
    this.maxRequestDepth = Math.max(this.maxRequestDepth, this.requestDepth)
    return true
  }

  cancelPending(): boolean {
    const hadPending = this.pending !== null
    this.pending = null
    return hadPending
  }

  metrics(): NativePreviewPlacementMetrics {
    return {
      received: this.receivedCount,
      coalesced: this.coalescedCount,
      applied: this.appliedCount,
      currentRequestDepth: this.requestDepth,
      maxRequestDepth: this.maxRequestDepth,
      roundTripP95Ms: percentile(this.roundTripSamplesMs, 0.95)
    }
  }

  waitForIdle(): Promise<void> {
    if (this.requestDepth === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  private start(request: NativePreviewPlacementRequest): void {
    this.active = request
    const startedAtMs = this.nowMs()
    void this.apply(request)
      .then(
        () => {
          this.lastApplied = request
          this.appliedCount += 1
        },
        (error) => this.onError(error)
      )
      .finally(() => {
        recordLimitedSample(
          this.roundTripSamplesMs,
          Math.max(0, this.nowMs() - startedAtMs),
          PLACEMENT_ROUND_TRIP_SAMPLE_LIMIT
        )
        this.active = null
        const next = this.pending
        this.pending = null
        if (next) {
          this.start(next)
          return
        }
        for (const resolve of this.idleWaiters) {
          resolve()
        }
        this.idleWaiters.clear()
      })
  }
}

function percentile(values: number[], percentileRank: number): number | undefined {
  if (values.length === 0) {
    return undefined
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileRank) - 1)
  )
  return sorted[index]
}

function recordLimitedSample(samples: number[], value: number, limit: number): void {
  if (!Number.isFinite(value)) {
    return
  }
  samples.push(value)
  while (samples.length > limit) {
    samples.shift()
  }
}

function placementRequestsEqual(
  previous: NativePreviewPlacementRequest,
  next: NativePreviewPlacementRequest
): boolean {
  return (
    previous.generation === next.generation &&
    !previewSurfaceBoundsChanged(previous.bounds, next.bounds)
  )
}
