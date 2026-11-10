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

/**
 * The backend refused a bounds update after the Electron proof window had
 * already followed the Preview window (#1272). Only this refusal is safe to
 * defer to the retrying placement queue; a failed surface create or setup
 * is not wrapped and still fails its caller.
 */
/**
 * What a scene update does when its placement reconcile fails (#1272).
 *
 * - A deferred backend refusal (the proof window already moved) is retried
 *   and the scene update carries on.
 * - A failed create, with no surface left, is retried as well so the Preview
 *   does not stay empty, but the error still fails the scene update.
 * - Any other failure fails the scene update, as before, with no retry.
 *
 * Every retry is forced: the queue's last applied rect can be the very one
 * that was just refused, and must not swallow it.
 */
export function scenePlacementFailureAction(
  error: unknown,
  surfaceExists: boolean
): { retry: boolean; rethrow: boolean } {
  if (error instanceof NativePreviewBackendBoundsRefusedError) {
    return { retry: true, rethrow: false }
  }
  return { retry: !surfaceExists, rethrow: true }
}

export class NativePreviewBackendBoundsRefusedError extends Error {
  constructor(readonly refusal: unknown) {
    super(
      `The preview backend refused the surface bounds: ${
        refusal instanceof Error ? refusal.message : String(refusal)
      }`
    )
    this.name = 'NativePreviewBackendBoundsRefusedError'
  }
}

/** What becomes of a failed placement. */
export interface NativePreviewPlacementFailure {
  /** 1 for the first try of this placement, 2 for its first retry, … */
  attempt: number
  /**
   * `retry` after `retryInMs`; `superseded` by a newer queued placement;
   * `cancelled` by teardown (`cancelPending`) while it was in flight; `gave-up`.
   */
  outcome: 'retry' | 'superseded' | 'cancelled' | 'gave-up'
  retryInMs: number | null
}

type NativePreviewPlacementErrorHandler = (
  error: unknown,
  failure: NativePreviewPlacementFailure
) => void
const PLACEMENT_ROUND_TRIP_SAMPLE_LIMIT = 900

/**
 * Backoff for a placement that failed with nothing newer queued behind it
 * (#1272). Windows moves the Preview's picture only when a push lands: the
 * backend refuses one while a scene or camera switch holds the surface
 * lifecycle (`surface-busy`, up to 3 s) or before the surface is live again,
 * and the popup emits no further move to try again, so without a retry the
 * picture stays where the last good push put it. About 10 s in all, longer
 * than a busy lifecycle wait; a newer placement replaces the retry at once.
 */
export const NATIVE_PREVIEW_PLACEMENT_RETRY_DELAYS_MS: readonly number[] = [
  100, 250, 500, 1_000, 2_000, 2_000, 2_000, 2_000
]

export interface NativePreviewPlacementRetryClock {
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
}

const DEFAULT_RETRY_CLOCK: NativePreviewPlacementRetryClock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface NativePreviewPlacementMetrics {
  received: number
  coalesced: number
  applied: number
  /** Placements that failed, counting each failed try of a retried one. */
  failed: number
  /** Retries run after a failed placement. */
  retried: number
  currentRequestDepth: number
  maxRequestDepth: number
  roundTripP95Ms?: number
}

interface ScheduledPlacementRetry {
  request: NativePreviewPlacementRequest
  attempt: number
  handle: unknown
}

export class NativePreviewPlacementQueue {
  private active: NativePreviewPlacementRequest | null = null
  private pending: NativePreviewPlacementRequest | null = null
  private lastApplied: NativePreviewPlacementRequest | null = null
  private retry: ScheduledPlacementRetry | null = null
  private failedCount = 0
  private retriedCount = 0
  private cancelEpoch = 0
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
    private readonly metricsTtlMs = 250,
    private readonly retryDelaysMs: readonly number[] = NATIVE_PREVIEW_PLACEMENT_RETRY_DELAYS_MS,
    private readonly retryClock: NativePreviewPlacementRetryClock = DEFAULT_RETRY_CLOCK
  ) {}

  get requestDepth(): number {
    return Number(this.active !== null) + Number(this.pending !== null)
  }

  get pendingCount(): number {
    return Number(this.pending !== null)
  }

  /** A failed placement is waiting to be tried again. */
  get retryScheduled(): boolean {
    return this.retry !== null
  }

  /**
   * Queue a placement. `force` is for one the caller knows did not land
   * (a refused reconcile outside this queue): it is not coalesced against
   * the last placement this queue applied, which may no longer be true of
   * the backend.
   */
  enqueue(request: NativePreviewPlacementRequest, options: { force?: boolean } = {}): boolean {
    this.receivedCount += 1
    // Every push reads the window's live rect, so the newest one supersedes a
    // retry: a fresh push of the failed rect runs now instead of waiting out
    // the backoff, and one back at the last landed rect needs no retry at all.
    this.cancelRetry()
    const desired = this.pending ?? this.active ?? (options.force ? null : this.lastApplied)
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
      this.start(request, 1)
    }
    this.maxRequestDepth = Math.max(this.maxRequestDepth, this.requestDepth)
    return true
  }

  cancelPending(): boolean {
    const hadPending = this.pending !== null || this.retry !== null
    this.pending = null
    this.cancelRetry()
    // A placement already in flight cannot be stopped, but if it fails it
    // must not schedule a retry: teardown destroyed the surface, and a late
    // retry would create it again (#1272 review).
    this.cancelEpoch += 1
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
        failed: this.failedCount,
        retried: this.retriedCount,
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

  private start(request: NativePreviewPlacementRequest, attempt: number): void {
    this.active = request
    const startedAtMs = this.nowMs()
    const epoch = this.cancelEpoch
    let failure: { error: unknown } | null = null
    void this.apply(request)
      .then(
        () => {
          this.lastApplied = request
          this.appliedCount += 1
        },
        (error: unknown) => {
          failure = { error }
          this.failedCount += 1
          // A forced placement can fail for the very rect recorded as last
          // applied; that rect is then not known to have landed, and an echo
          // of it must run instead of being coalesced away.
          if (this.lastApplied && placementRequestsEqual(this.lastApplied, request)) {
            this.lastApplied = null
          }
        }
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
        // Only the newest placement is worth retrying: a pending one already
        // replaces this rect, and one cancelled in flight has no surface left.
        const cancelled = epoch !== this.cancelEpoch
        const retryInMs =
          failure && !next && !cancelled ? (this.retryDelaysMs[attempt - 1] ?? null) : null
        if (failure) {
          this.onError(failure.error, {
            attempt,
            outcome: next
              ? 'superseded'
              : cancelled
                ? 'cancelled'
                : retryInMs === null
                  ? 'gave-up'
                  : 'retry',
            retryInMs
          })
        }
        if (next) {
          this.start(next, 1)
          return
        }
        if (retryInMs !== null) {
          this.scheduleRetry(request, attempt + 1, retryInMs)
        }
        for (const resolve of this.idleWaiters) {
          resolve()
        }
        this.idleWaiters.clear()
      })
  }

  // The retry does not hold the queue busy: `waitForIdle` callers (hiding the
  // surface, teardown) must not wait out a backoff, and any newer placement
  // replaces it at once.
  private scheduleRetry(
    request: NativePreviewPlacementRequest,
    attempt: number,
    delayMs: number
  ): void {
    this.cancelRetry()
    const retry: ScheduledPlacementRetry = { request, attempt, handle: null }
    retry.handle = this.retryClock.schedule(() => {
      if (this.retry !== retry) {
        return
      }
      this.retry = null
      if (this.active || this.pending) {
        return
      }
      this.retriedCount += 1
      this.start(request, attempt)
    }, delayMs)
    this.retry = retry
  }

  private cancelRetry(): void {
    if (!this.retry) {
      return
    }
    this.retryClock.cancel(this.retry.handle)
    this.retry = null
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
