// Plan 212 S1: decode the frame-number strip the backend draws on every
// synthetic test-pattern tile (`crates/videorc-backend/src/synthetic_diagnostic.rs`,
// `overlay_frame_markers`): 16 cells across the full tile width, three tile
// rows tall at the top, each cell pure white (bit set) or pure black (bit
// clear), most significant bit on the left. Both the plain 64x64 pattern and
// the benchmark's quarter-canvas noise carry it, and a full-frame
// test-pattern source scales the tile to the canvas, so on a presented frame
// the strip is the top ~0.5% (noise) to ~5% (plain pattern) of the height.
//
// A caller samples the mean colour of the middle of each cell (the
// `preview.debug.sample` oracle, or a decoded recording frame) and asks
// whether those 16 means are a strip. Pure functions, no I/O.

export const STRIP_BITS = 16

/** A cell darker than this is a 0 bit (a 2 px strip blends with the noise below it). */
export const STRIP_BLACK_MAX = 80
/** A cell brighter than this is a 1 bit. */
export const STRIP_WHITE_MIN = 160

/**
 * Sixteen rects (canvas fractions) covering the strip's cells at the very top
 * of the frame. `preview.debug.sample` reads the middle fifth of each rect, so
 * with `h = 0.005` the sampled band is 0.2% to 0.3% of the height: inside the
 * noise strip at 2160, 1440, 1080, 720 and 360 lines alike, and clear of the
 * frame-number digits drawn under it.
 */
export function syntheticStripRects({ height = 0.005 } = {}) {
  return Array.from({ length: STRIP_BITS }, (_, bit) => ({
    x: bit / STRIP_BITS,
    y: 0,
    w: 1 / STRIP_BITS,
    h: height
  }))
}

function luma(sample) {
  const [r, g, b] = Array.isArray(sample) ? sample : [sample.r, sample.g, sample.b]
  if (![r, g, b].every((v) => Number.isFinite(v))) return Number.NaN
  return (r * 299 + g * 587 + b * 114) / 1000
}

/**
 * Decode 16 cell means (`{r,g,b}` or `[r,g,b]`, MSB first) as the synthetic
 * strip. Synthetic only when every cell is near-black or near-white and the
 * cells are not all the same: a flat black or white picture is not a strip,
 * and neither is a camera, a gradient or random noise (mid-grey means).
 *
 * @returns {{ synthetic: boolean, sequence?: number, reason?: string }}
 */
export function decodeSyntheticStrip(cells) {
  if (!Array.isArray(cells) || cells.length !== STRIP_BITS) {
    return { synthetic: false, reason: `expected ${STRIP_BITS} cells` }
  }
  let sequence = 0
  let ones = 0
  for (const [index, cell] of cells.entries()) {
    const y = luma(cell)
    if (Number.isNaN(y)) return { synthetic: false, reason: `cell ${index} is not a colour` }
    if (y >= STRIP_WHITE_MIN) {
      sequence |= 1 << (STRIP_BITS - 1 - index)
      ones++
    } else if (y > STRIP_BLACK_MAX) {
      return { synthetic: false, reason: `cell ${index} is mid-tone (${y.toFixed(1)})` }
    }
  }
  if (ones === 0 || ones === STRIP_BITS) {
    return { synthetic: false, reason: ones === 0 ? 'all cells black' : 'all cells white' }
  }
  return { synthetic: true, sequence: sequence >>> 0 }
}

/**
 * Mean colour of the middle fifth of each rect (canvas fractions) in a packed
 * RGB24 frame, the same window `preview.debug.sample` reads, so a decoded
 * recording frame and a presented Preview frame are judged alike.
 *
 * @returns {Array<[number, number, number]>}
 */
export function meanRectsRgb24(rgb, width, height, rects) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Not a frame size: ${width}x${height}`)
  }
  if (rgb.length < width * height * 3) {
    throw new Error(`RGB24 frame of ${width}x${height} needs ${width * height * 3} bytes`)
  }
  const axis = (start, size, pixels) => {
    const lo = Math.min(Math.max(Math.floor((start + size * 0.4) * pixels), 0), pixels - 1)
    const hi = Math.min(Math.max(Math.ceil((start + size * 0.6) * pixels), lo + 1), pixels)
    return [lo, hi]
  }
  return rects.map((rect) => {
    const [x0, x1] = axis(rect.x, rect.w, width)
    const [y0, y1] = axis(rect.y, rect.h, height)
    const sum = [0, 0, 0]
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 3
        sum[0] += rgb[i]
        sum[1] += rgb[i + 1]
        sum[2] += rgb[i + 2]
      }
    }
    const n = (x1 - x0) * (y1 - y0)
    return [sum[0] / n, sum[1] / n, sum[2] / n]
  })
}
