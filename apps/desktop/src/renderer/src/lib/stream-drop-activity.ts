import type { DiagnosticStats, StreamHealth } from '@/lib/backend'

// The Studio provider folds every diagnostics sample into this window, so it
// lives apart from the classifier in `stream-health-attribution`: only lazy
// surfaces read the classifier, and keeping the two in one module made the
// eager entry carry it.

/**
 * How long a drop keeps naming its stage after the last one (#981). The
 * diagnostics' drop counters are session totals, so the classifier reads
 * their growth, not their size: one frame dropped while a destination
 * reconnected must not read as "Encoder dropping frames" for the rest of the
 * stream. The Studio commits diagnostics about once a second, so ten seconds
 * is several samples: long enough to read, short enough to be current.
 */
export const RECENT_DROP_WINDOW_MS = 10_000

/** The stages whose drop counters the window watches. */
export type DropStage = 'audio' | 'capture' | 'encoder' | 'preview'

const DROP_STAGES: readonly DropStage[] = ['audio', 'capture', 'encoder', 'preview']

/** Whether each stage dropped something within the window. */
export type RecentStreamDrops = Readonly<Record<DropStage, boolean>>

export const NO_RECENT_DROPS: RecentStreamDrops = {
  audio: false,
  capture: false,
  encoder: false,
  preview: false
}

/**
 * What the window remembers between samples: the last value of every counter
 * and when each stage's counters last grew. Pure data, advanced per sample.
 */
export interface StreamDropActivity {
  sessionId: string | undefined
  /** The last seen value of each stage's counters, in `dropCounters` order. */
  totals: Readonly<Record<DropStage, readonly (number | undefined)[]>>
  /** When a stage's counters last grew, in ms since the epoch. */
  lastIncreaseAt: Readonly<Partial<Record<DropStage, number>>>
}

export function emptyStreamDropActivity(): StreamDropActivity {
  return {
    sessionId: undefined,
    totals: { audio: [], capture: [], encoder: [], preview: [] },
    lastIncreaseAt: {}
  }
}

/**
 * Folds one diagnostics sample into the window. A counter that grows marks
 * its stage as dropping now; one that first appears, or shrinks (a new run
 * reset it), only sets the new baseline. A new session starts over, so the
 * old session's totals never count against the new one.
 */
export function advanceStreamDropActivity(
  activity: StreamDropActivity,
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null,
  nowMs: number
): StreamDropActivity {
  const currentHealth = healthForDiagnosticSession(diagnosticStats, streamHealth)
  const sameSession = activity.sessionId === diagnosticStats.sessionId
  const totals = {} as Record<DropStage, readonly (number | undefined)[]>
  const lastIncreaseAt: Partial<Record<DropStage, number>> = sameSession
    ? { ...activity.lastIncreaseAt }
    : {}
  for (const stage of DROP_STAGES) {
    const counters = dropCounters(stage, diagnosticStats, currentHealth)
    const previous = sameSession ? activity.totals[stage] : []
    const grew = counters.some((count, index) => {
      const before = previous[index]
      return finite(before) && finite(count) && count > before
    })
    if (grew) {
      lastIncreaseAt[stage] = nowMs
    }
    totals[stage] = counters
  }
  return { sessionId: diagnosticStats.sessionId, totals, lastIncreaseAt }
}

/** Which stages dropped within the window as of `nowMs`. */
export function recentStreamDrops(activity: StreamDropActivity, nowMs: number): RecentStreamDrops {
  const recent = {} as Record<DropStage, boolean>
  for (const stage of DROP_STAGES) {
    const at = activity.lastIncreaseAt[stage]
    recent[stage] = at !== undefined && nowMs - at <= RECENT_DROP_WINDOW_MS
  }
  return recent
}

/** Every counter whose growth means the stage is dropping, per stage. */
function dropCounters(
  stage: DropStage,
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null
): readonly (number | undefined)[] {
  switch (stage) {
    case 'audio':
      return [diagnosticStats.micDroppedFrames]
    case 'capture':
      return [
        diagnosticStats.previewCameraDroppedFrames,
        diagnosticStats.previewScreenDroppedFrames
      ]
    case 'encoder':
      return [
        diagnosticStats.droppedFrames,
        streamHealth?.droppedFrames,
        diagnosticStats.encoderBridgeDroppedFrames,
        diagnosticStats.encoderBridgeOutputQueueDroppedFrames,
        diagnosticStats.encoderBridgeStreamQueueDroppedFrames,
        diagnosticStats.encoderBridgeEncodedOutputErrors,
        diagnosticStats.streamDuplicatedFrames,
        streamHealth?.duplicatedFrames
      ]
    case 'preview':
      return [diagnosticStats.previewDroppedFrames]
  }
}

/** The stream health of the diagnostics' own session, or none. */
export function healthForDiagnosticSession(
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null
): StreamHealth | null {
  if (
    streamHealth &&
    diagnosticStats.sessionId &&
    diagnosticStats.sessionId !== streamHealth.sessionId
  ) {
    return null
  }
  return streamHealth
}

export function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
