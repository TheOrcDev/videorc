import type { PreviewCameraStatus, PreviewScreenStatus } from '@/lib/backend'

// Plan 173: the facts line under a live video source's picker. Only what the
// backend measured or negotiated, and only while the source is live: an
// unmeasured number is never shown.

function dimensions(width: number | undefined, height: number | undefined): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null
  return `${Math.round(width)} × ${Math.round(height)}`
}

/**
 * The screen's size. No frame rate: a screen delivers only when it changes,
 * so a measured rate would wander with whatever is on it.
 */
export function screenFacts(
  status: Pick<
    PreviewScreenStatus,
    'state' | 'nativeWidth' | 'nativeHeight' | 'width' | 'height'
  > | null
): string | null {
  if (status?.state !== 'live') return null
  return (
    dimensions(status.nativeWidth, status.nativeHeight) ?? dimensions(status.width, status.height)
  )
}

/**
 * The camera's negotiated format and the rate it runs at: the requested
 * rate, capped by what the selected format can do. The measured rate is not
 * used because it flickers between neighbours (29, 30, 29).
 */
export function cameraFacts(
  status: Pick<
    PreviewCameraStatus,
    | 'state'
    | 'targetFps'
    | 'selectedFormatWidth'
    | 'selectedFormatHeight'
    | 'selectedFormatMaxFps'
    | 'actualWidth'
    | 'actualHeight'
  > | null
): string | null {
  if (status?.state !== 'live') return null
  const size =
    dimensions(status.selectedFormatWidth, status.selectedFormatHeight) ??
    dimensions(status.actualWidth, status.actualHeight)
  if (!size) return null
  const caps = [status.targetFps, status.selectedFormatMaxFps].filter(
    (fps): fps is number => typeof fps === 'number' && Number.isFinite(fps) && fps > 0
  )
  if (caps.length === 0) return size
  return `${size} · ${Math.round(Math.min(...caps))} fps`
}
