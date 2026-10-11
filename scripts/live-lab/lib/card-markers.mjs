import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cellRect,
  decodeCode,
  markerPaintList,
  markerRegions,
  pixelRect
} from '../card/marker-codec.mjs'

// Plan 178 U7. Decodes the test card's marker regions from one raw frame, so
// U9's frame checks can tell "this frame shows the card, at step N, scene S"
// without OCR. Feed it rgb24 (ffmpeg `-pix_fmt rgb24 -f rawvideo`) or rgba.

export const MARKERS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'card',
  'markers.json'
)

let cachedSpec = null

export function loadMarkerSpec(path = MARKERS_PATH) {
  if (path === MARKERS_PATH && cachedSpec) return cachedSpec
  const spec = JSON.parse(readFileSync(path, 'utf8'))
  if (spec.schemaVersion !== 1) throw new Error(`unsupported markers schema ${spec.schemaVersion}`)
  if (path === MARKERS_PATH) cachedSpec = spec
  return spec
}

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function meanLuma(frame, width, channels, rect) {
  let sum = 0
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    let offset = (y * width + rect.x) * channels
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      sum += luma(frame[offset], frame[offset + 1], frame[offset + 2])
      count += 1
      offset += channels
    }
  }
  return count === 0 ? 0 : sum / count
}

function inset(rect, fraction) {
  const dx = Math.floor(rect.width * fraction)
  const dy = Math.floor(rect.height * fraction)
  return {
    x: rect.x + dx,
    y: rect.y + dy,
    width: Math.max(1, rect.width - dx * 2),
    height: Math.max(1, rect.height - dy * 2)
  }
}

function frameMeanLuma(frame, width, height, channels) {
  // Every 4th pixel on every 4th row is plenty for a flash test.
  let sum = 0
  let count = 0
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = (y * width + x) * channels
      sum += luma(frame[offset], frame[offset + 1], frame[offset + 2])
      count += 1
    }
  }
  return count === 0 ? 0 : sum / count
}

/**
 * @param {Uint8Array} rgbFrame packed pixels, `channels` bytes each (3 or 4)
 * @param {number} width
 * @param {number} height
 * @param {{ spec?: object, channels?: number, cardRect?: {x:number,y:number,width:number,height:number} }} [options]
 *   `cardRect` is where the card sits in the frame, in pixels (default: the whole frame).
 * @returns {{ ok: boolean, aligned: boolean, fiducials: Record<string, boolean>,
 *   sceneId: number|null, step: number|null, flash: boolean, meanLuma: number,
 *   minMargin: number, errors: string[] }}
 */
export function decodeMarkers(rgbFrame, width, height, options = {}) {
  const spec = options.spec ?? loadMarkerSpec()
  const channels = options.channels ?? 3
  const card = options.cardRect ?? { x: 0, y: 0, width, height }
  if (!rgbFrame || rgbFrame.length < width * height * channels) {
    throw new Error(
      `frame holds ${rgbFrame?.length ?? 0} bytes, expected ${width * height * channels}`
    )
  }
  if (card.x < 0 || card.y < 0 || card.x + card.width > width || card.y + card.height > height) {
    throw new Error('cardRect lies outside the frame')
  }
  const { threshold, minMargin: requiredMargin, sampleInset, flashMeanLuma } = spec.luma
  const errors = []
  const fiducials = {}
  let sceneId = null
  let step = null
  let minMargin = Infinity

  for (const region of markerRegions(spec)) {
    const box = pixelRect(region.rect, card)
    const bits = []
    let ambiguous = 0
    for (let row = 0; row < region.rows; row += 1) {
      for (let col = 0; col < region.columns; col += 1) {
        const sample = inset(cellRect(box, region.columns, region.rows, col, row), sampleInset)
        const value = meanLuma(rgbFrame, width, channels, sample)
        const margin = Math.abs(value - threshold)
        minMargin = Math.min(minMargin, margin)
        if (margin < requiredMargin) ambiguous += 1
        bits.push(value >= threshold ? 1 : 0)
      }
    }
    if (ambiguous > 0)
      errors.push(`${region.name}: ${ambiguous} cell(s) too close to the threshold`)
    if (region.name.startsWith('fiducial.')) {
      const name = region.name.slice('fiducial.'.length)
      fiducials[name] = ambiguous === 0 && bits.every((bit, index) => bit === region.bits[index])
      if (!fiducials[name]) errors.push(`${region.name}: pattern does not match`)
      continue
    }
    const dataBits = spec.codes[region.name].dataBits
    const decoded = decodeCode(bits, dataBits)
    if (decoded.error || ambiguous > 0) {
      if (decoded.error) errors.push(`${region.name}: ${decoded.error}`)
      continue
    }
    if (region.name === 'scene') sceneId = decoded.value
    if (region.name === 'step') step = decoded.value
  }

  const aligned = Object.values(fiducials).every(Boolean)
  const mean = frameMeanLuma(rgbFrame, width, height, channels)
  return {
    ok: aligned && sceneId !== null && step !== null,
    aligned,
    fiducials,
    sceneId,
    step,
    flash: mean > flashMeanLuma,
    meanLuma: Math.round(mean * 10) / 10,
    minMargin: Number.isFinite(minMargin) ? Math.round(minMargin) : 0,
    errors
  }
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/**
 * A synthetic rgb24 frame with the card's markers painted exactly as the card
 * paints them (same paint list). For tests and for U9 baseline fixtures.
 */
export function renderMarkerFrame({
  width,
  height,
  sceneId = 0,
  stepIndex = 0,
  background = '#0d0d0f',
  cardRect,
  spec = loadMarkerSpec()
}) {
  const frame = new Uint8Array(width * height * 3)
  const [br, bg, bb] = hexToRgb(background)
  for (let index = 0; index < width * height; index += 1) {
    frame[index * 3] = br
    frame[index * 3 + 1] = bg
    frame[index * 3 + 2] = bb
  }
  const card = cardRect ?? { x: 0, y: 0, width, height }
  for (const rect of markerPaintList(spec, card, { sceneId, stepIndex })) {
    const [r, g, b] = hexToRgb(rect.color)
    for (let y = Math.max(0, rect.y); y < Math.min(height, rect.y + rect.height); y += 1) {
      for (let x = Math.max(0, rect.x); x < Math.min(width, rect.x + rect.width); x += 1) {
        const offset = (y * width + x) * 3
        frame[offset] = r
        frame[offset + 1] = g
        frame[offset + 2] = b
      }
    }
  }
  return frame
}
