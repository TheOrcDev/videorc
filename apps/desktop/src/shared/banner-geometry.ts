// Where a banner image lands on a canvas (plan 186, "Where the image lands
// inside its rect"). The TS twin of Rust `banner_draw_rect`: both reproduce
// every case of `protocol-fixtures/banner-geometry.json` exactly. Pure, so the
// Electron proof surface (main) and the Scene page (renderer) share it.

import type { Banner, OverlayOrientation, OverlayRect } from './backend'

/** A rect in canvas pixels. */
export interface BannerPixelRect {
  x: number
  y: number
  w: number
  h: number
}

export type BannerHorizontalGravity = 'left' | 'center' | 'right'

/** Mirrors Rust `CENTER_GRAVITY_BAND` (`overlay_layout.rs`). */
const CENTER_GRAVITY_BAND = 0.02

/**
 * Mirror of Rust `OverlayRect::pixels`: the rect in canvas pixels as
 * `[left, top, right, bottom]`, rounded and clamped to the canvas. Rust
 * rounds half away from zero; `Math.round` agrees for every value that
 * survives the clamp (negative halves clamp to 0 either way).
 */
export function overlayRectPixels(
  rect: OverlayRect,
  canvasWidth: number,
  canvasHeight: number
): [left: number, top: number, right: number, bottom: number] {
  const clamp = (value: number, max: number): number =>
    Math.min(max, Math.max(0, Math.round(value * max)))
  const left = clamp(rect.x, canvasWidth)
  const right = Math.max(left, clamp(rect.x + rect.w, canvasWidth))
  const top = clamp(rect.y, canvasHeight)
  const bottom = Math.max(top, clamp(rect.y + rect.h, canvasHeight))
  return [left, top, right, bottom]
}

/** Mirror of Rust `OverlayRect::horizontal_gravity`: decided by the centre. */
export function overlayRectHorizontalGravity(rect: OverlayRect): BannerHorizontalGravity {
  const center = rect.x + rect.w / 2
  if (center < 0.5 - CENTER_GRAVITY_BAND) return 'left'
  if (center > 0.5 + CENTER_GRAVITY_BAND) return 'right'
  return 'center'
}

/** Mirror of Rust `OverlayRect::bottom_gravity`: the centre is in the lower half. */
export function overlayRectBottomGravity(rect: OverlayRect): boolean {
  return rect.y + rect.h / 2 >= 0.5
}

/**
 * The image drawn contained in its rect: it keeps its aspect ratio, fills the
 * rect along its longer side and hugs the edge the rect's gravity picks.
 */
export function bannerDrawRect(
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  rect: OverlayRect
): BannerPixelRect {
  const canvasW = Math.max(1, Math.floor(canvasWidth))
  const canvasH = Math.max(1, Math.floor(canvasHeight))
  const imageW = Math.max(1, Math.floor(imageWidth))
  const imageH = Math.max(1, Math.floor(imageHeight))
  const [left, top, right, bottom] = overlayRectPixels(rect, canvasW, canvasH)
  const rw = Math.max(1, right - left)
  const rh = Math.max(1, bottom - top)

  let dw: number
  let dh: number
  if (imageW * rh <= imageH * rw) {
    dh = rh
    dw = Math.min(rw, Math.max(1, Math.round((imageW * rh) / imageH)))
  } else {
    dw = rw
    dh = Math.min(rh, Math.max(1, Math.round((imageH * rw) / imageW)))
  }

  const gravity = overlayRectHorizontalGravity(rect)
  let dx =
    gravity === 'left'
      ? left
      : gravity === 'center'
        ? left + Math.floor((rw - dw) / 2)
        : left + rw - dw
  let dy = overlayRectBottomGravity(rect) ? top + rh - dh : top
  dx = Math.min(dx, canvasW - dw)
  dy = Math.min(dy, canvasH - dh)
  return { x: dx, y: dy, w: dw, h: dh }
}

/** A canvas taller than wide takes the vertical rect (mirrors Rust). */
export function bannerOrientationForCanvas(
  canvasWidth: number,
  canvasHeight: number
): OverlayOrientation {
  return canvasHeight > canvasWidth ? 'vertical' : 'horizontal'
}

/** The banner's placed rect for a canvas of this shape. */
export function bannerRectForCanvas(
  banner: Pick<Banner, 'horizontal' | 'vertical'>,
  canvasWidth: number,
  canvasHeight: number
): OverlayRect {
  return bannerOrientationForCanvas(canvasWidth, canvasHeight) === 'vertical'
    ? banner.vertical
    : banner.horizontal
}
