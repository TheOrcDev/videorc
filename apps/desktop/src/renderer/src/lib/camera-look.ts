import type { CameraLook, LayoutSettings } from '../../../shared/backend'

export const NEUTRAL_CAMERA_LOOK: CameraLook = { brightness: 0, contrast: 1, saturation: 1 }

export function normalizeCameraLook(value: unknown): CameraLook | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<CameraLook>
  const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback
  const look = {
    brightness: clamp(candidate.brightness, 0, -0.25, 0.25),
    contrast: clamp(candidate.contrast, 1, 0.5, 1.5),
    saturation: clamp(candidate.saturation, 1, 0, 2)
  }
  return look.brightness === 0 && look.contrast === 1 && look.saturation === 1 ? undefined : look
}

export function cameraLookLayout(
  layout: LayoutSettings,
  cameraId: string | undefined,
  looks: Record<string, CameraLook> | undefined
): LayoutSettings {
  const { cameraLook: _previous, ...base } = layout
  const cameraLook = normalizeCameraLook(cameraId ? looks?.[cameraId] : undefined)
  return cameraLook ? { ...base, cameraLook } : base
}

/** Latest value is read at each tick, including the final tick after release. */
export function createCameraLookThrottle(apply: () => void): {
  schedule: () => void
  dispose: () => void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    schedule: () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        apply()
      }, 33)
    },
    dispose: () => {
      clearTimeout(timer)
      timer = undefined
    }
  }
}
