// Plan 091 S1: ghostexParity for probe:ui-glass.
//
// With the clear glass the material is a neutral blur, so what a window
// region shows over a flat backdrop is the region's coats composited over
// the backdrop colour. The probe reads each coat's computed colour from the
// page (the base tone and the cover, as Chromium resolved them), captures a
// patch of the bare backdrop beside the window in the same pass, and
// predicts the sample: coat over coat over reference, mixed in 8-bit sRGB
// like the compositor. The distance between the prediction and the capture
// is the parity; the capture-vs-capture reference cancels the display's
// colour pipeline the same way neutrality does.

import { colorDistance, oklchLightness } from './image-stats.mjs'

const LINEAR_SRGB_FROM_OKLAB = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701]
]

function encodeSrgb(linear) {
  const clamped = Math.max(0, Math.min(1, linear))
  return (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255
}

/** OKLCH (L 0–1, C, h degrees) to 8-bit sRGB, gamut-clipped per channel. */
export function oklchToSrgb(l, c, h) {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const lms = [l_ ** 3, m_ ** 3, s_ ** 3]
  const [r, g, bb] = LINEAR_SRGB_FROM_OKLAB.map((row) =>
    encodeSrgb(row[0] * lms[0] + row[1] * lms[1] + row[2] * lms[2])
  )
  return { r, g, b: bb }
}

function number(token) {
  const value = Number.parseFloat(token)
  if (!Number.isFinite(value)) throw new Error(`Not a number in a CSS colour: ${token}`)
  return token.trim().endsWith('%') ? value / 100 : value
}

/**
 * A computed CSS colour (`getComputedStyle(...).backgroundColor`) as 8-bit
 * sRGB plus alpha: `oklch(L C H / A)` (how Chromium serialises the tokens),
 * `rgb()` / `rgba()`, `color(srgb r g b / a)` and `transparent`.
 */
export function parseCssColor(text) {
  const trimmed = String(text).trim()
  if (trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const match = /^(oklch|rgba?|color)\((.*)\)$/i.exec(trimmed)
  if (!match) throw new Error(`Unsupported CSS colour: ${text}`)
  const kind = match[1].toLowerCase()
  const [body, alphaText] = match[2].split('/')
  let tokens = body.trim().split(/[\s,]+/)
  if (kind === 'color') {
    if (tokens[0] !== 'srgb') throw new Error(`Unsupported colour space: ${text}`)
    tokens = tokens.slice(1)
  }
  if (tokens.length < 3) throw new Error(`Unsupported CSS colour: ${text}`)
  let alpha = alphaText !== undefined ? number(alphaText) : 1
  if ((kind === 'rgb' || kind === 'rgba') && tokens.length === 4 && alphaText === undefined) {
    alpha = number(tokens[3])
  }
  if (kind === 'oklch') {
    const l = tokens[0].endsWith('%') ? number(tokens[0]) : Number.parseFloat(tokens[0])
    return {
      ...oklchToSrgb(l, Number.parseFloat(tokens[1]), Number.parseFloat(tokens[2])),
      a: alpha
    }
  }
  if (kind === 'color') {
    return {
      r: number(tokens[0]) * 255,
      g: number(tokens[1]) * 255,
      b: number(tokens[2]) * 255,
      a: alpha
    }
  }
  return {
    r: Number.parseFloat(tokens[0]),
    g: Number.parseFloat(tokens[1]),
    b: Number.parseFloat(tokens[2]),
    a: alpha
  }
}

/** `source` (with alpha) over `destination`, mixed per channel in 8-bit sRGB. */
export function blendOver(destination, source) {
  const a = source.a ?? 1
  return {
    r: source.r * a + destination.r * (1 - a),
    g: source.g * a + destination.g * (1 - a),
    b: source.b * a + destination.b * (1 - a)
  }
}

/** The colour a stack of coats (body first) paints over the backdrop reference. */
export function expectedGlassColor(reference, coats) {
  return coats.reduce((below, coat) => blendOver(below, coat), reference)
}

/** The cover a stack of coats composites to (1 - product of transmissions). */
export function compositeCover(coats) {
  return 1 - coats.reduce((through, coat) => through * (1 - (coat.a ?? 1)), 1)
}

/**
 * ghostexParity for one sample: the RGB distance between the captured mean
 * and the prediction, per backdrop and at worst, with the OKLCH L of both.
 */
export function parityOf({ sampleMeans, referenceMeans, coats, backdrops = ['white', 'black'] }) {
  const byBackdrop = {}
  const lightness = {}
  for (const variant of backdrops) {
    if (!sampleMeans[variant] || !referenceMeans[variant]) {
      throw new Error(`parity: no ${variant} sample or reference.`)
    }
    const expected = expectedGlassColor(referenceMeans[variant], coats)
    byBackdrop[variant] = colorDistance(sampleMeans[variant], expected)
    lightness[variant] = {
      measured: oklchLightness(sampleMeans[variant]),
      expected: oklchLightness(expected)
    }
  }
  return {
    max: Math.max(...Object.values(byBackdrop)),
    byBackdrop,
    lightness,
    cover: compositeCover(coats)
  }
}
