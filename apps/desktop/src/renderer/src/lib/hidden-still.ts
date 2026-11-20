// Hide screen's still (owner, live show 2026-11-20: "make it look good, nice,
// and like some gradients, like a glassy thing, but without transparency").
//
// One designed picture, a pure function of the frame's size: a calm diagonal
// gradient, two soft glows, a glassy diagonal sheen, and a glass disc with the
// Hide screen eye in the middle. It is fully opaque and never reads the
// screen, so nothing of what was hidden shows through it.
//
// The same arithmetic, step for step, draws it everywhere: the backend for
// the recording, every stream leg, Clips, the Screen file, the Preview and
// Videorc Camera (screen_privacy.rs `hidden_still_bgra`), this file for the
// Show stage and the Program preview in a room, and the web's program and
// guest pages (lib/cloud/program/hidden-still.ts). The fixture
// protocol-fixtures/hidden-screen-still.json pins all three to the same
// pixels (each within one level for the platform's `exp`).
//
// Every neighbouring pair of pixels differs by less than HIDDEN_STILL_EDGE_MAX
// summed over R, G and B, so the smokes that call a frame hidden when it has
// almost no hard edges read the still as hidden at any size.

/** The hard-edge threshold of the smokes is 200; the still stays under this. */
export const HIDDEN_STILL_EDGE_MAX = 190

type Rgb = readonly [number, number, number]

/** The diagonal gradient: top left, middle, bottom right (sRGB). */
const TOP_LEFT: Rgb = [46, 56, 88]
const MIDDLE: Rgb = [30, 33, 54]
const BOTTOM_RIGHT: Rgb = [38, 28, 58]
/** Corners darken by this much. */
const VIGNETTE = 0.16
/** A cool glow at the top left and a violet one at the bottom right. */
const GLOWS: readonly { u: number; v: number; sigma: number; rgb: Rgb }[] = [
  { u: 0.22, v: 0.06, sigma: 0.42, rgb: [22, 34, 60] },
  { u: 0.86, v: 0.98, sigma: 0.36, rgb: [30, 18, 46] }
]
/** The glass sheen: lightening bands across the "/" diagonal, in min-side units. */
const SHEEN: readonly { at: number; sigma: number; amount: number }[] = [
  { at: -0.3, sigma: 0.16, amount: 0.05 },
  { at: -0.19, sigma: 0.012, amount: 0.03 },
  { at: 0.46, sigma: 0.03, amount: 0.018 }
]
/** The glass disc, in min-side units. */
const DISC_RADIUS = 0.118
const DISC_RIM = 0.0028
const DISC_FILL = 0.05
const DISC_FILL_TOP = 0.035
const DISC_RIM_BASE = 0.06
const DISC_RIM_TOP = 0.16
/** The eye with a slash (Hide screen's icon), in min-side units. */
const EYE_HALF_WIDTH = 0.058
const EYE_HALF_HEIGHT = 0.034
const EYE_STROKE = 0.0085
const PUPIL_RADIUS = 0.0155
const SLASH_X = 0.05
const SLASH_Y = 0.054
const SLASH_GAP = 0.0075
const ICON_AMOUNT = 0.3
/** 4×4 ordered dither, against banding in the encoder. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const h = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  const ex = px - ax - dx * h
  const ey = py - ay - dy * h
  return Math.sqrt(ex * ex + ey * ey)
}

/** Signed distance to a horizontal lens (the eye's outline). */
function eyeDistance(px: number, py: number): number {
  const a = EYE_HALF_WIDTH
  const b = EYE_HALF_HEIGHT
  // Two circles of radius r, centres d above and below, tips at ±a.
  const r = (a * a + b * b) / (2 * b)
  const d = r - b
  const qx = Math.abs(py)
  const qy = Math.abs(px)
  if ((qy - a) * d > qx * a) {
    const ex = qx
    const ey = qy - a
    return Math.sqrt(ex * ex + ey * ey)
  }
  const ex = qx + d
  return Math.sqrt(ex * ex + qy * qy) - r
}

/**
 * The still at `width`×`height`, RGBA with tight rows, opaque. Empty for an
 * empty size.
 */
export function hiddenStillRgba(width: number, height: number): Uint8ClampedArray {
  const w = Math.max(0, Math.floor(width))
  const h = Math.max(0, Math.floor(height))
  const out = new Uint8ClampedArray(w * h * 4)
  if (w === 0 || h === 0) return out
  const unit = Math.min(w, h)

  // Separable parts, one table per axis.
  const tu = new Float64Array(w)
  const vu = new Float64Array(w)
  const tv = new Float64Array(h)
  const vv = new Float64Array(h)
  for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w
    tu[x] = u / 2
    vu[x] = (2 * u - 1) * (2 * u - 1)
  }
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h
    tv[y] = v / 2
    vv[y] = (2 * v - 1) * (2 * v - 1)
  }
  const glowX = GLOWS.map(({ u, sigma }) => {
    const table = new Float64Array(w)
    for (let x = 0; x < w; x++) {
      const g = (x + 0.5 - u * w) / unit
      table[x] = Math.exp(-(g * g) / (2 * sigma * sigma))
    }
    return table
  })
  const glowY = GLOWS.map(({ v, sigma }) => {
    const table = new Float64Array(h)
    for (let y = 0; y < h; y++) {
      const g = (y + 0.5 - v * h) / unit
      table[y] = Math.exp(-(g * g) / (2 * sigma * sigma))
    }
    return table
  })
  // The sheen depends on x + y only.
  const sheen = new Float64Array(w + h - 1)
  for (let k = 0; k < sheen.length; k++) {
    const s = (k + 1 - (w + h) / 2) / (unit * Math.SQRT2)
    let amount = 0
    for (const band of SHEEN) {
      const e = s - band.at
      amount += band.amount * Math.exp(-(e * e) / (2 * band.sigma * band.sigma))
    }
    sheen[k] = amount
  }

  const [g0, g1] = GLOWS
  const [x0, x1] = glowX
  const [y0, y1] = glowY
  if (!g0 || !g1 || !x0 || !x1 || !y0 || !y1) return out
  const reach = DISC_RADIUS + 2 / unit
  for (let y = 0; y < h; y++) {
    const py = (y + 0.5 - h / 2) / unit
    const rowT = tv[y] ?? 0
    const rowV = vv[y] ?? 0
    const rowG0 = y0[y] ?? 0
    const rowG1 = y1[y] ?? 0
    const nearY = Math.abs(py) < reach
    for (let x = 0; x < w; x++) {
      const t = (tu[x] ?? 0) + rowT
      const low = t < 0.5
      const f = low ? t * 2 : t * 2 - 1
      const vignette = 1 - (VIGNETTE * ((vu[x] ?? 0) + rowV)) / 2
      const e0 = (x0[x] ?? 0) * rowG0
      const e1 = (x1[x] ?? 0) * rowG1
      const lift = sheen[x + y] ?? 0
      let r =
        (low
          ? TOP_LEFT[0] + (MIDDLE[0] - TOP_LEFT[0]) * f
          : MIDDLE[0] + (BOTTOM_RIGHT[0] - MIDDLE[0]) * f) * vignette
      let g =
        (low
          ? TOP_LEFT[1] + (MIDDLE[1] - TOP_LEFT[1]) * f
          : MIDDLE[1] + (BOTTOM_RIGHT[1] - MIDDLE[1]) * f) * vignette
      let b =
        (low
          ? TOP_LEFT[2] + (MIDDLE[2] - TOP_LEFT[2]) * f
          : MIDDLE[2] + (BOTTOM_RIGHT[2] - MIDDLE[2]) * f) * vignette
      r = r + g0.rgb[0] * e0 + g1.rgb[0] * e1
      g = g + g0.rgb[1] * e0 + g1.rgb[1] * e1
      b = b + g0.rgb[2] * e0 + g1.rgb[2] * e1
      r = r + (255 - r) * lift
      g = g + (255 - g) * lift
      b = b + (255 - b) * lift

      const px = (x + 0.5 - w / 2) / unit
      if (nearY && Math.abs(px) < reach) {
        const d = Math.sqrt(px * px + py * py)
        const top = clamp01(0.5 - py / (2 * DISC_RADIUS))
        const inside = clamp01(0.5 - (d - DISC_RADIUS) * unit)
        const rim = clamp01(0.5 - (Math.abs(d - DISC_RADIUS) - DISC_RIM / 2) * unit)
        const slash = segmentDistance(px, py, -SLASH_X, -SLASH_Y, SLASH_X, SLASH_Y)
        const gap = clamp01((slash - EYE_STROKE / 2 - SLASH_GAP) * unit + 0.5)
        const eye = clamp01(0.5 - (Math.abs(eyeDistance(px, py)) - EYE_STROKE / 2) * unit)
        const pupil = clamp01(0.5 - (Math.abs(d - PUPIL_RADIUS) - EYE_STROKE / 2) * unit)
        const bar = clamp01(0.5 - (slash - EYE_STROKE / 2) * unit)
        const icon = Math.max(Math.max(eye, pupil) * gap, bar)
        for (const amount of [
          (DISC_FILL + DISC_FILL_TOP * top) * inside,
          (DISC_RIM_BASE + DISC_RIM_TOP * top) * rim,
          ICON_AMOUNT * icon
        ]) {
          r = r + (255 - r) * amount
          g = g + (255 - g) * amount
          b = b + (255 - b) * amount
        }
      }

      const dither = ((BAYER[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16 - 0.5
      const o = (y * w + x) * 4
      out[o] = Math.floor(r + 0.5 + dither)
      out[o + 1] = Math.floor(g + 0.5 + dither)
      out[o + 2] = Math.floor(b + 0.5 + dither)
      out[o + 3] = 255
    }
  }
  return out
}

/** A still is drawn at most this many rows tall; the page scales it up. */
export const HIDDEN_STILL_MAX_ROWS = 1080

/**
 * The still for a picture of `width`×`height` (the hidden screen's size), as
 * a PNG data URL drawn contained, as the screen was. At most `maxRows` tall,
 * the aspect kept. Null without a canvas.
 */
export function hiddenStillUrl(
  page: Document,
  width: number,
  height: number,
  maxRows = HIDDEN_STILL_MAX_ROWS
): string | null {
  const size = hiddenStillSize(width, height, maxRows)
  try {
    const canvas = page.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return null
    const image = context.createImageData(size.width, size.height)
    image.data.set(hiddenStillRgba(size.width, size.height))
    context.putImageData(image, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** The size a still is drawn at for a `width`×`height` picture (16:9 without one). */
export function hiddenStillSize(
  width: number,
  height: number,
  maxRows = HIDDEN_STILL_MAX_ROWS
): { width: number; height: number } {
  const known = width > 2 && height > 2
  const w = known ? width : 1920
  const h = known ? height : 1080
  const rows = Math.max(1, Math.min(Math.round(h), Math.floor(maxRows)))
  return { width: Math.max(1, Math.round((w * rows) / h)), height: rows }
}
