/** Waits between `camera.lowLight.get` attempts after a failed read (issue #1066). */
export const CAMERA_LOW_LIGHT_READ_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const

/**
 * How long to wait before asking again after failed read number `failures`
 * (1 for the first), or null once the retries are spent. A failed read is a
 * camera that stalled or a driver error, not a camera without the control,
 * so the switch keeps its last state while the retries run.
 */
export function cameraLowLightReadRetryDelayMs(failures: number): number | null {
  if (!Number.isInteger(failures) || failures < 1) return null
  return CAMERA_LOW_LIGHT_READ_RETRY_DELAYS_MS[failures - 1] ?? null
}
