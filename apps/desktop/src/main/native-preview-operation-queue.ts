import type { PreviewSurfaceBounds } from '../shared/backend'
import { previewSurfaceBoundsChanged } from '../shared/native-preview-bounds'

export type NativePreviewPumpOwner = 'main' | 'renderer'

export interface NativePreviewPumpOwnershipTicket {
  owner: NativePreviewPumpOwner
  generation: number
}

/** Fences in-flight presents whenever ownership moves between main and renderer. */
export class NativePreviewPumpOwnership {
  private generation = 0
  private mainActive = false
  private handoff = false

  setMainActive(active: boolean): boolean {
    if (this.mainActive === active) {
      return false
    }
    this.mainActive = active
    this.generation += 1
    return true
  }

  ticket(owner: NativePreviewPumpOwner): NativePreviewPumpOwnershipTicket {
    return { owner, generation: this.generation }
  }

  accepts(ticket: NativePreviewPumpOwnershipTicket): boolean {
    return (
      !this.handoff &&
      ticket.generation === this.generation &&
      (ticket.owner === 'main' ? this.mainActive : !this.mainActive)
    )
  }

  beginHandoff(): number {
    this.handoff = true
    this.generation += 1
    return this.generation
  }

  finishHandoff(handoffGeneration: number, mainActive: boolean): boolean {
    if (!this.handoff || handoffGeneration !== this.generation) {
      return false
    }
    this.mainActive = mainActive
    this.handoff = false
    // Tickets created while neither owner was allowed must stay invalid.
    this.generation += 1
    return true
  }
}

export async function handoffNativePreviewPumpOwnership(
  ownership: NativePreviewPumpOwnership,
  mainActive: boolean,
  waitForActivePresent: () => Promise<void>
): Promise<boolean> {
  const generation = ownership.beginHandoff()
  await waitForActivePresent()
  return ownership.finishHandoff(generation, mainActive)
}

/**
 * Reliable lifecycle/present mutations are infrequent and upstream present
 * pumps are already latest-wins. This limit prevents a stalled native host
 * call from retaining an unbounded promise/closure chain while leaving enough
 * room for lifecycle bursts to preserve their ordering.
 */
export const NATIVE_PREVIEW_MUTATION_QUEUE_CAPACITY = 32

export interface NativePreviewMutationQueueMetrics {
  capacity: number
  accepted: number
  rejected: number
  currentDepth: number
  activeCount: number
  pendingCount: number
  maxDepth: number
}

export class NativePreviewMutationQueueCapacityError extends Error {
  readonly name = 'NativePreviewMutationQueueCapacityError'

  constructor(
    readonly capacity: number,
    readonly activeCount: number,
    readonly pendingCount: number
  ) {
    super(
      `Native preview mutation queue capacity ${capacity} exceeded ` +
        `(${activeCount} active, ${pendingCount} waiting).`
    )
  }
}

export class NativePreviewMutationQueue {
  private tail: Promise<void> = Promise.resolve()
  private queuedCount = 0
  private operationActive = false
  private activeLabel: string | null = null
  private acceptedCount = 0
  private rejectedCount = 0
  private maxDepth = 0

  constructor(readonly capacity = NATIVE_PREVIEW_MUTATION_QUEUE_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Native preview mutation queue capacity must be a positive integer.')
    }
  }

  get depth(): number {
    return this.queuedCount
  }

  get activeCount(): number {
    return Number(this.operationActive)
  }

  get activeOperationLabel(): string | null {
    return this.activeLabel
  }

  /** Work waiting behind the operation that already owns the host. */
  get pendingCount(): number {
    return Math.max(0, this.queuedCount - this.activeCount)
  }

  metrics(): NativePreviewMutationQueueMetrics {
    return {
      capacity: this.capacity,
      accepted: this.acceptedCount,
      rejected: this.rejectedCount,
      currentDepth: this.depth,
      activeCount: this.activeCount,
      pendingCount: this.pendingCount,
      maxDepth: this.maxDepth
    }
  }

  run<Result>(operation: () => Result | Promise<Result>, label = 'unlabeled'): Promise<Result> {
    if (this.queuedCount >= this.capacity) {
      this.rejectedCount += 1
      return Promise.reject(
        new NativePreviewMutationQueueCapacityError(
          this.capacity,
          this.activeCount,
          this.pendingCount
        )
      )
    }
    this.queuedCount += 1
    this.acceptedCount += 1
    this.maxDepth = Math.max(this.maxDepth, this.queuedCount)
    const invoke = async (): Promise<Result> => {
      this.operationActive = true
      this.activeLabel = label
      try {
        return await operation()
      } finally {
        this.operationActive = false
        this.activeLabel = null
        this.queuedCount = Math.max(0, this.queuedCount - 1)
      }
    }
    const result = this.tail.then(invoke, invoke)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
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
  label?: string
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
  }, mutation.label)
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
  private cachedMetrics: NativePreviewPlacementMetrics | undefined
  private metricsComputedAtMs: number | undefined
  private metricsRefreshes = 0

  constructor(
    private readonly apply: NativePreviewPlacementApply,
    private readonly onError: NativePreviewPlacementErrorHandler = () => undefined,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly metricsTtlMs = 250
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
    const nowMs = this.nowMs()
    if (
      !this.cachedMetrics ||
      this.metricsComputedAtMs === undefined ||
      nowMs < this.metricsComputedAtMs ||
      nowMs - this.metricsComputedAtMs >= this.metricsTtlMs
    ) {
      this.metricsRefreshes += 1
      this.cachedMetrics = {
        received: this.receivedCount,
        coalesced: this.coalescedCount,
        applied: this.appliedCount,
        currentRequestDepth: this.requestDepth,
        maxRequestDepth: this.maxRequestDepth,
        roundTripP95Ms: percentile(this.roundTripSamplesMs, 0.95)
      }
      this.metricsComputedAtMs = nowMs
    }
    return { ...this.cachedMetrics, currentRequestDepth: this.requestDepth }
  }

  get telemetryRefreshCount(): number {
    return this.metricsRefreshes
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
