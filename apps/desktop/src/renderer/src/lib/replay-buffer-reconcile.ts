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

/**
 * Refusals of a camera that says live and has sent no frame before the ring
 * stops asking and waits for the camera's first frame (2026-11-23: a blocked
 * or dead camera retried about every half second, forever).
 */
export const REPLAY_SILENT_CAMERA_RETRY_LIMIT = 5

/** The wait before asking again after the nth silent-camera refusal: 1, 2, 4,
 * 8 s, so the last refusal lands about 15 s after the first, longer than a
 * camera that streams takes to its first frame. */
export function replaySilentCameraRetryDelayMs(refusals: number): number {
  return Math.min(1000 * 2 ** Math.max(0, refusals - 1), 8000)
}

/** The bell's detail when the ring stops asking a camera that sends nothing. */
export const REPLAY_CAMERA_SENDS_NO_PICTURE =
  'The camera is on but sends no picture. Clips start by themselves once it does.'

/** The camera as the renderer last heard it (`preview.camera.status`). */
export type ReplayCameraReport = {
  state: string
  cameraId?: string | null
  framesCaptured?: number
  /** The backend's verdict: live past its first-frame grace with no frame. */
  noVideo?: boolean
}

/** True once the camera sends a picture: what a silent-camera wait ends on. */
export function replayCameraDelivers(camera: ReplayCameraReport): boolean {
  return camera.state === 'live' && (camera.framesCaptured ?? 0) > 0 && camera.noVideo !== true
}

export type ReplaySourcesNotReadyNext =
  /** Ask again after `delayMs`; the refusal is counted. */
  | { kind: 'retry'; delayMs: number }
  /** The camera is starting or being switched: its live edge starts the ring. */
  | { kind: 'wait-for-live' }
  /** The camera says live and sends nothing: stop asking; its first frame
   * starts the ring. The Studio says so once (the bell, never a toast). */
  | { kind: 'wait-for-frames' }
  /** The camera failed, is missing or was denied: a failed start like any other. */
  | { kind: 'failed' }

/**
 * What the ring does after the backend refused its start as
 * `replay-sources-not-ready` (the scene's camera has no frame). `refusals` is
 * the silent-camera refusals so far, this one included.
 */
export function replayAfterSourcesNotReady(input: {
  camera: ReplayCameraReport
  /** The camera the scene shows. */
  chosenCameraId: string | null | undefined
  refusals: number
}): ReplaySourcesNotReadyNext {
  const { camera } = input
  if (camera.state === 'live') {
    // The backend already gave up on a picture (its first-frame grace), or
    // asking again keeps finding none: wait for the frame instead.
    if (camera.noVideo === true || input.refusals >= REPLAY_SILENT_CAMERA_RETRY_LIMIT) {
      return { kind: 'wait-for-frames' }
    }
    return { kind: 'retry', delayMs: replaySilentCameraRetryDelayMs(input.refusals) }
  }
  if (camera.state === 'starting' || !camera.cameraId || camera.cameraId !== input.chosenCameraId) {
    return { kind: 'wait-for-live' }
  }
  return { kind: 'failed' }
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
  /**
   * The backend refused the last start as `replay-sources-not-ready`: the
   * scene's camera has no frame yet. The ring waits for the camera to go
   * live instead of retrying (each try would only be refused again).
   */
  waitingForCamera?: boolean
  /**
   * Plan 224 D6: a talk show's room holds the camera, from Open the room
   * until the room has closed. The buffer-only ring steps aside meanwhile:
   * the backend refuses Open the room beside it and any start while the
   * room is open, and it comes back once the room is closed.
   */
  roomHoldsCamera?: boolean
}

export type ReplayReconcileAction = 'start' | 'stop' | 'give-up' | null

const ACTIVE = new Set(['starting', 'recording', 'streaming', 'stopping'])

/** True from Open the room until the room has closed (any phase but closed). */
export function roomHoldsTheCamera(room: { phase: string } | null | undefined): boolean {
  return room != null && room.phase !== 'closed'
}

function bufferOnlyRingStoppable(input: ReplayReconcileInput): boolean {
  return (
    (input.replayState === 'on' || input.replayState === 'starting') &&
    input.replayOnlyBuffer &&
    input.recordingReplayOnly &&
    ACTIVE.has(input.recordingState) &&
    !input.startPending &&
    !input.stopPending &&
    !input.replayStartInFlight
  )
}

export function replayBufferReconcileAction(input: ReplayReconcileInput): ReplayReconcileAction {
  if (input.roomHoldsCamera) {
    return bufferOnlyRingStoppable(input) ? 'stop' : null
  }
  if (input.armed) {
    if (
      // A ring that died with its session ('error') disarms the switch; once
      // something arms it again (below), it starts like a ring that is off.
      (input.replayState === 'off' || input.replayState === 'error') &&
      // A failed session is over too (a ring that died ends 'failed').
      (input.recordingState === 'idle' || input.recordingState === 'failed') &&
      !input.startPending &&
      !input.stopPending &&
      !input.replayStartInFlight &&
      !input.waitingForCamera
    ) {
      return input.failedStarts >= REPLAY_START_RETRY_LIMIT ? 'give-up' : 'start'
    }
    // On, starting, riding a recording, or waiting on a session: nothing to do.
    return null
  }
  if (bufferOnlyRingStoppable(input)) {
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

/** A source change while only the buffer-only session runs is an idle
 * change: stop the ring so reconcile re-arms it with the new sources. */
export function replayBufferShouldRestartForSources(input: {
  recordingReplayOnly: boolean
  recordingState: string
}): boolean {
  return input.recordingReplayOnly && ACTIVE.has(input.recordingState)
}
