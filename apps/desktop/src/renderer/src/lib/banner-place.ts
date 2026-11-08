import {
  OVERLAY_RECT_MIN_SIZE,
  type Banner,
  type OverlayOrientation,
  type OverlayRect
} from '@/lib/backend'
import { clampOverlayRect, overlayPlaceOrigin, type OverlayPlace } from '@/lib/overlay-layout'
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

/** Every place a banner can go: the canvas's 3×3 grid, or the whole frame.
 * The inspector's snaps (`BannerSnap`) are seven of them (plan 209 D22). */
export type BannerPlace = OverlayPlace | 'full-frame'

/**
 * A snap for the orientation shown. Unlike an overlay snap, which writes the
 * item's default size, a banner keeps the size its image has now and only
 * moves, inside the overlay margins (a landscape canvas keeps a 4 % margin,
 * a portrait one its safe area; `overlayPlaceOrigin`, the overlay snaps' own
 * rule). Full frame fills the canvas.
 */
export function bannerSnapRect(
  image: Pick<Banner, 'width' | 'height'>,
  rect: OverlayRect,
  orientation: OverlayOrientation,
  canvasAspect: number,
  snap: BannerPlace
): OverlayRect {
  if (snap === 'full-frame') return { x: 0, y: 0, w: 1, h: 1 }
  const { w, h } = bannerFitRect(image, rect, canvasAspect, orientation)
  const { x, y } = overlayPlaceOrigin(snap, orientation, w, h)
  return clampOverlayRect({ x, y, w, h })
}

// --- Where an import lands (plan 209 S11b) ------------------------------------

const LANDSCAPE_ASPECT = 16 / 9
const PORTRAIT_ASPECT = 9 / 16
/** Below the 22 % portrait safe area. */
const PORTRAIT_WIDE_BOTTOM = 0.78

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** Mirror of Rust `rounded_clamped` (`banners.rs`). */
function roundedClamped(rect: OverlayRect): OverlayRect {
  const w = Math.min(1, Math.max(OVERLAY_RECT_MIN_SIZE, round6(rect.w)))
  const h = Math.min(1, Math.max(OVERLAY_RECT_MIN_SIZE, round6(rect.h)))
  const x = Math.min(round6(1 - w), Math.max(0, round6(rect.x)))
  const y = Math.min(round6(1 - h), Math.max(0, round6(rect.y)))
  return { x, y, w, h }
}

/**
 * Where a freshly imported banner lands on each orientation: the TS twin of
 * Rust `banner_default_places` (`banners.rs`), pinned by
 * `protocol-fixtures/high-risk-contracts.json`'s banner and the Rust test
 * values. This is a banner's default ("medium") size for an agent's
 * `move_on_scene` (D22): a full-frame image, a wide strip, a tall panel or a
 * badge, by the image's aspect.
 */
export function bannerDefaultPlaces(
  image: Pick<Banner, 'width' | 'height'>
): Record<OverlayOrientation, OverlayRect> {
  const aspect = Math.max(1, image.width) / Math.max(1, image.height)
  const portraitSpan = 1 - 2 * BANNER_PORTRAIT_SIDE_MARGIN
  let horizontal: OverlayRect
  let vertical: OverlayRect
  if (Math.abs(aspect - LANDSCAPE_ASPECT) <= 0.02 && image.width >= 1280) {
    const h = PORTRAIT_ASPECT / aspect
    horizontal = { x: 0, y: 0, w: 1, h: 1 }
    vertical = { x: 0, y: (1 - h) / 2, w: 1, h }
  } else if (aspect >= 2.5) {
    const w = 0.6
    const h = (w * LANDSCAPE_ASPECT) / aspect
    const vw = portraitSpan
    const vh = (vw * PORTRAIT_ASPECT) / aspect
    horizontal = { x: 0.2, y: 1 - BANNER_LANDSCAPE_EDGE_MARGIN - h, w, h }
    vertical = { x: BANNER_PORTRAIT_SIDE_MARGIN, y: PORTRAIT_WIDE_BOTTOM - vh, w: vw, h: vh }
  } else if (aspect <= 0.6) {
    const h = 0.7
    const w = (h * aspect) / LANDSCAPE_ASPECT
    let vh = 0.4
    let vw = (vh * aspect) / PORTRAIT_ASPECT
    if (vw > portraitSpan) {
      vw = portraitSpan
      vh = (vw * PORTRAIT_ASPECT) / aspect
    }
    horizontal = { x: 1 - BANNER_LANDSCAPE_SIDE_MARGIN - w, y: 0.15, w, h }
    vertical = { x: 1 - BANNER_PORTRAIT_SIDE_MARGIN - vw, y: 0.3, w: vw, h: vh }
  } else {
    const h = 0.2
    const w = (h * aspect) / LANDSCAPE_ASPECT
    const vw = 0.3 * Math.min(aspect, 1)
    const vh = (vw * PORTRAIT_ASPECT) / aspect
    horizontal = { x: 1 - BANNER_LANDSCAPE_SIDE_MARGIN - w, y: BANNER_LANDSCAPE_EDGE_MARGIN, w, h }
    vertical = {
      x: 1 - BANNER_PORTRAIT_SIDE_MARGIN - vw,
      y: BANNER_PORTRAIT_TOP_MARGIN,
      w: vw,
      h: vh
    }
  }
  return { horizontal: roundedClamped(horizontal), vertical: roundedClamped(vertical) }
}
