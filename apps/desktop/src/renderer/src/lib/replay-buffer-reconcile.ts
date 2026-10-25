import type { ReplayBufferState } from '../../../shared/backend'

// Plan 181 S4: the one decision behind the replay buffer's switch. The
// backend owns the ring; the renderer owns the intent ("armed") and keeps
// the two in step after every recording.status and replay.state event.
// Pure, so the ordering is tested without a client: start the buffer-only
// session when the switch is on and nothing runs, stop it when the switch
// goes off, and give up after repeated failed starts. Kept out of
// lib/replay-buffer (lazy) because the Studio provider needs it eagerly.

/** Failed buffer starts in a row before the switch turns itself off. */
export const REPLAY_START_RETRY_LIMIT = 3

/** The backoff before the next start attempt, by failures so far. */
export function replayStartRetryDelayMs(failedStarts: number): number {
  return Math.min(500 * 2 ** Math.max(0, failedStarts - 1), 4000)
}

export type ReplayReconcileInput = {
  /** The switch in the Studio: what the user wants. */
  armed: boolean
  replayState: ReplayBufferState
  /** The backend's ring belongs to a buffer-only session. */
  replayOnlyBuffer: boolean
  recordingState: string
  recordingReplayOnly: boolean
  /** A Record or Go Live is in flight: the backend hands over itself. */
  startPending: boolean
  stopPending: boolean
  /** The renderer's own buffer-only start has not answered yet. */
  replayStartInFlight: boolean
  failedStarts: number
}

export type ReplayReconcileAction = 'start' | 'stop' | 'give-up' | null

const ACTIVE = new Set(['starting', 'recording', 'streaming', 'stopping'])

export function replayBufferReconcileAction(input: ReplayReconcileInput): ReplayReconcileAction {
  if (input.armed) {
    if (
      input.replayState === 'off' &&
      input.recordingState === 'idle' &&
      !input.startPending &&
      !input.stopPending &&
      !input.replayStartInFlight
    ) {
      return input.failedStarts >= REPLAY_START_RETRY_LIMIT ? 'give-up' : 'start'
    }
    // On, starting, riding a recording, or waiting on a session: nothing to do.
    // An error is the event handler's: it turns the switch off and says why.
    return null
  }
  if (
    (input.replayState === 'on' || input.replayState === 'starting') &&
    input.replayOnlyBuffer &&
    input.recordingReplayOnly &&
    ACTIVE.has(input.recordingState) &&
    !input.startPending &&
    !input.stopPending &&
    !input.replayStartInFlight
  ) {
    return 'stop'
  }
  // A ring riding a recording ends with that recording; the switch only
  // decides whether it comes back afterwards.
  return null
}

/** A source change while only the buffer-only session runs is an idle
 * change: stop the ring so reconcile re-arms it with the new sources. */
export function replayBufferShouldRestartForSources(input: {
  recordingReplayOnly: boolean
  recordingState: string
}): boolean {
  return input.recordingReplayOnly && ACTIVE.has(input.recordingState)
}
