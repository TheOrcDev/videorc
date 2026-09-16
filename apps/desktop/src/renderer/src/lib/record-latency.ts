// Pure record start/stop latency tracking for the renderer (instant-record
// plan, Phase 0). No React, no DOM: time is injected so vitest can drive it.
//
// A "click" is armed when the user (or a remote intent / shortcut) asks to
// start or stop. The next authoritative `recording.status` that completes the
// transition closes the sample. `starting` / `stopping` fill the intermediate
// fields when they arrive first.

export type RecordLatencyKind = 'start' | 'stop'
export type RecordLatencyOrigin = 'click' | 'session-call'

export type RecordLatencyStatusLike = {
  state: 'idle' | 'starting' | 'recording' | 'streaming' | 'stopping' | 'failed'
  sessionId?: string
}

export type RecordStartLatencySample = {
  kind: 'start'
  origin: RecordLatencyOrigin
  clickToStartingMs?: number
  clickToRecordingMs: number
  sessionId?: string
}

export type RecordStopLatencySample = {
  kind: 'stop'
  origin: RecordLatencyOrigin
  clickToStoppingMs?: number
  clickToIdleMs: number
  sessionId?: string
}

export type RecordLatencySample = RecordStartLatencySample | RecordStopLatencySample

export type RecordLatencyTimelineMark = { phase: string; atMs: number }
export type RecordLatencyTimelineSnapshot = {
  kind: string
  totalMs: number
  outcome: string
  cold?: boolean
  clickToOriginMs?: number
  marks?: RecordLatencyTimelineMark[]
}

/** A pending click older than this is stale (the request was refused or lost). */
export const RECORD_LATENCY_CLICK_TTL_MS = 15_000

type PendingClick = { at: number; origin: RecordLatencyOrigin; intermediateAt?: number }

export type RecordLatencyTracker = {
  /** Arms a click. A second click of the same kind while one is pending is ignored. */
  markClick(kind: RecordLatencyKind, nowMs: number, origin?: RecordLatencyOrigin): void
  /** Observes an authoritative status; returns a completed sample or null. */
  observe(status: RecordLatencyStatusLike, nowMs: number): RecordLatencySample | null
  /** True while a click of the given kind is armed. */
  hasPending(kind: RecordLatencyKind): boolean
}

export function createRecordLatencyTracker(): RecordLatencyTracker {
  const pending: { start: PendingClick | null; stop: PendingClick | null } = {
    start: null,
    stop: null
  }

  const fresh = (click: PendingClick | null, nowMs: number): PendingClick | null =>
    click && nowMs - click.at <= RECORD_LATENCY_CLICK_TTL_MS ? click : null

  return {
    markClick(kind, nowMs, origin = 'click') {
      const current = fresh(pending[kind], nowMs)
      if (current && current.origin === 'click') return
      // A session-call mark upgrades to the earlier real click when one exists.
      pending[kind] = current ?? { at: nowMs, origin }
    },
    hasPending(kind) {
      return pending[kind] !== null
    },
    observe(status, nowMs) {
      const start = fresh(pending.start, nowMs)
      const stop = fresh(pending.stop, nowMs)
      if (!start) pending.start = null
      if (!stop) pending.stop = null

      switch (status.state) {
        case 'starting':
          if (start && start.intermediateAt === undefined) start.intermediateAt = nowMs
          return null
        case 'recording':
        case 'streaming': {
          if (!start) return null
          pending.start = null
          return {
            kind: 'start',
            origin: start.origin,
            ...(start.intermediateAt !== undefined
              ? { clickToStartingMs: Math.round(start.intermediateAt - start.at) }
              : {}),
            clickToRecordingMs: Math.round(nowMs - start.at),
            ...(status.sessionId ? { sessionId: status.sessionId } : {})
          }
        }
        case 'stopping':
          if (stop && stop.intermediateAt === undefined) stop.intermediateAt = nowMs
          return null
        case 'idle':
        case 'failed': {
          // A failed start clears the pending start without a sample.
          if (start && !stop) {
            pending.start = null
            return null
          }
          if (!stop) return null
          pending.stop = null
          pending.start = null
          return {
            kind: 'stop',
            origin: stop.origin,
            ...(stop.intermediateAt !== undefined
              ? { clickToStoppingMs: Math.round(stop.intermediateAt - stop.at) }
              : {}),
            clickToIdleMs: Math.round(nowMs - stop.at),
            ...(status.sessionId ? { sessionId: status.sessionId } : {})
          }
        }
        default:
          return null
      }
    }
  }
}

/**
 * Converts a `performance.now()` click mark into an epoch-ms timestamp the
 * backend can compare against its own clock (same machine).
 */
export function clickEpochMs(clickPerfMs: number, perfNowMs: number, dateNowMs: number): number {
  return Math.round(dateNowMs - (perfNowMs - clickPerfMs))
}

export function formatRecordLatencyLog(sample: RecordLatencySample): string {
  const session = sample.sessionId ? ` (session ${sample.sessionId})` : ''
  if (sample.kind === 'start') {
    const starting =
      sample.clickToStartingMs !== undefined
        ? `click→starting ${sample.clickToStartingMs} ms · `
        : ''
    return `[record-latency] start ${starting}click→recording ${sample.clickToRecordingMs} ms${session}`
  }
  const stopping =
    sample.clickToStoppingMs !== undefined ? `click→stopping ${sample.clickToStoppingMs} ms · ` : ''
  return `[record-latency] stop ${stopping}click→idle ${sample.clickToIdleMs} ms${session}`
}

/** The phase that consumed the most time in a backend timeline snapshot. */
export function slowestTimelinePhase(
  snapshot: RecordLatencyTimelineSnapshot | undefined | null
): { phase: string; deltaMs: number } | null {
  const marks = snapshot?.marks
  if (!marks || marks.length === 0) return null
  let previous = 0
  let slowest: { phase: string; deltaMs: number } | null = null
  for (const mark of marks) {
    const deltaMs = Math.max(0, mark.atMs - previous)
    previous = mark.atMs
    if (!slowest || deltaMs > slowest.deltaMs) slowest = { phase: mark.phase, deltaMs }
  }
  return slowest
}

export function formatLatencyMs(value: number | undefined | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '--'
}

export function formatTimelineSummary(
  snapshot: RecordLatencyTimelineSnapshot | undefined | null
): string {
  if (!snapshot) return '--'
  const cold = snapshot.cold === true ? ' · cold' : snapshot.cold === false ? ' · warm' : ''
  const origin =
    snapshot.clickToOriginMs !== undefined ? ` · ${snapshot.clickToOriginMs} ms click→backend` : ''
  return `${formatLatencyMs(snapshot.totalMs)} · ${snapshot.outcome}${cold}${origin}`
}
