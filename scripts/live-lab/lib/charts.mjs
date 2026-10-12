import { encodePng } from './png.mjs'

// Plan 178 U9 (plan 166 S8 step 2). Report charts rendered in pure JS: an
// RGB raster, a 5x7 bitmap font for labels and two chart kinds, a line chart
// (memory per role, bitrate, dropped frames, encoder speed) and a band
// timeline (YouTube health over time). No dependency, no browser: the lab
// machine writes PNGs straight into the run folder.

export const CHART_WIDTH = 960
export const CHART_HEIGHT = 320

// Series colours (dark-on-light, distinguishable in print).
export const PALETTE = Object.freeze([
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#be185d',
  '#4b5563'
])

const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010']
}

export function parseColor(hex) {
  const value = Number.parseInt(String(hex).replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** An RGB raster with the few drawing calls the charts need. */
export function createCanvas(width, height, background = '#ffffff') {
  const pixels = new Uint8Array(width * height * 3)
  const canvas = {
    width,
    height,
    pixels,
    fillRect(x, y, w, h, color) {
      const [r, g, b] = parseColor(color)
      const x0 = Math.max(0, Math.floor(x))
      const y0 = Math.max(0, Math.floor(y))
      const x1 = Math.min(width, Math.ceil(x + w))
      const y1 = Math.min(height, Math.ceil(y + h))
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) {
          const offset = (py * width + px) * 3
          pixels[offset] = r
          pixels[offset + 1] = g
          pixels[offset + 2] = b
        }
      }
    },
    line(x0, y0, x1, y1, color, thickness = 1) {
      const dx = Math.abs(x1 - x0)
      const dy = Math.abs(y1 - y0)
      const steps = Math.max(dx, dy, 1)
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps
        const x = x0 + (x1 - x0) * t
        const y = y0 + (y1 - y0) * t
        canvas.fillRect(x - thickness / 2, y - thickness / 2, thickness, thickness, color)
      }
    },
    text(x, y, value, color, scale = 1) {
      let cursor = Math.floor(x)
      for (const char of String(value).toUpperCase()) {
        const glyph = GLYPHS[char] ?? GLYPHS['?']
        for (let row = 0; row < 7; row += 1) {
          for (let col = 0; col < 5; col += 1) {
            if (glyph[row][col] === '1')
              canvas.fillRect(cursor + col * scale, y + row * scale, scale, scale, color)
          }
        }
        cursor += 6 * scale
      }
      return cursor - x
    },
    toPng: () => encodePng(width, height, pixels, { channels: 3 })
  }
  canvas.fillRect(0, 0, width, height, background)
  return canvas
}

export function textWidth(value, scale = 1) {
  return String(value).length * 6 * scale
}

function niceStep(range, ticks) {
  if (!(range > 0)) return 1
  const rough = range / Math.max(1, ticks)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (rough <= magnitude * factor) return magnitude * factor
  }
  return magnitude * 10
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '?'
  if (Math.abs(value) >= 1000) return `${Math.round(value)}`
  if (Math.abs(value) >= 10) return `${Math.round(value * 10) / 10}`
  return `${Math.round(value * 100) / 100}`
}

function formatMinutes(ms) {
  const minutes = ms / 60000
  if (minutes >= 120) return `${Math.round(minutes / 6) / 10}H`
  return `${Math.round(minutes)}M`
}

/**
 * A line chart. `series` = [{ name, points: [{ atMs, value }], color? }].
 * The x axis is minutes since the earliest point; `yMin`/`yMax` optional.
 * Returns { png, width, height, empty }.
 */
export function renderLineChart({
  title,
  unit = '',
  series = [],
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
  yMin = null,
  yMax = null,
  threshold = null
}) {
  const canvas = createCanvas(width, height)
  const left = 64
  const right = width - 16
  const top = 36
  const bottom = height - 40
  canvas.text(12, 10, title, '#111827', 2)
  const points = series.flatMap((entry) =>
    entry.points.filter((p) => Number.isFinite(p.atMs) && Number.isFinite(p.value))
  )
  if (points.length === 0) {
    canvas.text(left, top + 20, 'NO DATA', '#6b7280', 2)
    return { png: canvas.toPng(), width, height, empty: true }
  }
  const x0 = Math.min(...points.map((p) => p.atMs))
  const x1 = Math.max(...points.map((p) => p.atMs), x0 + 1)
  const values = points.map((p) => p.value)
  if (threshold !== null && Number.isFinite(threshold)) values.push(threshold)
  let lo = yMin ?? Math.min(...values)
  let hi = yMax ?? Math.max(...values)
  if (hi <= lo) hi = lo + 1
  if (yMin === null) lo = Math.min(lo, 0)
  const step = niceStep(hi - lo, 5)
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  const px = (atMs) => left + ((atMs - x0) / (x1 - x0)) * (right - left)
  const py = (value) => bottom - ((value - lo) / (hi - lo)) * (bottom - top)

  canvas.fillRect(left, top, right - left, bottom - top, '#f9fafb')
  for (let value = lo; value <= hi + step / 1000; value += step) {
    const y = py(value)
    canvas.line(left, y, right, y, '#e5e7eb')
    const label = formatNumber(value)
    canvas.text(left - 6 - textWidth(label), y - 3, label, '#4b5563')
  }
  const xTicks = 6
  for (let i = 0; i <= xTicks; i += 1) {
    const atMs = x0 + ((x1 - x0) * i) / xTicks
    const x = px(atMs)
    canvas.line(x, top, x, bottom, '#eef2f7')
    const label = formatMinutes(atMs - x0)
    canvas.text(x - textWidth(label) / 2, bottom + 6, label, '#4b5563')
  }
  canvas.line(left, bottom, right, bottom, '#9ca3af')
  canvas.line(left, top, left, bottom, '#9ca3af')
  if (unit) canvas.text(left, bottom + 20, unit, '#6b7280')
  if (threshold !== null && Number.isFinite(threshold)) {
    const y = py(threshold)
    for (let x = left; x < right; x += 8) canvas.line(x, y, x + 4, y, '#dc2626')
  }

  let legendX = left
  series.forEach((entry, index) => {
    const color = entry.color ?? PALETTE[index % PALETTE.length]
    const sorted = entry.points
      .filter((p) => Number.isFinite(p.atMs) && Number.isFinite(p.value))
      .sort((a, b) => a.atMs - b.atMs)
    for (let i = 1; i < sorted.length; i += 1) {
      canvas.line(
        px(sorted[i - 1].atMs),
        py(sorted[i - 1].value),
        px(sorted[i].atMs),
        py(sorted[i].value),
        color,
        2
      )
    }
    if (sorted.length === 1)
      canvas.fillRect(px(sorted[0].atMs) - 2, py(sorted[0].value) - 2, 4, 4, color)
    canvas.fillRect(legendX, 26, 8, 8, color)
    legendX += 12 + canvas.text(legendX + 12, 27, entry.name, '#374151') + 12
  })
  return { png: canvas.toPng(), width, height, empty: false }
}

/**
 * A band timeline: `bands` = [{ atMs, state }] in order; each state fills
 * until the next sample. `colors` maps state to colour; unknown states grey.
 */
export function renderTimeline({
  title,
  bands = [],
  colors = {},
  width = CHART_WIDTH,
  height = 120,
  endMs = null
}) {
  const canvas = createCanvas(width, height)
  const left = 16
  const right = width - 16
  const top = 36
  const bottom = height - 36
  canvas.text(12, 10, title, '#111827', 2)
  const samples = bands.filter((band) => Number.isFinite(band.atMs)).sort((a, b) => a.atMs - b.atMs)
  if (samples.length === 0) {
    canvas.text(left, top + 8, 'NO DATA', '#6b7280', 2)
    return { png: canvas.toPng(), width, height, empty: true }
  }
  const x0 = samples[0].atMs
  const x1 = Math.max(endMs ?? 0, samples.at(-1).atMs + 60_000, x0 + 1)
  const px = (atMs) => left + ((atMs - x0) / (x1 - x0)) * (right - left)
  canvas.fillRect(left, top, right - left, bottom - top, '#f3f4f6')
  samples.forEach((band, index) => {
    const next = samples[index + 1]?.atMs ?? x1
    const color = colors[band.state] ?? '#9ca3af'
    canvas.fillRect(px(band.atMs), top, Math.max(1, px(next) - px(band.atMs)), bottom - top, color)
  })
  const seen = new Set(samples.map((band) => band.state))
  let legendX = left
  for (const state of [...seen]) {
    canvas.fillRect(legendX, bottom + 8, 8, 8, colors[state] ?? '#9ca3af')
    legendX += 12 + canvas.text(legendX + 12, bottom + 9, String(state), '#374151') + 12
  }
  const span = formatMinutes(x1 - x0)
  canvas.text(right - textWidth(span), bottom + 9, span, '#4b5563')
  return { png: canvas.toPng(), width, height, empty: false }
}
