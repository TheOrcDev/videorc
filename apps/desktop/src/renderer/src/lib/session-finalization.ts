// Pure helpers for the Library's background-finalization state (instant-record
// P2). After Stop the backend publishes `idle` as soon as the MKV closes; the
// MP4 export continues as a background job reported through
// `recording.finalization` events and the `finalizationState` row field.

import type { RecordingFinalizationEvent, RecordingFinalizationState } from './backend'

export type FinalizationRow = {
  status: string
  mp4Path?: string
  outputPath?: string
  finalizationState?: RecordingFinalizationState
  finalizationProgressPercent?: number
  finalizationError?: string
}

export function isFinalizingSession(session: FinalizationRow): boolean {
  return session.finalizationState === 'finalizing'
}

export function finalizationFailed(session: FinalizationRow): boolean {
  return session.finalizationState === 'failed'
}

/** Badge copy for a row whose MP4 is still being produced. */
export function finalizingBadgeLabel(session: FinalizationRow): string {
  const percent = session.finalizationProgressPercent
  return typeof percent === 'number' && percent > 0 && percent < 100
    ? `Saving MP4 · ${Math.round(percent)}%`
    : 'Saving MP4…'
}

/**
 * Applies a `recording.finalization` event to the Library row it belongs to.
 * Returns the same array when nothing changed so React skips the re-render.
 */
export function applyFinalizationEvent<T extends FinalizationRow & { id: string }>(
  sessions: T[],
  event: RecordingFinalizationEvent
): T[] {
  let changed = false
  const next = sessions.map((session) => {
    if (session.id !== event.sessionId) return session
    changed = true
    const patched: T = {
      ...session,
      finalizationState: event.state,
      ...(event.progressPercent !== undefined
        ? { finalizationProgressPercent: event.progressPercent }
        : event.state !== 'finalizing'
          ? { finalizationProgressPercent: undefined }
          : {}),
      ...(event.mp4Path ? { mp4Path: event.mp4Path } : {}),
      ...(event.outputPath ? { outputPath: event.outputPath } : {}),
      ...(event.error !== undefined ? { finalizationError: event.error } : {})
    }
    const durationMs = event.durationMs
    const fileSizeBytes = event.fileSizeBytes
    const withMedia = patched as T & { durationMs?: number; fileSizeBytes?: number }
    if (typeof durationMs === 'number') withMedia.durationMs = durationMs
    if (typeof fileSizeBytes === 'number') withMedia.fileSizeBytes = fileSizeBytes
    return withMedia
  })
  return changed ? next : sessions
}

/** Whether the row is missing from a loaded page (a refresh is needed). */
export function finalizationEventNeedsRefresh<T extends { id: string }>(
  sessions: T[],
  event: RecordingFinalizationEvent
): boolean {
  return event.state === 'finalized' && !sessions.some((session) => session.id === event.sessionId)
}
