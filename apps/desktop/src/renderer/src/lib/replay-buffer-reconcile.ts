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
      // A ring that died with its session ('error') disarms the switch; once
      // something arms it again (below), it starts like a ring that is off.
      (input.replayState === 'off' || input.replayState === 'error') &&
      // A failed session is over too (a ring that died ends 'failed').
      (input.recordingState === 'idle' || input.recordingState === 'failed') &&
      !input.startPending &&
      !input.stopPending &&
      !input.replayStartInFlight
    ) {
      return input.failedStarts >= REPLAY_START_RETRY_LIMIT ? 'give-up' : 'start'
    }
    // On, starting, riding a recording, or waiting on a session: nothing to do.
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

/** After the ring died with its session, the event handler disarms it so a
 * failing session is not retried in a loop. The switch stays on, and the
 * user's next move arms it again: a recording or livestream that ends, a
 * source change, or the switch itself. Never past a refusal (the software
 * encoder guard), which keeps its own reason on the Output page. */
export function replayShouldRearmAfterError(input: {
  armed: boolean
  replayState: ReplayBufferState
  switchOn: boolean
  blocked: boolean
}): boolean {
  return !input.armed && input.replayState === 'error' && input.switchOn && !input.blocked
}
