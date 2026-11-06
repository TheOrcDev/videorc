import type { PreviewCameraStatus } from '@/lib/backend'

// Issue #1066: a live camera can deliver half its rate for minutes (a webcam's
// auto exposure stretches each frame in low light, on every platform) while
// Sources said Receiving and every recording got the slow camera. The camera
// row says so once the measured rate stays low, and goes back once it stays
// recovered. Two lines and two holds, so a rate near the line never flickers.

/** Under this share of the expected rate, the camera is slow. */
export const CAMERA_LOW_FPS_RATIO = 0.8
/** At or over this share, a slow camera has recovered. */
export const CAMERA_RECOVERED_FPS_RATIO = 0.9
/** How long the rate stays low before the row says so. */
export const CAMERA_LOW_FPS_HOLD_MS = 5000
/** How long a slow camera stays recovered before the row goes back. */
export const CAMERA_RECOVERED_FPS_HOLD_MS = 3000

/** What the camera row says about a slow camera. */
export interface CameraLowFrameRate {
  /** The mean measured rate while it has been low. */
  fps: number
  /** The rate the camera runs at (see `cameraExpectedFps`). */
  expectedFps: number
}

export interface CameraFrameRateWatch {
  /** The camera and rate this watch is about; either changing starts over. */
  cameraId?: string
  expectedFps?: number
  lowSinceMs?: number
  recoveredSinceMs?: number
  lowFpsSum: number
  lowSamples: number
  /** Set while the row says the camera is slow. */
  low: CameraLowFrameRate | null
}

export const IDLE_CAMERA_FRAME_RATE_WATCH: CameraFrameRateWatch = Object.freeze({
  lowFpsSum: 0,
  lowSamples: 0,
  low: null
})

type CameraRateStatus = Pick<
  PreviewCameraStatus,
  'state' | 'cameraId' | 'targetFps' | 'selectedFormatMaxFps' | 'sourceFps' | 'noVideo'
>

/**
 * The rate the camera runs at: the requested rate, capped by what the
 * selected format can do. A format that can't reach the request is the
 * format shortfall's news (plan 024 S5), not a slow camera.
 */
export function cameraExpectedFps(
  status: Pick<PreviewCameraStatus, 'targetFps' | 'selectedFormatMaxFps'>
): number | undefined {
  const caps = [status.targetFps, status.selectedFormatMaxFps].filter(
    (fps): fps is number => typeof fps === 'number' && Number.isFinite(fps) && fps > 0
  )
  return caps.length > 0 ? Math.min(...caps) : undefined
}

/** One `preview.camera.status` sample (about 4 a second), applied. Pure. */
export function nextCameraFrameRateWatch(
  watch: CameraFrameRateWatch,
  status: CameraRateStatus,
  nowMs: number
): CameraFrameRateWatch {
  const expectedFps = cameraExpectedFps(status)
  const fps = status.sourceFps
  // A camera that sends nothing has its own chip (plan 216 D2).
  if (
    status.state !== 'live' ||
    status.noVideo === true ||
    expectedFps === undefined ||
    typeof fps !== 'number' ||
    !Number.isFinite(fps)
  ) {
    return IDLE_CAMERA_FRAME_RATE_WATCH
  }
  const current =
    watch.cameraId === status.cameraId && watch.expectedFps === expectedFps
      ? watch
      : IDLE_CAMERA_FRAME_RATE_WATCH
  const fresh: CameraFrameRateWatch = {
    ...IDLE_CAMERA_FRAME_RATE_WATCH,
    cameraId: status.cameraId,
    expectedFps
  }

  if (fps < expectedFps * CAMERA_LOW_FPS_RATIO) {
    const lowSinceMs = current.lowSinceMs ?? nowMs
    const lowFpsSum = current.lowFpsSum + fps
    const lowSamples = current.lowSamples + 1
    const low =
      current.low || nowMs - lowSinceMs >= CAMERA_LOW_FPS_HOLD_MS
        ? { fps: lowFpsSum / lowSamples, expectedFps }
        : null
    return { ...fresh, lowSinceMs, lowFpsSum, lowSamples, low }
  }
  // Not slow yet: any sample over the line starts the low span over.
  if (!current.low) return fresh
  if (fps >= expectedFps * CAMERA_RECOVERED_FPS_RATIO) {
    const recoveredSinceMs = current.recoveredSinceMs ?? nowMs
    return nowMs - recoveredSinceMs >= CAMERA_RECOVERED_FPS_HOLD_MS
      ? fresh
      : { ...current, recoveredSinceMs }
  }
  // Between the lines: still slow, and recovery starts over.
  return { ...current, recoveredSinceMs: undefined }
}

/** Whether the row would read the same for both (rounded, as it shows them). */
export function sameCameraLowFrameRate(
  a: CameraLowFrameRate | null,
  b: CameraLowFrameRate | null
): boolean {
  if (!a || !b) return a === b
  return Math.round(a.fps) === Math.round(b.fps) && a.expectedFps === b.expectedFps
}

/**
 * "C920 is sending 15 of 30 fps. More light usually helps." With low-light
 * compensation on (issue #1066), the camera may be trading frames for exposure
 * on purpose, so the line names the switch that can bring the rate back.
 */
export function cameraLowFrameRateLine(
  name: string | undefined,
  low: CameraLowFrameRate,
  options?: { lowLightCompensation?: boolean }
): string {
  const expected = Math.round(low.expectedFps)
  const sending = `${name?.trim() || 'Your camera'} is sending ${Math.round(low.fps)} of ${expected} fps.`
  return options?.lowLightCompensation
    ? `${sending} Turning off Low-light compensation can bring it back to ${expected} fps.`
    : `${sending} More light usually helps.`
}
