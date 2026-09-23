// Pixel statistics for real-composited window captures (probe:ui-glass).
//
// `screencapture -R` writes 8-bit PNGs; this decodes them without a new
// dependency (zlib + the five PNG scanline filters) and measures a sample
// rect: its mean colour, how much sharp detail survives in it (the Laplacian
// variance: blurred glass ~0, legible text behind a translucent coat >> 0),
// and the WCAG contrast of text tokens against the measured colour.

import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** Decodes an 8-bit, non-interlaced PNG into RGBA. */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file.')
  }
  let offset = 8
  let header = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (!header) throw new Error('PNG has no IHDR chunk.')
  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType]
  if (header.bitDepth !== 8 || !channels || header.interlace !== 0) {
    throw new Error(
      `Unsupported PNG (bit depth ${header.bitDepth}, colour type ${header.colorType}, interlace ${header.interlace}).`
    )
  }
  const { width, height } = header
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const source = y * (stride + 1) + 1
    const row = y * stride
    const previous = row - stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]
      const left = x >= channels ? pixels[row + x - channels] : 0
      const up = y > 0 ? pixels[previous + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[previous + x - channels] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) predicted = paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`)
      pixels[row + x] = (value + predicted) & 0xff
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const base = index * channels
    const target = index * 4
    if (channels === 1 || channels === 2) {
      data[target] = data[target + 1] = data[target + 2] = pixels[base]
      data[target + 3] = channels === 2 ? pixels[base + 1] : 255
    } else {
      data[target] = pixels[base]
      data[target + 1] = pixels[base + 1]
      data[target + 2] = pixels[base + 2]
      data[target + 3] = channels === 4 ? pixels[base + 3] : 255
    }
  }
  return { width, height, data }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/** Clamps a rect (image pixels) to the image bounds; throws when empty. */
export function clampRect(image, rect) {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(image.width, Math.floor(rect.x + rect.width))
  const bottom = Math.min(image.height, Math.floor(rect.y + rect.height))
  if (right - x < 3 || bottom - y < 3) {
    throw new Error(
      `Sample rect ${JSON.stringify(rect)} is outside the ${image.width}x${image.height} image.`
    )
  }
  return { x, y, width: right - x, height: bottom - y }
}

/** Mean sRGB colour (0–255 per channel) of a rect. */
export function regionMean(image, rect) {
  const area = clampRect(image, rect)
  let r = 0
  let g = 0
  let b = 0
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const index = (y * image.width + x) * 4
      r += image.data[index]
      g += image.data[index + 1]
      b += image.data[index + 2]
    }
  }
  const count = area.width * area.height
  return { r: r / count, g: g / count, b: b / count }
}

/**
 * Variance of the 4-neighbour Laplacian of luma (0–255) inside a rect: a
 * sharpness measure. A heavily blurred backdrop scores near zero; text that
 * shows through a translucent coat unblurred scores high even when faint.
 */
export function laplacianVariance(image, rect) {
  const area = clampRect(image, rect)
  const luma = (x, y) => {
    const index = (y * image.width + x) * 4
    return (
      0.2126 * image.data[index] + 0.7152 * image.data[index + 1] + 0.0722 * image.data[index + 2]
    )
  }
  let sum = 0
  let sumSquares = 0
  let count = 0
  for (let y = area.y + 1; y < area.y + area.height - 1; y += 1) {
    for (let x = area.x + 1; x < area.x + area.width - 1; x += 1) {
      const value =
        luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1) - 4 * luma(x, y)
      sum += value
      sumSquares += value * value
      count += 1
    }
  }
  const mean = sum / count
  return sumSquares / count - mean * mean
}

/** Euclidean distance between two sRGB colours (0–441.7). */
export function colorDistance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

function linearChannel(value) {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance (0–1) of an sRGB colour. */
export function relativeLuminance({ r, g, b }) {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b)
}

/** WCAG contrast ratio (1–21) between two sRGB colours. */
export function contrastRatio(a, b) {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** '#F4F4F5' → { r, g, b }. */
export function parseHexColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`Not a #RRGGBB colour: ${hex}`)
  const value = Number.parseInt(match[1], 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}
