// Pure helpers for the Library's background-finalization state (instant-record
// P2). After Stop the backend publishes `idle` as soon as the MKV closes; the
// MP4 export continues as a background job reported through
// `recording.finalization` events and the `finalizationState` row field.

import type {
  InterruptionRecovery,
  SessionLogEntry,
  RecordingFinalizationEvent,
  RecordingFinalizationState
} from './backend'

export type FinalizationRow = {
  status: string
  mp4Path?: string
  outputPath?: string
  finalizationState?: RecordingFinalizationState
  finalizationProgressPercent?: number
  finalizationError?: string
  interruptionRecovery?: InterruptionRecovery
}

export function isFinalizingSession(session: FinalizationRow): boolean {
  return session.finalizationState === 'finalizing'
}

export function finalizationFailed(session: FinalizationRow): boolean {
  return session.finalizationState === 'failed'
}

/** Badge copy for a take Videorc recovered after it stopped mid-recording;
 * `null` on every other row. */
export function interruptedTakeBadge(
  session: FinalizationRow
): { label: string; detail: string } | null {
  if (session.interruptionRecovery !== 'recovered') return null
  return {
    label: 'Recovered',
    detail:
      'Videorc stopped during this recording. Everything up to that moment was saved as MP4; the original MKV is kept.'
  }
}

/** The log the backend writes when Record was refused and the row it had
 * just created was marked failed (`SessionStartRowGuard`, F-017). */
export const SESSION_START_FAILED_LOG_CODE = 'session-start-failed'

const START_FAILED_REASON_PREFIXES = ['the session was marked failed:', 'reason=']

type StartFailedRow = FinalizationRow & {
  fileSizeBytes?: number
  sessionLogCount?: number
}

/** A failed row with no file and some logs: its logs say whether Record was
 * refused before anything was written. */
export function mayBeStartFailed(session: StartFailedRow): boolean {
  return (
    session.status === 'failed' &&
    !session.mp4Path &&
    session.fileSizeBytes == null &&
    (session.sessionLogCount ?? 0) > 0
  )
}

/** Badge copy for a Record press the backend refused: the row exists, its
 * file never did. `null` on every other row, and while its logs are unknown. */
export function startFailedBadge(
  session: StartFailedRow,
  sessionLogs: readonly SessionLogEntry[] | undefined
): { label: string; detail: string } | null {
  if (!mayBeStartFailed(session) || !sessionLogs) return null
  const logs = sessionLogs.filter((entry) => entry.code === SESSION_START_FAILED_LOG_CODE)
  if (logs.length === 0) return null
  const reason = logs.map((entry) => startFailedReason(entry.message)).find(Boolean)
  const detail = 'This recording stopped before it started, so there is no file.'
  return { label: "Didn't start", detail: reason ? `${detail} ${reason}` : detail }
}

function startFailedReason(message: string): string | null {
  for (const prefix of START_FAILED_REASON_PREFIXES) {
    const at = message.indexOf(prefix)
    if (at < 0) continue
    const reason = message.slice(at + prefix.length).trim()
    return reason ? reason : null
  }
  return null
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
      ...(event.interruptionRecovery ? { interruptionRecovery: event.interruptionRecovery } : {}),
      finalizationError: event.error
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

/** Replays only events received after a list request began. A late snapshot
 * must never turn a finished MP4 back into an MKV or undo a retry. */
export class FinalizationSnapshotJournal {
  private sequence = 0
  private events = new Map<string, { sequence: number; event: RecordingFinalizationEvent }>()

  checkpoint(): number {
    return this.sequence
  }

  record(event: RecordingFinalizationEvent): void {
    this.events.delete(event.sessionId)
    this.events.set(event.sessionId, { sequence: ++this.sequence, event })
  }

  reconcile<T extends FinalizationRow & { id: string }>(rows: T[], since: number): T[] {
    let result = rows
    for (const entry of this.events.values()) {
      if (entry.sequence > since) result = applyFinalizationEvent(result, entry.event)
    }
    return result
  }
}
