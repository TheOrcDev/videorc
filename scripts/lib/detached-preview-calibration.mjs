export const DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE = Object.freeze({
  width: 960,
  height: 540
})

// The floating preview BrowserWindow includes the 28px drag bar above its
// video content. Requesting this outer size yields an exact 960x540 surface.
export const DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE = Object.freeze({
  width: DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE.width,
  height: DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE.height + 28
})

export function inspectDetachedPreviewCalibrationSample(windowState, surfaceStatus) {
  const expected = DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE
  const previewBounds = normalizeBounds(windowState?.contentBounds)
  const nativeBounds = normalizeBounds(surfaceStatus?.bounds, { preferScreenCoordinates: true })
  const failures = []

  if (windowState?.open !== true || windowState?.visible !== true) {
    failures.push('preview window was not open and visible')
  }
  if (windowState?.mode !== 'floating') {
    failures.push(`preview window mode was ${windowState?.mode ?? 'missing'}; expected floating`)
  }
  if (windowState?.nativeOwnsPlacement !== true) {
    failures.push('native preview did not own placement')
  }
  addBoundsFailures(failures, 'preview content', previewBounds, expected)

  if (
    surfaceStatus?.state !== 'live' ||
    surfaceStatus?.transport !== 'native-surface' ||
    surfaceStatus?.backing !== 'cametal-layer'
  ) {
    failures.push(
      `native surface was ${surfaceStatus?.state ?? 'missing'}/${surfaceStatus?.transport ?? 'missing'}/${surfaceStatus?.backing ?? 'missing'}`
    )
  }
  if (surfaceStatus?.bounds?.visible !== true) {
    failures.push('native surface bounds were not visible')
  }
  addBoundsFailures(failures, 'native surface', nativeBounds, expected)

  if (
    previewBounds &&
    nativeBounds &&
    (previewBounds.x !== nativeBounds.x || previewBounds.y !== nativeBounds.y)
  ) {
    failures.push(
      `native surface origin ${formatOrigin(nativeBounds)} did not match preview content ${formatOrigin(previewBounds)}`
    )
  }

  return {
    ready: failures.length === 0,
    failures,
    stabilityKey: failures.length === 0 ? JSON.stringify({ previewBounds, nativeBounds }) : null,
    previewBounds,
    nativeBounds
  }
}

function normalizeBounds(bounds, { preferScreenCoordinates = false } = {}) {
  if (!bounds || typeof bounds !== 'object') return null
  const x = preferScreenCoordinates ? finite(bounds.screenX, bounds.x) : finite(bounds.x)
  const y = preferScreenCoordinates ? finite(bounds.screenY, bounds.y) : finite(bounds.y)
  const width = finite(bounds.width)
  const height = finite(bounds.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return { x, y, width, height }
}

function addBoundsFailures(failures, label, bounds, expected) {
  if (!bounds) {
    failures.push(`${label} bounds were missing or incomplete`)
    return
  }
  if (bounds.width !== expected.width || bounds.height !== expected.height) {
    failures.push(
      `${label} was ${bounds.width}x${bounds.height}; expected ${expected.width}x${expected.height}`
    )
  }
}

function finite(...values) {
  return values.find(Number.isFinite)
}

function formatOrigin(bounds) {
  return `${bounds.x},${bounds.y}`
}
