/**
 * Session-start failures must be unmissable (live feedback batch 3, B0).
 *
 * Before this, a refused Record / Go Live surfaced as ONE default 4-second
 * toast while the user was looking at the stream, and the Record control just
 * went back to idle. Now every start rejection — the compositor startup
 * barrier, a Go Live preflight, platform setup, the start RPC itself — lands
 * in one keyed, persistent toast with a Retry action, and in a Studio-context
 * failure state the Session panel renders next to the Record button until the
 * user starts again or dismisses it.
 */

import type { RecordingStatus } from './backend'

/** Sonner key for the start-failure toast: re-reporting updates it in place. */
export const SESSION_START_FAILED_TOAST_ID = 'session-start-failed'
/** Shared shape: sonner merges an update over the existing toast by id, so the
 * health-event toast and the RPC-rejection toast must use the same shape
 * (title + description) or the older description lingers under a new title.
 * The health event can't tell a recording from a livestream, so its title is
 * the neutral one; the rejection that follows names which (plan 174 S2.4). */
export const SESSION_START_FAILED_TOAST_TITLE = "Couldn't start"

/** Which start failed: Record, Go Live, or the cloud Resume (plan 184 C5b). */
export type SessionStartFailureKind = 'record' | 'live' | 'resume'

/** "Couldn't start recording", "Couldn't go live" or "Couldn't resume the stream". */
export function sessionStartFailedTitle(kind: SessionStartFailureKind): string {
  switch (kind) {
    case 'record':
      return "Couldn't start recording"
    case 'live':
      return "Couldn't go live"
    case 'resume':
      return "Couldn't resume the stream"
  }
}

export interface SessionStartFailure {
  /** Backend / preflight reason, verbatim — it already reads as a sentence. */
  message: string
  /** `Date.now()` at the failure, so a repeat of the same message still re-renders. */
  at: number
}

export type SessionStartFailureAction =
  | { type: 'failed'; message: string; at: number }
  /** A new start attempt began (Record, Stream, Retry): the old reason is stale. */
  | { type: 'start-attempted' }
  /** The user dismissed the line or the toast. */
  | { type: 'dismissed' }

export interface SessionStartResponseResolution {
  status: RecordingStatus
  supersededByAuthoritativeEvent: boolean
  sessionActive: boolean
}

/**
 * A stopping/terminal push can overtake the response to `session.start`. Keep
 * that exact-session push authoritative so the older active response cannot
 * make Studio (or provider activation) believe the ending session is live.
 */
export function reconcileSessionStartResponse(
  response: RecordingStatus,
  authoritativeStatusDuringRequest?: RecordingStatus | null
): SessionStartResponseResolution {
  const responseIsActive = response.state === 'recording' || response.state === 'streaming'
  const authoritativeStatusMatchesResponse = Boolean(
    responseIsActive &&
    response.sessionId &&
    authoritativeStatusDuringRequest?.sessionId === response.sessionId &&
    ['stopping', 'idle', 'failed'].includes(authoritativeStatusDuringRequest.state)
  )
  const status = authoritativeStatusMatchesResponse ? authoritativeStatusDuringRequest! : response

  return {
    status,
    supersededByAuthoritativeEvent: authoritativeStatusMatchesResponse,
    sessionActive: status.state === 'recording' || status.state === 'streaming'
  }
}

export function sessionStartFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || "The session couldn't start."
}

export function reduceSessionStartFailure(
  current: SessionStartFailure | null,
  action: SessionStartFailureAction
): SessionStartFailure | null {
  switch (action.type) {
    case 'failed':
      return { message: action.message, at: action.at }
    case 'start-attempted':
    case 'dismissed':
      return null
  }
}

export interface SessionStartFailureToastOptions {
  id: string
  description: string
  duration: number
  action: { label: string; onClick: () => void }
  onDismiss: () => void
}

/**
 * Persistent (`duration: Infinity`) and keyed so repeated failures never stack;
 * Retry re-runs the exact start that failed. Dismissing the toast also clears
 * the Session-panel line so the two surfaces never disagree. Render with
 * `toast.error(sessionStartFailedTitle(goLive), options)`.
 */
export function sessionStartFailureToastOptions(
  message: string,
  retry: () => void,
  dismiss: () => void
): SessionStartFailureToastOptions {
  return {
    id: SESSION_START_FAILED_TOAST_ID,
    description: message,
    duration: Infinity,
    action: { label: 'Retry', onClick: retry },
    onDismiss: dismiss
  }
}
