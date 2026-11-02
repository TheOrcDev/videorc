// Pure derivations for the Studio dashboard's Session panel (SD1). Kept free of
// React/component imports so they run under the node-only vitest runner. The
// status strings/tones are shared by the Session rows and the Preview badge.

import type { DiagnosticStats, RecordingStatus } from './backend'
import { sessionIsLive } from '../../../shared/capture-state'
import { formatTimecode } from '../../../shared/timecode'
import { RECORDING_STOPS_TOO } from './session-stop'
import { statusWordFromValue } from './status-word'

export { sessionIsLive }

export type SessionTarget = { enabled: boolean; label: string; platform: string }
export type SessionStatusTone = 'good' | 'warn' | 'error' | 'live' | 'neutral'
/** The slice of `recording.status` the session chrome reads. */
export type SessionStatusView = {
  state: string
  streamUrl?: string | null
  /** Plan 181: a buffer-only session reads idle here and keeps the transport. */
  replayOnly?: boolean
}

/** "Local recording" / "Streaming only" / "Recording + streaming" / "No output". */
export function sessionMode(recordEnabled: boolean, streamEnabled: boolean): string {
  if (recordEnabled && streamEnabled) {
    return 'Recording + streaming'
  }
  if (streamEnabled) {
    return 'Streaming only'
  }
  if (recordEnabled) {
    return 'Local recording'
  }
  return 'No output'
}

/**
 * The Session row's Livestream fact: the single destination's name or a
 * count, whatever the last mode was (plan 174 S3.1, B-3). Go Live is an
 * explicit start, so there is no "Disabled" mode to report any more; what a
 * streamer needs to know is what is set up.
 */
export function streamingSummary(targets: readonly SessionTarget[]): string {
  const enabled = targets.filter((target) => target.enabled)
  if (enabled.length === 0) {
    return 'No destinations'
  }
  if (enabled.length === 1) {
    return enabled[0].label || enabled[0].platform
  }
  return `${enabled.length} destinations`
}

/**
 * True while a session owns the transport — the Stop/Force-stop control must
 * stay reachable through EVERY in-flight state (F-020: excluding starting/
 * stopping flipped the transport back to idle Record/Go Live mid-session).
 */
export function isSessionTransportActive(state: string, replayOnly = false): boolean {
  // Plan 181: a buffer-only session leaves Record and Go Live in place; the
  // backend hands over to the real session on the next start.
  if (replayOnly) return false
  return (
    state === 'recording' || state === 'streaming' || state === 'starting' || state === 'stopping'
  )
}

/** A live session that also writes a local file: Go Live records by default. */
export function sessionAlsoRecords(status: SessionStatusView): boolean {
  return status.state === 'recording' && sessionIsLive(status)
}

/** The backend's health code when a stop overran its finalize window (recording.rs). */
export const RECORDING_STOP_FINALIZE_OVERRUN_CODE = 'recording-stop-finalize-overrun'

/**
 * The warning under Force stop once a stop overran its finalize window
 * (plan 174 S3.1, B-16): what is happening, and what Force stop does, in
 * the streamer's words rather than the backend's.
 */
export const STOP_FINALIZE_OVERRUN_ALERT = Object.freeze({
  title: 'Stopping is taking longer than expected',
  description:
    "A destination isn't responding, so Videorc is finishing the stop in the background. Force stop ends it now; the last seconds may be lost."
})

/**
 * Milliseconds since the session started, from `recording.startedAt` (plan
 * 095 S5). The backend sends `durationMs` only in the terminal status, so a
 * running clock counts from the start. Missing or unparsable input is
 * `undefined`; a start in the future (clock skew) reads 0.
 */
export function sessionElapsedMs(
  startedAt: string | null | undefined,
  nowMs: number
): number | undefined {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) {
    return undefined
  }
  return Math.max(0, nowMs - startedMs)
}

/**
 * The inspector's session clock (plan 050 S12): the one timecode, m:ss under
 * an hour and h:mm:ss after (plan 174 S1.4). Fed by `sessionElapsedMs` while
 * a session runs. Missing reads 0:00.
 */
export function sessionClockLabel(durationMs?: number): string {
  return formatTimecode(typeof durationMs === 'number' ? durationMs : 0)
}

/**
 * The Stop button. A live session ends the livestream, with a visible line
 * when that also stops a recording (Go Live is record+stream by default;
 * plan 174 D19). A Go Live still starting is cancelled, not "stopped": the
 * backend reports it as `recording` until the stream is up, so the session's
 * `streamEnabled` tells the two apart (B-16).
 */
export function sessionStopControl(
  status: SessionStatusView,
  stopRequestPending: boolean,
  streamEnabled = false
): { label: string; note?: string } {
  if (stopRequestPending) {
    return { label: 'Stopping…' }
  }
  if (status.state === 'stopping') {
    return { label: 'Force stop' }
  }
  if (sessionIsLive(status)) {
    return sessionAlsoRecords(status)
      ? { label: 'End livestream', note: RECORDING_STOPS_TOO }
      : { label: 'End livestream' }
  }
  if (status.state === 'starting' && streamEnabled) {
    return { label: 'Cancel livestream' }
  }
  return { label: 'Stop recording' }
}

/**
 * One state machine, one word per state (plan 174 S1.3, D4), for every
 * surface that shows the session: the Studio pill, the status bar, the
 * account menu's Health row and the Library's live row.
 */
type SessionStatusKind =
  | 'connecting'
  | 'reconnecting'
  | 'ready'
  | 'not-ready'
  | 'starting'
  | 'recording'
  | 'on-air'
  | 'stopping'
  | 'failed'

const SESSION_STATUS_WORDS: Record<SessionStatusKind, { label: string; tone: SessionStatusTone }> =
  {
    // Boot-time connecting is calm, not alarming.
    connecting: { label: 'Connecting…', tone: 'neutral' },
    // A dropped socket after a backend exit: main restarts it and the
    // renderer reconnects, so this is attention, not a failure.
    reconnecting: { label: 'Videorc is reconnecting…', tone: 'warn' },
    ready: { label: 'Ready', tone: 'good' },
    'not-ready': { label: 'Not ready', tone: 'neutral' },
    starting: { label: 'Starting…', tone: 'neutral' },
    recording: { label: 'Recording', tone: 'live' },
    'on-air': { label: 'On air', tone: 'live' },
    stopping: { label: 'Stopping…', tone: 'neutral' },
    failed: { label: 'Failed', tone: 'error' }
  }

export interface SessionStatusOptions {
  /**
   * Nothing can start right now, and the Session section says why: idle
   * reads a neutral "Not ready", never a green "Ready" (B-17).
   */
  startBlocked?: boolean
}

function sessionStatusKind(
  status: SessionStatusView,
  wsStatus: string | undefined,
  options: SessionStatusOptions = {}
): SessionStatusKind | null {
  // F-014: never report Ready over a dead backend socket — the app used to
  // zombie with a green Ready badge after a backend crash. Boot-time
  // waiting/connecting reads as "Connecting…", real drops as reconnecting.
  if (wsStatus === 'waiting' || wsStatus === 'connecting') return 'connecting'
  if (wsStatus && wsStatus !== 'connected') return 'reconnecting'
  // Plan 181: the replay buffer is never "Recording"; its own chip says what
  // it holds, and the session words stay at Ready.
  if (status.replayOnly) return options.startBlocked ? 'not-ready' : 'ready'
  // An on-air session reads "On air" whether or not it also records: the
  // backend calls record+stream `recording` (plan 095 S5).
  if (sessionIsLive(status)) return 'on-air'
  switch (status.state) {
    case 'idle':
      return options.startBlocked ? 'not-ready' : 'ready'
    case 'starting':
      return 'starting'
    case 'recording':
      return 'recording'
    case 'stopping':
      return 'stopping'
    case 'failed':
      return 'failed'
    default:
      return null
  }
}

/**
 * Idle reads as "Ready" ("Not ready" when nothing can start); transitions
 * get an ellipsis; "On air" only for on air (D4). A state no map names yet
 * reads as a sentence-case word, never the raw value.
 */
export function sessionStatusLabel(
  status: SessionStatusView,
  wsStatus?: string,
  options?: SessionStatusOptions
): string {
  const kind = sessionStatusKind(status, wsStatus, options)
  return kind ? SESSION_STATUS_WORDS[kind].label : statusWordFromValue(status.state)
}

/**
 * Record and on air share the live tone, a failure is `error`, a dropped
 * socket needs attention, and every transition is neutral.
 */
export function sessionStatusTone(
  status: SessionStatusView,
  wsStatus?: string,
  options?: SessionStatusOptions
): SessionStatusTone {
  const kind = sessionStatusKind(status, wsStatus, options)
  return kind ? SESSION_STATUS_WORDS[kind].tone : 'neutral'
}

/** The status dot pulses only while a file is being written or on air (A-4). */
export function sessionStatusPulses(status: SessionStatusView, wsStatus?: string): boolean {
  const kind = sessionStatusKind(status, wsStatus)
  return kind === 'recording' || kind === 'on-air'
}

/**
 * The Studio pill's leading icon (B-17), so recording, on air and trouble
 * no longer read as the same red chip. Null keeps the tone dot.
 */
export type SessionStatusGlyph = 'record' | 'live' | 'alert'

export function sessionStatusGlyph(
  status: SessionStatusView,
  wsStatus?: string
): SessionStatusGlyph | null {
  switch (sessionStatusKind(status, wsStatus)) {
    case 'recording':
      return 'record'
    case 'on-air':
      return 'live'
    case 'reconnecting':
    case 'failed':
      return 'alert'
    default:
      return null
  }
}

export function cameraCaptureNotice(
  recording: Pick<RecordingStatus, 'state' | 'sessionId' | 'message' | 'replayOnly'>,
  stats: Pick<DiagnosticStats, 'sessionId' | 'duplicateCaptureSources'>
): string | undefined {
  if (
    !recording.sessionId ||
    recording.sessionId !== stats.sessionId ||
    !['recording', 'streaming'].includes(recording.state)
  )
    return undefined
  if (!stats.duplicateCaptureSources.some((source) => source.startsWith('camera:')))
    return undefined
  if (recording.replayOnly)
    return 'Preview and Clips both have the camera open. Another app may not be able to use it.'
  if (recording.state === 'streaming')
    return 'Preview and your livestream both have the camera open. Another app may not be able to use it.'
  return recording.message
}
