// Plan 210 D8's frost for a room's Hide screen (owner, 2026-11-19: hidden in
// a room looks the same as in the Studio, never a flat grey box). The same
// frost as the native one (screen_privacy.rs) and, paired, the web's
// lib/cloud/program/screen-privacy.ts: an area average down to at most
// FROST_MAX_HEIGHT rows, then a Gaussian blur of σ FROST_SIGMA px at that
// size; the caller draws the small still scaled back up, which the browser
// does bilinearly. Colours and shapes survive; text does not.
//
// The wire stays neutral (room-screen-privacy.ts): the host still publishes
// RGB 128 while hidden, so receivers' applied-frost acknowledgements keep
// certifying exactly that. This still is made from the last frame the host
// already published while visible; each receiver draws its own from the last
// frame it showed. Loaded with the room client only, never eagerly.

/** The frosted still is built from a picture at most this many rows tall. */
export const FROST_MAX_HEIGHT = 48
/** Gaussian σ, in pixels of the small picture. */
export const FROST_SIGMA = 2
/** A picture is read back at most this tall to make a still, once per hide. */
export const FROST_SAMPLE_ROWS = FROST_MAX_HEIGHT * 8

export type FrostedPixels = {
  width: number
  height: number
  /** RGBA, tight rows, opaque. */
  data: Uint8ClampedArray
}

/** The small picture's size for a `width`×`height` frame (`frost_plan`). */
export function frostPlan(width: number, height: number): { width: number; height: number } {
  const rows = Math.min(Math.max(height, 1), FROST_MAX_HEIGHT)
  const across = height <= 0 ? 1 : Math.floor((width * rows + Math.floor(height / 2)) / height)
  return { width: Math.min(Math.max(across, 1), Math.max(width, 1)), height: rows }
}

/** For each destination index, the source span it averages (exact coverage). */
function areaSpans(
  sourceLength: number,
  destLength: number
): { start: number; weights: number[] }[] {
  const scale = sourceLength / destLength
  return Array.from({ length: destLength }, (_, index) => {
    const from = index * scale
    const to = Math.min((index + 1) * scale, sourceLength)
    const start = Math.floor(from)
    const end = Math.min(Math.max(Math.ceil(to), start + 1), sourceLength)
    const weights: number[] = []
    for (let source = start; source < end; source++) {
      const lo = Math.max(source, from)
      const hi = Math.min(source + 1, to)
      weights.push(Math.max(hi - lo, 0) / Math.max(to - from, Number.EPSILON))
    }
    return { start, weights }
  })
}

/** A sample index reflected back into `0..length`, so a border blurs with
 * its own neighbourhood instead of a smeared edge column. */
function mirroredIndex(index: number, length: number): number {
  const last = length - 1
  if (last <= 0) return 0
  const period = 2 * last
  let i = ((index % period) + period) % period
  if (i > last) i = period - i
  return i
}

/** Separable Gaussian blur of RGB planes, with mirrored edges. */
function gaussianBlur(planes: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.ceil(3 * sigma)
  const kernel: number[] = []
  for (let x = -radius; x <= radius; x++) kernel.push(Math.exp(-(x * x) / (2 * sigma * sigma)))
  const sum = kernel.reduce((total, weight) => total + weight, 0)
  const weights = kernel.map((weight) => weight / sum)
  const pass = (from: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(w * h * 3)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0
        let g = 0
        let b = 0
        weights.forEach((weight, k) => {
          const base = horizontal
            ? (y * w + mirroredIndex(x + k - radius, w)) * 3
            : (mirroredIndex(y + k - radius, h) * w + x) * 3
          r += (from[base] ?? 0) * weight
          g += (from[base + 1] ?? 0) * weight
          b += (from[base + 2] ?? 0) * weight
        })
        const base = (y * w + x) * 3
        out[base] = r
        out[base + 1] = g
        out[base + 2] = b
      }
    return out
  }
  return pass(pass(planes, true), false)
}

/**
 * The frost of an RGBA frame with tight rows, at the small size, opaque.
 * A short buffer or an empty frame gives the neutral grey still.
 */
export function frostRgba(rgba: ArrayLike<number>, width: number, height: number): FrostedPixels {
  const { width: sw, height: sh } = frostPlan(width, height)
  const data = new Uint8ClampedArray(sw * sh * 4)
  if (width < 1 || height < 1 || rgba.length < width * height * 4) {
    for (let i = 0; i < data.length; i += 4) data.set([128, 128, 128, 255], i)
    return { width: sw, height: sh, data }
  }
  const across = areaSpans(width, sw)
  const narrow = new Float32Array(sw * height * 3)
  for (let y = 0; y < height; y++)
    across.forEach(({ start, weights }, dx) => {
      let r = 0
      let g = 0
      let b = 0
      weights.forEach((weight, k) => {
        const i = (y * width + start + k) * 4
        r += (rgba[i] ?? 0) * weight
        g += (rgba[i + 1] ?? 0) * weight
        b += (rgba[i + 2] ?? 0) * weight
      })
      const base = (y * sw + dx) * 3
      narrow[base] = r
      narrow[base + 1] = g
      narrow[base + 2] = b
    })
  const small = new Float32Array(sw * sh * 3)
  areaSpans(height, sh).forEach(({ start, weights }, dy) => {
    weights.forEach((weight, k) => {
      const from = (start + k) * sw * 3
      const to = dy * sw * 3
      for (let x = 0; x < sw * 3; x++)
        small[to + x] = (small[to + x] ?? 0) + (narrow[from + x] ?? 0) * weight
    })
  })
  const blurred = gaussianBlur(small, sw, sh, FROST_SIGMA)
  for (let i = 0, o = 0; i < blurred.length; i += 3, o += 4) {
    data[o] = Math.floor((blurred[i] ?? 0) + 0.5)
    data[o + 1] = Math.floor((blurred[i + 1] ?? 0) + 0.5)
    data[o + 2] = Math.floor((blurred[i + 2] ?? 0) + 0.5)
    data[o + 3] = 255
  }
  return { width: sw, height: sh, data }
}

/** Every pixel is the wire's neutral grey: nothing of a screen to frost. */
function allNeutral(data: ArrayLike<number>): boolean {
  for (let i = 0; i < data.length; i += 4)
    if (
      Math.abs((data[i] ?? 0) - 128) > 5 ||
      Math.abs((data[i + 1] ?? 0) - 128) > 5 ||
      Math.abs((data[i + 2] ?? 0) - 128) > 5
    )
      return false
  return true
}

/** A picture to frost, at its own size. */
export type FrostSource = { image: CanvasImageSource; width: number; height: number }

/**
 * Keeps a small copy of what `source` shows now in `into`, at most
 * FROST_SAMPLE_ROWS tall: a blit, never a read back, so the hide that calls it
 * stays synchronous and cheap. False, and `into` unchanged, with no picture.
 */
export function keepFrostSample(into: HTMLCanvasElement, source: FrostSource): boolean {
  if (!(source.width > 2 && source.height > 2)) return false
  const rows = Math.min(Math.round(source.height), FROST_SAMPLE_ROWS)
  const columns = Math.max(1, Math.round((source.width * rows) / source.height))
  const context = into.getContext('2d')
  if (!context) return false
  try {
    if (into.width !== columns) into.width = columns
    if (into.height !== rows) into.height = rows
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source.image, 0, 0, columns, rows)
    return true
  } catch {
    return false
  }
}

/**
 * The frosted still of a kept sample, as a PNG data URL the Show stage draws
 * scaled up (contained, as the screen was). Null when the sample shows only
 * the wire's grey or cannot be read: the stage keeps the grey it has.
 */
export function frostedStillUrl(page: Document, sample: HTMLCanvasElement): string | null {
  if (!(sample.width > 0 && sample.height > 0)) return null
  try {
    const context = sample.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    const frosted = frostRgba(
      context.getImageData(0, 0, sample.width, sample.height).data,
      sample.width,
      sample.height
    )
    if (allNeutral(frosted.data)) return null
    const still = page.createElement('canvas')
    still.width = frosted.width
    still.height = frosted.height
    const out = still.getContext('2d')
    if (!out) return null
    const image = out.createImageData(frosted.width, frosted.height)
    image.data.set(frosted.data)
    out.putImageData(image, 0, 0)
    return still.toDataURL('image/png')
  } catch {
    return null
  }
}
