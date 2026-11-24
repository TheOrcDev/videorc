/**
 * Plan 260 (from plan 220 S3.0b): the pictures of `scripts/gpui-baseline.mjs compare`. A
 * small PNG reader and writer (8-bit RGB or RGBA, not interlaced: what
 * Electron's `capturePage` and the GPUI app's `capture-page` write), the
 * side-by-side pair a slice looks at (the Electron baseline, the GPUI app's
 * shot, and where they differ), and the pixel report that goes with it.
 *
 * The report is information for the eye, never a gate: the gate is the
 * agent and the owner looking at every pair (plan 260, "Verification").
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** A channel that moves more than this counts the pixel as different. */
export const DIFF_THRESHOLD = 16
/** The gap between the pair's pictures, in pixels. */
const GAP = 16

/** `{ width, height, rgba }` from PNG bytes; throws naming what it cannot read. */
export function decodePng(bytes) {
  const data = Buffer.from(bytes)
  if (data.length < 8 || !data.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG.')
  let offset = 8
  let header = null
  const idat = []
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12]
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
  }
  if (!header) throw new Error('The PNG has no IHDR.')
  const { width, height, depth, colorType, interlace } = header
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(
      `Only 8-bit RGB or RGBA PNGs without interlace are read (this one: depth ${depth}, colour type ${colorType}, interlace ${interlace}).`
    )
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < height * (stride + 1)) throw new Error('The PNG data is short.')
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = y * stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[out + x - channels] : 0
      const b = y > 0 ? pixels[out - stride + x] : 0
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0
      let value = row[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`)
      pixels[out + x] = value & 0xff
    }
  }
  if (channels === 4) return { width, height, rgba: pixels }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i]
    rgba[j + 1] = pixels[i + 1]
    rgba[j + 2] = pixels[i + 2]
    rgba[j + 3] = 255
  }
  return { width, height, rgba }
}

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed) >>> 0)
  return Buffer.concat([length, typed, crc])
}

/** PNG bytes for an RGBA picture. */
export function encodePng({ width, height, rgba }) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`${rgba.length} bytes is not a ${width}x${height} RGBA picture.`)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** `picture` at `width`x`height`, nearest neighbour (a size mismatch, for the eye). */
export function resizeNearest(picture, width, height) {
  if (picture.width === width && picture.height === height) return picture
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(picture.height - 1, Math.floor((y * picture.height) / height))
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(picture.width - 1, Math.floor((x * picture.width) / width))
      const from = (sy * picture.width + sx) * 4
      const to = (y * width + x) * 4
      picture.rgba.copy(rgba, to, from, from + 4)
    }
  }
  return { width, height, rgba }
}

/**
 * The pixel report of `gpui` against `baseline` (resized to the baseline's
 * size first when they differ), and the difference picture: red where a
 * channel moved more than `DIFF_THRESHOLD`, the baseline dimmed elsewhere.
 */
export function comparePictures(baseline, gpui) {
  const sizeMatch = baseline.width === gpui.width && baseline.height === gpui.height
  const other = resizeNearest(gpui, baseline.width, baseline.height)
  const pixels = baseline.width * baseline.height
  const diff = Buffer.alloc(pixels * 4)
  let differing = 0
  let total = 0
  let max = 0
  for (let i = 0; i < pixels; i += 1) {
    const p = i * 4
    let delta = 0
    for (let channel = 0; channel < 3; channel += 1) {
      delta = Math.max(delta, Math.abs(baseline.rgba[p + channel] - other.rgba[p + channel]))
    }
    total += delta
    if (delta > max) max = delta
    if (delta > DIFF_THRESHOLD) {
      differing += 1
      diff[p] = 255
      diff[p + 1] = 0
      diff[p + 2] = 0
    } else {
      const grey =
        (baseline.rgba[p] * 0.3 + baseline.rgba[p + 1] * 0.59 + baseline.rgba[p + 2] * 0.11) * 0.35
      diff[p] = grey
      diff[p + 1] = grey
      diff[p + 2] = grey
    }
    diff[p + 3] = 255
  }
  return {
    report: {
      baselineSize: { width: baseline.width, height: baseline.height },
      gpuiSize: { width: gpui.width, height: gpui.height },
      sizeMatch,
      differingPixels: differing,
      differingShare: pixels > 0 ? Number((differing / pixels).toFixed(4)) : 0,
      meanDelta: pixels > 0 ? Number((total / pixels).toFixed(2)) : 0,
      maxDelta: max,
      threshold: DIFF_THRESHOLD
    },
    diff: { width: baseline.width, height: baseline.height, rgba: diff }
  }
}

/** Pictures side by side, left to right, on a neutral grey. */
export function sideBySide(pictures) {
  const width =
    pictures.reduce((sum, picture) => sum + picture.width, 0) + GAP * (pictures.length - 1)
  const height = Math.max(...pictures.map((picture) => picture.height))
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 128
    rgba[i + 1] = 128
    rgba[i + 2] = 128
    rgba[i + 3] = 255
  }
  let left = 0
  for (const picture of pictures) {
    for (let y = 0; y < picture.height; y += 1) {
      picture.rgba.copy(
        rgba,
        (y * width + left) * 4,
        y * picture.width * 4,
        (y + 1) * picture.width * 4
      )
    }
    left += picture.width + GAP
  }
  return { width, height, rgba }
}

/**
 * The pair a slice looks at: the baseline, the GPUI shot (at the baseline's
 * size) and the difference, side by side; and the report.
 */
export function pairOf(baselineBytes, gpuiBytes) {
  const baseline = decodePng(baselineBytes)
  const gpui = decodePng(gpuiBytes)
  const { report, diff } = comparePictures(baseline, gpui)
  const pair = sideBySide([baseline, resizeNearest(gpui, baseline.width, baseline.height), diff])
  return { report, png: encodePng(pair) }
}

/** `idle-1280x800-dark-contrast`: the baseline's shot name (S0.10) without `.png`. */
export function shotStem({ state, width, height, theme, contrast }) {
  return `${state}-${width}x${height}-${theme}${contrast === 'more' ? '-contrast' : ''}`
}

/** `gpui/s2.3a-preview-element` → `s2.3a`; anything else → `adhoc`. */
export function sliceOfBranch(branch) {
  const match = /^gpui\/(s\d+(?:[.-]\d+)?[a-z]?)(?:-|$)/i.exec(String(branch ?? '').trim())
  return match ? match[1].toLowerCase().replace('-', '.') : 'adhoc'
}
