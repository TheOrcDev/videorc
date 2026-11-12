// Plan 212 / issue #1088: the Windows Preview-check smoke's oracle. On
// Windows the Preview the user sees is the Electron proof surface, which main
// composes itself from `compositor.status` (raw screen layers plus banners),
// so the backend's `preview.debug.sample` (the compositor's presented frame)
// is not what is on screen. The dev/smoke-only `preview-surface-sample`
// command captures the proof surface's `#scene-root` and reads it with these
// pure helpers, the same middle-fifth window `preview.debug.sample` and
// `meanRectsRgb24` read, so every Preview oracle judges alike.

/** A rectangle in canvas fractions (0..1). */
export interface NormalizedRect {
  x: number
  y: number
  w: number
  h: number
}

export interface RgbMean {
  r: number
  g: number
  b: number
}

/** At most this many rects per read: the strip's 16 cells plus a few banners. */
export const PREVIEW_SURFACE_SAMPLE_MAX_RECTS = 64

/**
 * The smoke's rect list, validated: finite, positive size, at most
 * `PREVIEW_SURFACE_SAMPLE_MAX_RECTS`. Throws a message naming the bad entry.
 */
export function parseNormalizedRects(value: unknown): NormalizedRect[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Expected a non-empty rects array.')
  }
  if (value.length > PREVIEW_SURFACE_SAMPLE_MAX_RECTS) {
    throw new Error(`Expected at most ${PREVIEW_SURFACE_SAMPLE_MAX_RECTS} rects.`)
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Rect ${index} is not an object.`)
    }
    const record = entry as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length !== 4 || !['x', 'y', 'w', 'h'].every((key) => keys.includes(key))) {
      throw new Error(`Rect ${index} must have exactly x, y, w and h.`)
    }
    const [x, y, w, h] = (['x', 'y', 'w', 'h'] as const).map((key) => record[key])
    if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`Rect ${index} has a non-finite field.`)
    }
    if ((w as number) <= 0 || (h as number) <= 0) {
      throw new Error(`Rect ${index} needs a positive width and height.`)
    }
    return { x: x as number, y: y as number, w: w as number, h: h as number }
  })
}

/** The middle fifth of `[start, start + size)` in pixels, at least one pixel, clamped. */
function axis(start: number, size: number, pixels: number): [number, number] {
  const lo = Math.min(Math.max(Math.floor((start + size * 0.4) * pixels), 0), pixels - 1)
  const hi = Math.min(Math.max(Math.ceil((start + size * 0.6) * pixels), lo + 1), pixels)
  return [lo, hi]
}

/**
 * Mean colour of the middle fifth of each rect in a BGRA bitmap
 * (`NativeImage.toBitmap()` on Windows and macOS), alpha ignored.
 */
export function meanRectsFromBitmap(
  bitmap: Uint8Array,
  width: number,
  height: number,
  rects: readonly NormalizedRect[]
): RgbMean[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Not a bitmap size: ${width}x${height}`)
  }
  if (bitmap.length < width * height * 4) {
    throw new Error(`A ${width}x${height} BGRA bitmap needs ${width * height * 4} bytes`)
  }
  return rects.map((rect) => {
    const [x0, x1] = axis(rect.x, rect.w, width)
    const [y0, y1] = axis(rect.y, rect.h, height)
    let b = 0
    let g = 0
    let r = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        b += bitmap[i]
        g += bitmap[i + 1]
        r += bitmap[i + 2]
      }
    }
    const n = (x1 - x0) * (y1 - y0)
    return { r: r / n, g: g / n, b: b / n }
  })
}

/**
 * The stage rect (`#scene-root`'s client rect, CSS pixels) clipped to the
 * surface's viewport and rounded for `capturePage`, or null when nothing of
 * it is on screen.
 */
export function stageCaptureRect(
  stage: { left: number; top: number; width: number; height: number } | null | undefined,
  viewport: { width: number; height: number }
): { x: number; y: number; width: number; height: number } | null {
  if (!stage || ![stage.left, stage.top, stage.width, stage.height].every(Number.isFinite)) {
    return null
  }
  const left = Math.max(0, Math.round(stage.left))
  const top = Math.max(0, Math.round(stage.top))
  const right = Math.min(viewport.width, Math.round(stage.left + stage.width))
  const bottom = Math.min(viewport.height, Math.round(stage.top + stage.height))
  if (right - left < 1 || bottom - top < 1) {
    return null
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}
