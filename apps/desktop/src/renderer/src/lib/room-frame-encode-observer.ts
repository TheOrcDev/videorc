import type { EncodeWorkerReply, EncodedFrameRecord } from './room-frame-encode-worker'

/**
 * Plan 249 S13a harness only: observe the camera bridge's encoder output per
 * encoded frame through `RTCRtpScriptTransform` (the standard WebRTC Encoded
 * Transform). Frames pass through the worker unchanged.
 *
 * No fallback: without `RTCRtpScriptTransform` or a sender the observer is
 * `unavailable` with the exact API and reason. `createEncodedStreams` is never
 * used (it needs `encodedInsertableStreams` peer-connection config that
 * LiveKit sets only for E2EE). Nothing here throws into the publish path.
 *
 * Clocks: worker records carry worker `performance.timeOrigin + now()`. They
 * are converted to renderer `performance.now()` ms by subtracting the
 * renderer's `timeOrigin`, and every drain measures a ping-pong bracket so the
 * agreement of the two time origins is MEASURED, never assumed.
 */
export const ENCODE_OBSERVER_API = 'RTCRtpScriptTransform'
export const ENCODE_DRAIN_INTERVAL_MS = 500
const FINAL_DRAIN_TIMEOUT_MS = 250

export type EncodeObserver = {
  detach: () => Promise<void>
  status: 'observing' | 'unavailable'
  reason?: string
}

export type WorkerLike = {
  postMessage: (message: unknown) => void
  terminate: () => void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}
type ScriptTransformCtor = new (worker: never, options?: unknown) => unknown
export type EncodeObserverRuntime = {
  /** Defaults to `globalThis.RTCRtpScriptTransform`; `null` means absent. */
  ScriptTransform?: ScriptTransformCtor | null
  createWorker?: () => WorkerLike
  now?: () => number
  timeOrigin?: number
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
  drainIntervalMs?: number
}

/** A drain's measured bracket. `timeOriginBracketMs` bounds (worker clock
 * converted to renderer ms) minus (renderer clock): a record's true renderer
 * time lies in [atMs - highMs, atMs - lowMs]. */
export type EncodeClockBracket = {
  sentAtMs: number
  workerEpochMs: number
  workerAtMs: number
  receivedAtMs: number
  timeOriginBracketMs: { lowMs: number; highMs: number }
  /** True when zero offset lies inside the measured bracket. */
  originsAgree: boolean
}
export type EncodedObservationRecord = EncodedFrameRecord & {
  /** Renderer `performance.now()` ms: `atEpochMs - performance.timeOrigin`. */
  atMs: number
}

function unavailable(
  generation: number,
  observe: (value: unknown) => void,
  reason: string
): EncodeObserver {
  try {
    observe({
      phase: 'encode-observer',
      generation,
      api: ENCODE_OBSERVER_API,
      status: 'unavailable',
      reason,
      productionQualified: false
    })
  } catch {
    // A diagnostic sink can never break publishing.
  }
  return { status: 'unavailable', reason, detach: () => Promise.resolve() }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function attachEncodeObserver(
  sender: RTCRtpSender | null | undefined,
  generation: number,
  observe: (value: unknown) => void,
  runtime: EncodeObserverRuntime = {}
): EncodeObserver {
  const ScriptTransform =
    runtime.ScriptTransform === undefined
      ? (globalThis as { RTCRtpScriptTransform?: ScriptTransformCtor }).RTCRtpScriptTransform
      : runtime.ScriptTransform
  if (typeof ScriptTransform !== 'function')
    return unavailable(
      generation,
      observe,
      'RTCRtpScriptTransform is not defined in this renderer; createEncodedStreams is not used (needs encodedInsertableStreams peer-connection config).'
    )
  if (!sender)
    return unavailable(
      generation,
      observe,
      'The published camera has no RTCRtpSender (LocalTrack.sender is undefined).'
    )
  if (!('transform' in sender))
    return unavailable(generation, observe, 'RTCRtpSender.transform is not supported here.')

  const now = runtime.now ?? (() => performance.now())
  const timeOrigin = runtime.timeOrigin ?? performance.timeOrigin
  const schedule = runtime.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  const cancel = runtime.cancel ?? ((timer) => clearTimeout(timer))
  const interval = runtime.drainIntervalMs ?? ENCODE_DRAIN_INTERVAL_MS
  const emit = (value: Record<string, unknown>): void => {
    try {
      observe({ ...value, generation, productionQualified: false })
    } catch {
      // Diagnostics never affect the observed pipeline.
    }
  }

  let worker: WorkerLike
  try {
    worker = runtime.createWorker
      ? runtime.createWorker()
      : (new Worker(new URL('./room-frame-encode-worker.ts', import.meta.url), {
          type: 'module'
        }) as unknown as WorkerLike)
  } catch (error) {
    return unavailable(generation, observe, `Encode observer worker failed: ${messageOf(error)}`)
  }

  let state: 'active' | 'detaching' | 'detached' = 'active'
  let pending: { sentAtMs: number; resolve?: () => void } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastDropped = 0
  const counters = { drains: 0, records: 0, ignoredMessages: 0, foreignTransformRecords: 0 }
  let transformStarted = false

  worker.onmessage = ({ data }) => {
    const reply = data as EncodeWorkerReply | null
    // Generation fence: late or foreign messages are ignored, never merged.
    if (state === 'detached' || !reply || reply.generation !== generation) {
      counters.ignoredMessages++
      return
    }
    if (reply.type === 'transform-started') {
      transformStarted = true
      emit({ phase: 'encode-observer', api: ENCODE_OBSERVER_API, status: 'observing' })
      return
    }
    if (reply.type === 'transform-error') {
      emit({
        phase: 'encode-observer',
        api: ENCODE_OBSERVER_API,
        status: 'unavailable',
        reason: `Encoded transform pipe failed: ${reply.reason}`
      })
      return
    }
    if (reply.type !== 'drained' || !pending) {
      counters.ignoredMessages++
      return
    }
    const receivedAtMs = now()
    const { sentAtMs, resolve } = pending
    pending = null
    counters.drains++
    const workerAtMs = reply.workerEpochMs - timeOrigin
    const bracket: EncodeClockBracket = {
      sentAtMs,
      workerEpochMs: reply.workerEpochMs,
      workerAtMs,
      receivedAtMs,
      timeOriginBracketMs: { lowMs: workerAtMs - receivedAtMs, highMs: workerAtMs - sentAtMs },
      originsAgree: workerAtMs >= sentAtMs && workerAtMs <= receivedAtMs
    }
    let records: EncodedObservationRecord[] = []
    if (reply.transformGeneration !== null && reply.transformGeneration !== generation)
      counters.foreignTransformRecords += reply.records.length
    else
      records = reply.records.map((record) => ({
        ...record,
        atMs: record.atEpochMs - timeOrigin
      }))
    counters.records += records.length
    if (records.length > 0 || reply.dropped !== lastDropped)
      emit({
        phase: 'encoded',
        observed: 'renderer-encoded-transform',
        records,
        dropped: reply.dropped,
        recorded: reply.recorded,
        bracket
      })
    lastDropped = reply.dropped
    resolve?.()
  }
  worker.onerror = (event) => {
    if (state === 'detached') return
    const reason = (event as { message?: unknown } | null)?.message
    emit({
      phase: 'encode-observer',
      api: ENCODE_OBSERVER_API,
      status: 'unavailable',
      reason: `Encode observer worker error: ${typeof reason === 'string' ? reason : 'unknown'}`
    })
  }

  const drain = (resolve?: () => void): boolean => {
    if (pending) return false
    pending = { sentAtMs: now(), resolve }
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker, not a window.
      worker.postMessage({ type: 'drain', generation })
      return true
    } catch {
      pending = null
      return false
    }
  }
  const tick = (): void => {
    timer = undefined
    if (state !== 'active') return
    drain()
    timer = schedule(tick, interval)
  }

  try {
    ;(sender as { transform: unknown }).transform = new ScriptTransform(worker as never, {
      generation
    })
  } catch (error) {
    state = 'detached'
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    return unavailable(
      generation,
      observe,
      `RTCRtpSender.transform = new RTCRtpScriptTransform() failed: ${messageOf(error)}`
    )
  }
  emit({ phase: 'encode-observer', api: ENCODE_OBSERVER_API, status: 'attached' })
  timer = schedule(tick, interval)

  let detaching: Promise<void> | null = null
  const detach = (): Promise<void> => {
    if (detaching) return detaching
    state = 'detaching'
    if (timer !== undefined) cancel(timer)
    timer = undefined
    // Clear the transform FIRST and synchronously: a terminated worker must
    // never sit in a live sender's frame path.
    let clearError: string | null = null
    try {
      ;(sender as { transform: unknown }).transform = null
    } catch (error) {
      clearError = messageOf(error)
    }
    detaching = (async () => {
      // One bounded final drain, so the last frames before detach are kept.
      await new Promise<void>((resolve) => {
        const deadline = schedule(resolve, FINAL_DRAIN_TIMEOUT_MS)
        const settle = (): void => {
          cancel(deadline)
          resolve()
        }
        if (pending) pending.resolve = settle
        else if (!drain(settle)) settle()
      })
      state = 'detached'
      pending = null
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      emit({
        phase: 'encode-observer',
        api: ENCODE_OBSERVER_API,
        status: 'detached',
        transformStarted,
        clearError,
        ...counters
      })
    })()
    return detaching
  }
  return { status: 'observing', detach }
}
