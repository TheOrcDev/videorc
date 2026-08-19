import type {
  MainOwnedPreviewSurfaceBounds,
  MainOwnedPreviewSurfaceBoundsParams,
  OpaqueNativeWindowHandle,
  PreviewSurfaceBounds,
  PreviewSurfaceStatus
} from './backend'

const OPAQUE_NATIVE_WINDOW_HANDLE = /^0x[0-9a-f]{16}$/
export const PRIVILEGED_PREVIEW_FIELDS = [
  'orderAboveWindowHandle',
  'nativeWindowHandle',
  'processId',
  'sharedHandle',
  'sharedTextureHandle',
  'textureHandle',
  'd3d11TextureHandle',
  'resourceHandle'
] as const

export function normalizePreviewSurfaceBounds(bounds: PreviewSurfaceBounds): PreviewSurfaceBounds {
  const normalized = {
    ...(bounds as PreviewSurfaceBounds & Record<string, unknown>),
    screenX: finiteNumber(bounds.screenX, 0),
    screenY: finiteNumber(bounds.screenY, 0),
    width: positiveNumber(bounds.width, 1),
    height: positiveNumber(bounds.height, 1),
    scaleFactor: Math.max(1, positiveNumber(bounds.scaleFactor, 1)),
    screenHeight: optionalPositiveNumber(bounds.screenHeight)
  } as PreviewSurfaceBounds & Record<string, unknown>
  if (hasClip(bounds)) {
    normalized.clipX = finiteNumber(bounds.clipX, normalized.screenX)
    normalized.clipY = finiteNumber(bounds.clipY, normalized.screenY)
    normalized.clipWidth = nonNegativeNumber(bounds.clipWidth, 0)
    normalized.clipHeight = nonNegativeNumber(bounds.clipHeight, 0)
  } else {
    delete normalized.clipX
    delete normalized.clipY
    delete normalized.clipWidth
    delete normalized.clipHeight
  }
  if (typeof bounds.visible === 'boolean') {
    normalized.visible = bounds.visible
  } else {
    delete normalized.visible
  }
  // Stacking fields must survive normalization: dropping them here silently
  // flipped the native surface back to floating level (always-on-top over
  // every app) because the helper treats their absence as detached-window stacking off.
  if (typeof bounds.orderAboveWindowId === 'number') {
    normalized.orderAboveWindowId = bounds.orderAboveWindowId
  } else {
    delete normalized.orderAboveWindowId
  }
  if (typeof bounds.elevated === 'boolean') {
    normalized.elevated = bounds.elevated
  } else {
    delete normalized.elevated
  }
  if (typeof bounds.cornerRadius === 'number' && Number.isFinite(bounds.cornerRadius)) {
    normalized.cornerRadius = Math.max(0, bounds.cornerRadius)
  } else {
    delete normalized.cornerRadius
  }
  // Renderer-supplied bounds are never an HWND authority. The object spread
  // above intentionally preserves unknown future geometry, so privileged
  // fields must be deleted explicitly rather than relying on TypeScript.
  for (const field of PRIVILEGED_PREVIEW_FIELDS) {
    delete normalized[field]
  }
  return normalized
}

export function normalizeOpaqueNativeWindowHandle(value: unknown): OpaqueNativeWindowHandle {
  if (typeof value !== 'string') {
    throw new Error('Native window handle must be an opaque hexadecimal string.')
  }
  const normalized = value.toLowerCase()
  if (!OPAQUE_NATIVE_WINDOW_HANDLE.test(normalized) || normalized === '0x0000000000000000') {
    throw new Error('Native window handle must be a nonzero fixed-width 64-bit hexadecimal value.')
  }
  return normalized as OpaqueNativeWindowHandle
}

/**
 * Build the only bounds shape allowed to carry a Windows HWND. Main supplies
 * both the fresh handle and current lifecycle generation immediately before a
 * backend/native-host request.
 */
export function mainOwnedPreviewSurfaceBoundsParams(
  bounds: PreviewSurfaceBounds,
  generation: number,
  orderAboveWindowHandle?: unknown
): MainOwnedPreviewSurfaceBoundsParams {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Native preview generation must be a non-negative safe integer.')
  }
  const trustedBounds: MainOwnedPreviewSurfaceBounds = normalizePreviewSurfaceBounds(bounds)
  if (orderAboveWindowHandle !== undefined) {
    trustedBounds.orderAboveWindowHandle = normalizeOpaqueNativeWindowHandle(orderAboveWindowHandle)
  }
  return { bounds: trustedBounds, generation }
}

/** Clone a status for renderer delivery and remove every privileged identity. */
export function sanitizeRendererPreviewSurfaceStatus(
  status: PreviewSurfaceStatus
): PreviewSurfaceStatus {
  const sanitized = { ...status } as PreviewSurfaceStatus & Record<string, unknown>
  for (const field of PRIVILEGED_PREVIEW_FIELDS) {
    delete sanitized[field]
  }
  if (status.bounds) {
    sanitized.bounds = normalizePreviewSurfaceBounds(status.bounds)
  }
  if (status.windowsD3d11Presenter) {
    const presenter = {
      ...status.windowsD3d11Presenter
    } as PreviewSurfaceStatus['windowsD3d11Presenter'] & Record<string, unknown>
    for (const field of PRIVILEGED_PREVIEW_FIELDS) {
      delete presenter[field]
    }
    sanitized.windowsD3d11Presenter = presenter
  }
  return sanitized
}

/**
 * One comparator for "did the surface placement meaningfully change" — used by both
 * the renderer report loop and the studio sync queue so they cannot disagree.
 */
export function previewSurfaceBoundsChanged(
  previous: PreviewSurfaceBounds | null,
  next: PreviewSurfaceBounds
): boolean {
  if (!previous) {
    return true
  }
  return (
    Math.abs(previous.screenX - next.screenX) >= 1 ||
    Math.abs(previous.screenY - next.screenY) >= 1 ||
    Math.abs(previous.width - next.width) >= 1 ||
    Math.abs(previous.height - next.height) >= 1 ||
    Math.abs(previous.scaleFactor - next.scaleFactor) >= 0.01 ||
    Math.abs((previous.screenHeight ?? 0) - (next.screenHeight ?? 0)) >= 1 ||
    Math.abs((previous.clipX ?? previous.screenX) - (next.clipX ?? next.screenX)) >= 1 ||
    Math.abs((previous.clipY ?? previous.screenY) - (next.clipY ?? next.screenY)) >= 1 ||
    Math.abs((previous.clipWidth ?? previous.width) - (next.clipWidth ?? next.width)) >= 1 ||
    Math.abs((previous.clipHeight ?? previous.height) - (next.clipHeight ?? next.height)) >= 1 ||
    (previous.visible ?? true) !== (next.visible ?? true) ||
    previous.orderAboveWindowId !== next.orderAboveWindowId ||
    previous.elevated !== next.elevated
  )
}

/**
 * Fields that require work inside an in-process CAMetalLayer. Absolute screen
 * placement and z-order move atomically with the owning NSView, so forwarding
 * them back through JS/native presentation only adds contention.
 */
export function previewSurfaceDrawableBoundsChanged(
  previous: PreviewSurfaceBounds | null,
  next: PreviewSurfaceBounds
): boolean {
  if (!previous) {
    return true
  }
  return (
    Math.abs(previous.width - next.width) >= 1 ||
    Math.abs(previous.height - next.height) >= 1 ||
    Math.abs(previous.scaleFactor - next.scaleFactor) >= 0.01 ||
    (previous.visible ?? true) !== (next.visible ?? true) ||
    // A radius change must reach the layer even when nothing else moved.
    Math.abs((previous.cornerRadius ?? 0) - (next.cornerRadius ?? 0)) >= 0.5
  )
}

export interface NativePreviewDrawableMetrics {
  nativePreviewDrawableWidth?: number
  nativePreviewDrawableHeight?: number
  nativePreviewContentsScale?: number
}

/**
 * Status bounds can advance before an asynchronously queued native resize. The
 * in-process movement fast path is safe only when the CAMetalLayer's measured
 * drawable also matches the desired point bounds and display scale.
 */
export function previewSurfaceNativeDrawableMatchesBounds(
  metrics: NativePreviewDrawableMetrics,
  bounds: PreviewSurfaceBounds
): boolean {
  const drawableWidth = metrics.nativePreviewDrawableWidth
  const drawableHeight = metrics.nativePreviewDrawableHeight
  const contentsScale = metrics.nativePreviewContentsScale
  if (
    !Number.isFinite(drawableWidth) ||
    !Number.isFinite(drawableHeight) ||
    !Number.isFinite(contentsScale)
  ) {
    return false
  }
  const scale = Math.max(1, bounds.scaleFactor)
  const expectedWidth = Math.round(Math.max(1, Math.round(bounds.width)) * scale)
  const expectedHeight = Math.round(Math.max(1, Math.round(bounds.height)) * scale)
  return (
    Math.abs(drawableWidth! - expectedWidth) < 1 &&
    Math.abs(drawableHeight! - expectedHeight) < 1 &&
    Math.abs(contentsScale! - scale) < 0.01
  )
}

function hasClip(bounds: PreviewSurfaceBounds): boolean {
  // null-tolerant: serialized bounds may carry explicit nulls for absent clip
  // fields; treating null as "clip present" would collapse the clip to 0×0.
  return (
    bounds.clipX != null ||
    bounds.clipY != null ||
    bounds.clipWidth != null ||
    bounds.clipHeight != null
  )
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
