// The Clips ring and a camera without a frame (2026-11-23). The backend
// refuses an automatic ring start with `replay-sources-not-ready` while the
// scene's camera has no frame. A camera that says live and never sends one (a
// blocked or dead camera, plan 216's MacBook camera) was asked again every
// 150 ms, forever. Pure; the Studio reaches it through the lazy
// lib/replay-buffer chunk, so the eager Studio chunk keeps its size.

import type { ReplayCameraWait } from './replay-buffer-reconcile'

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

type Ref<T> = { current: T }

/**
 * One `replay-sources-not-ready` refusal, as the Studio takes it. Counts a
 * live camera's refusal in `wait` and acts: asks again after the backoff,
 * waits for the camera's live edge, or stops asking and waits for its first
 * frame, which the bell says once ("Clips couldn't start", never a toast).
 * Returns false for a camera that failed, is missing or was denied: the
 * caller counts that start as failed.
 */
export function replaySourcesNotReadyStep(input: {
  wait: Ref<ReplayCameraWait>
  /** The Studio's camera wait: holds every start until it clears. */
  waitingForLive: Ref<boolean>
  /** The once-per-launch guard the Studio's other Clips notice shares. */
  notified: Ref<boolean>
  /** Publishes the Clips entry behind the bell. */
  notify: (reason: string) => void
  camera: ReplayCameraReport
  chosenCameraId: string | null | undefined
  schedule: (delayMs: number) => void
}): boolean {
  const { wait, camera } = input
  const refusals = wait.current.refusals + (camera.state === 'live' ? 1 : 0)
  const next = replayAfterSourcesNotReady({
    camera,
    chosenCameraId: input.chosenCameraId,
    refusals
  })
  const waits = next.kind === 'wait-for-frames'
  const first = waits && !wait.current.frames
  wait.current = { refusals, frames: wait.current.frames || waits }
  if (next.kind === 'failed') return false
  if (next.kind === 'retry') input.schedule(next.delayMs)
  // Waiting for the live edge or the first frame holds every start.
  else input.waitingForLive.current = true
  if (first) {
    console.warn('[replay-buffer] waiting for the camera to send a frame')
    if (!input.notified.current) {
      input.notified.current = true
      input.notify(REPLAY_CAMERA_SENDS_NO_PICTURE)
    }
  }
  return true
}

/**
 * The camera's status changed with frames in it: a camera that sends a
 * picture clears the silent-camera count. True when the ring had stopped
 * asking, so the Studio reconciles and the ring starts.
 */
export function replayCameraRecovers(
  wait: Ref<ReplayCameraWait>,
  waitingForCamera: Ref<boolean>,
  camera: ReplayCameraReport
): boolean {
  if (!replayCameraDelivers(camera)) return false
  const waited = wait.current.frames
  wait.current = { refusals: 0, frames: false }
  if (waited) waitingForCamera.current = false
  return waited
}
