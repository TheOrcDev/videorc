import type { PreviewSurfaceBounds } from './backend'

export function normalizePreviewSurfaceBounds(bounds: PreviewSurfaceBounds): PreviewSurfaceBounds {
  const normalized: PreviewSurfaceBounds = {
    screenX: finiteNumber(bounds.screenX, 0),
    screenY: finiteNumber(bounds.screenY, 0),
    width: positiveNumber(bounds.width, 1),
    height: positiveNumber(bounds.height, 1),
    scaleFactor: Math.max(1, positiveNumber(bounds.scaleFactor, 1)),
    screenHeight: optionalPositiveNumber(bounds.screenHeight)
  }
  if (hasClip(bounds)) {
    normalized.clipX = finiteNumber(bounds.clipX, normalized.screenX)
    normalized.clipY = finiteNumber(bounds.clipY, normalized.screenY)
    normalized.clipWidth = nonNegativeNumber(bounds.clipWidth, 0)
    normalized.clipHeight = nonNegativeNumber(bounds.clipHeight, 0)
  }
  if (typeof bounds.visible === 'boolean') {
    normalized.visible = bounds.visible
  }
  return normalized
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
    (previous.visible ?? true) !== (next.visible ?? true)
  )
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface ComputePreviewSurfaceBoundsInput {
  /** Studio slot rect in viewport (CSS) coordinates. */
  slotRect: RectLike
  /** Rects of clipping ancestors (overflow != visible), viewport coordinates. */
  clipRects: readonly RectLike[]
  viewportWidth: number
  viewportHeight: number
  /** window.screenX / window.screenY — top-left of the viewport in screen coords. */
  windowScreenX: number
  windowScreenY: number
  scaleFactor: number
  screenHeight?: number
  /** document.visibilityState === 'visible' */
  documentVisible: boolean
  /**
   * True while any open Electron overlay (command palette, dialog, select menu,
   * tooltip, toast) intersects the slot rect. The native surface always floats above
   * the web content, so the only honest way to keep overlays readable is to hide the
   * preview for as long as they overlap (plan WS-B slice B3).
   */
  overlayOccluded?: boolean
}

/**
 * The studio-slot gluing math (plan WS-B slice B1): convert the slot's viewport rect
 * into absolute screen bounds plus the visible clip intersection. Scrolling a slot
 * half out of its container yields a shrinking clip rect; scrolling it fully away
 * (or hiding the document) yields visible:false so the native host hides the surface
 * instead of floating it over unrelated UI.
 */
export function computePreviewSurfaceBounds(
  input: ComputePreviewSurfaceBoundsInput
): PreviewSurfaceBounds {
  const slot = input.slotRect
  let clip: RectLike | null = {
    left: 0,
    top: 0,
    width: Math.max(0, input.viewportWidth),
    height: Math.max(0, input.viewportHeight)
  }
  for (const ancestorRect of input.clipRects) {
    clip = clip ? intersectRects(clip, ancestorRect) : null
  }
  const visibleRect = clip ? intersectRects(clip, slot) : null
  const visible =
    input.documentVisible &&
    !(input.overlayOccluded ?? false) &&
    visibleRect !== null &&
    visibleRect.width >= 1 &&
    visibleRect.height >= 1

  const clipRect = visibleRect ?? { left: slot.left, top: slot.top, width: 0, height: 0 }
  return normalizePreviewSurfaceBounds({
    screenX: input.windowScreenX + slot.left,
    screenY: input.windowScreenY + slot.top,
    width: slot.width,
    height: slot.height,
    scaleFactor: input.scaleFactor,
    screenHeight: input.screenHeight,
    clipX: input.windowScreenX + clipRect.left,
    clipY: input.windowScreenY + clipRect.top,
    clipWidth: visible ? clipRect.width : 0,
    clipHeight: visible ? clipRect.height : 0,
    visible
  })
}

function intersectRects(a: RectLike, b: RectLike): RectLike | null {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  if (right <= left || bottom <= top) {
    return null
  }
  return { left, top, width: right - left, height: bottom - top }
}

function hasClip(bounds: PreviewSurfaceBounds): boolean {
  return (
    bounds.clipX !== undefined ||
    bounds.clipY !== undefined ||
    bounds.clipWidth !== undefined ||
    bounds.clipHeight !== undefined
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
