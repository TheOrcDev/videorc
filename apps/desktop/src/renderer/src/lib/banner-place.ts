import type { Banner, OverlayOrientation, OverlayRect } from '@/lib/backend'
import { clampOverlayRect } from '@/lib/overlay-layout'
import {
  overlayRectBottomGravity,
  overlayRectHorizontalGravity
} from '../../../shared/banner-geometry'

// Where a banner sits on the Scene canvas (plan 186): the image's own rect
// inside its place, and the inspector's snaps. Pure, and only the Scene page
// imports it, so it stays out of the eager bundle.

// The overlay margins, mirrored from `overlay_layout.rs` (Rust) and the
// private copies in `lib/overlay-layout.ts`; `banner-place.test.ts` pins them
// against `overlaySnapRect`, so the two can never drift apart.
/** Landscape side margin: 4 % of the height, in canvas widths (0.0225). */
export const BANNER_LANDSCAPE_SIDE_MARGIN = (0.04 * 9) / 16
export const BANNER_LANDSCAPE_EDGE_MARGIN = 0.04
/** Portrait side margin: 4 % of the width, in canvas heights (0.071111). */
export const BANNER_PORTRAIT_SIDE_MARGIN = (0.04 * 16) / 9
/** The portrait safe area (plan 077): 8 % at the top, 22 % at the bottom. */
export const BANNER_PORTRAIT_TOP_MARGIN = 0.08
export const BANNER_PORTRAIT_BOTTOM_MARGIN = 0.22

export type BannerSnap =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'full-frame'

export const BANNER_SNAPS: readonly BannerSnap[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'full-frame'
]

export const BANNER_SNAP_LABELS: Record<BannerSnap, string> = {
  'top-left': 'Top left',
  'top-center': 'Top center',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
  'full-frame': 'Full frame'
}

/** The canvas shape an orientation stands for when the caller has none. */
const DEFAULT_CANVAS_ASPECT: Record<OverlayOrientation, number> = {
  horizontal: 16 / 9,
  vertical: 9 / 16
}

/**
 * The image's own rect inside its place, in canvas units: contained (the
 * aspect kept, the longer side filling the rect) and hugging the edge the
 * rect's gravity picks, exactly as `bannerDrawRect` draws it, without the
 * pixel rounding. The canvas aspect (width / height) converts the image's
 * aspect into canvas units. Moving or resizing this rect never moves the
 * picture: its gravity is the place's.
 */
export function bannerFitRect(
  image: Pick<Banner, 'width' | 'height'>,
  rect: OverlayRect,
  canvasAspect: number,
  orientation: OverlayOrientation = canvasAspect < 1 ? 'vertical' : 'horizontal'
): OverlayRect {
  const aspect =
    Number.isFinite(canvasAspect) && canvasAspect > 0
      ? canvasAspect
      : DEFAULT_CANVAS_ASPECT[orientation]
  const imageAspect = Math.max(1, image.width) / Math.max(1, image.height)
  let w = rect.w
  let h = rect.h
  // In units where the canvas is `aspect` wide and 1 high.
  if (imageAspect * rect.h <= rect.w * aspect) w = (imageAspect * rect.h) / aspect
  else h = (rect.w * aspect) / imageAspect
  const gravity = overlayRectHorizontalGravity(rect)
  const x =
    gravity === 'left'
      ? rect.x
      : gravity === 'center'
        ? rect.x + (rect.w - w) / 2
        : rect.x + rect.w - w
  const y = overlayRectBottomGravity(rect) ? rect.y + rect.h - h : rect.y
  return clampOverlayRect({ x, y, w, h })
}

/**
 * A snap for the orientation shown. Unlike an overlay snap, which writes the
 * item's default size, a banner keeps the size its image has now and only
 * moves, inside the overlay margins (a landscape canvas keeps a 4 % margin,
 * a portrait one its safe area). Full frame fills the canvas.
 */
export function bannerSnapRect(
  image: Pick<Banner, 'width' | 'height'>,
  rect: OverlayRect,
  orientation: OverlayOrientation,
  canvasAspect: number,
  snap: BannerSnap
): OverlayRect {
  if (snap === 'full-frame') return { x: 0, y: 0, w: 1, h: 1 }
  const { w, h } = bannerFitRect(image, rect, canvasAspect, orientation)
  const portrait = orientation === 'vertical'
  const side = portrait ? BANNER_PORTRAIT_SIDE_MARGIN : BANNER_LANDSCAPE_SIDE_MARGIN
  const top = portrait ? BANNER_PORTRAIT_TOP_MARGIN : BANNER_LANDSCAPE_EDGE_MARGIN
  const bottom = portrait ? BANNER_PORTRAIT_BOTTOM_MARGIN : BANNER_LANDSCAPE_EDGE_MARGIN
  const x = snap.endsWith('-left') ? side : snap.endsWith('-right') ? 1 - side - w : (1 - w) / 2
  const y = snap.startsWith('top-') ? top : 1 - bottom - h
  return clampOverlayRect({ x, y, w, h })
}
