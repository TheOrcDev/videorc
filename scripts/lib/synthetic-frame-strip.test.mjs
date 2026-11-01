// Run: node --test scripts/lib/synthetic-frame-strip.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STRIP_BITS,
  decodeSyntheticStrip,
  meanRectsRgb24,
  syntheticStripRects
} from './synthetic-frame-strip.mjs'

/**
 * An RGB24 frame the way the backend's noise tile lands on a canvas: per-pixel
 * noise everywhere, and the 16-cell strip (MSB left) over the top `stripRows`
 * lines, each cell `width / 16` wide. Deterministic noise (xorshift).
 */
function noiseFrameWithStrip(width, height, sequence, stripRows = 12) {
  const rgb = new Uint8Array(width * height * 3)
  let state = 0x9e3779b9
  for (let i = 0; i < rgb.length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    rgb[i] = state & 0xff
  }
  const cellWidth = Math.floor(width / STRIP_BITS)
  for (let bit = 0; bit < STRIP_BITS; bit++) {
    const set = (sequence & (1 << (STRIP_BITS - 1 - bit))) !== 0
    const value = set ? 255 : 0
    for (let y = 0; y < stripRows; y++) {
      for (let x = bit * cellWidth; x < (bit + 1) * cellWidth; x++) {
        const i = (y * width + x) * 3
        rgb[i] = rgb[i + 1] = rgb[i + 2] = value
      }
    }
  }
  return rgb
}

test('decodes a synthesized strip over noise at the oracle rects', () => {
  for (const sequence of [1, 2, 0x5a5a, 0xabcd, 0x8000, 0xfffe]) {
    const frame = noiseFrameWithStrip(640, 360, sequence, 2)
    const cells = meanRectsRgb24(frame, 640, 360, syntheticStripRects())
    assert.deepEqual(
      decodeSyntheticStrip(cells),
      { synthetic: true, sequence },
      `sequence ${sequence.toString(16)}`
    )
  }
})

test('decodes the strip from {r,g,b} means the way preview.debug.sample reports them', () => {
  const cells = Array.from({ length: STRIP_BITS }, (_, bit) =>
    bit % 3 === 0 ? { r: 250, g: 252, b: 248 } : { r: 4, g: 3, b: 6 }
  )
  const expected = Array.from({ length: STRIP_BITS }).reduce(
    (value, _cell, bit) => (bit % 3 === 0 ? value | (1 << (STRIP_BITS - 1 - bit)) : value),
    0
  )
  assert.deepEqual(decodeSyntheticStrip(cells), { synthetic: true, sequence: expected >>> 0 })
})

test('a strip blended with the noise under it still decodes', () => {
  // A 2 px strip on a 360-line preview averages with a noise row: white
  // comes out near 190, black near 65.
  const cells = Array.from({ length: STRIP_BITS }, (_, bit) =>
    bit < 8 ? [190, 188, 192] : [66, 62, 70]
  )
  assert.deepEqual(decodeSyntheticStrip(cells), { synthetic: true, sequence: 0xff00 })
})

test('rejects a flat picture: all black or all white is not a strip', () => {
  const black = Array.from({ length: STRIP_BITS }, () => [0, 0, 0])
  const white = Array.from({ length: STRIP_BITS }, () => [255, 255, 255])
  assert.equal(decodeSyntheticStrip(black).synthetic, false)
  assert.equal(decodeSyntheticStrip(white).synthetic, false)
})

test('rejects camera-like means: a soft gradient with mid-tones', () => {
  const cells = Array.from({ length: STRIP_BITS }, (_, bit) => {
    const v = 40 + bit * 12
    return [v, v + 10, v - 5]
  })
  const verdict = decodeSyntheticStrip(cells)
  assert.equal(verdict.synthetic, false)
  assert.match(verdict.reason, /mid-tone/)
})

test('rejects noise means: random colours average to mid-grey', () => {
  const frame = noiseFrameWithStrip(640, 360, 0, 0)
  const cells = meanRectsRgb24(frame, 640, 360, syntheticStripRects())
  assert.equal(decodeSyntheticStrip(cells).synthetic, false)
})

test('rejects banners and solid colours that happen to be bright or dark', () => {
  // Magenta over black: bright cells and dark cells, but the magenta's luma
  // is a mid-tone, so this is a picture, not a strip.
  const cells = Array.from({ length: STRIP_BITS }, (_, bit) =>
    bit < 6 ? [255, 0, 255] : [0, 0, 0]
  )
  assert.equal(decodeSyntheticStrip(cells).synthetic, false)
})

test('rejects the wrong number of cells and non-colours', () => {
  assert.equal(decodeSyntheticStrip([]).synthetic, false)
  assert.equal(decodeSyntheticStrip(null).synthetic, false)
  const cells = Array.from({ length: STRIP_BITS }, () => [255, 255, 255])
  cells[3] = { r: Number.NaN, g: 0, b: 0 }
  assert.equal(decodeSyntheticStrip(cells).synthetic, false)
})

test('meanRectsRgb24 reads the middle fifth of a rect, like the backend oracle', () => {
  const width = 10
  const height = 10
  const rgb = new Uint8Array(width * height * 3)
  // Only the centre 2x2 of the full-frame rect carries colour.
  for (const y of [4, 5]) {
    for (const x of [4, 5]) {
      const i = (y * width + x) * 3
      rgb[i] = 200
      rgb[i + 1] = 40
      rgb[i + 2] = 20
    }
  }
  assert.deepEqual(meanRectsRgb24(rgb, width, height, [{ x: 0, y: 0, w: 1, h: 1 }]), [
    [200, 40, 20]
  ])
  assert.throws(() => meanRectsRgb24(rgb, width, height + 1, []), /needs/)
})

test('the oracle rects tile the full width at the very top of the frame', () => {
  const rects = syntheticStripRects()
  assert.equal(rects.length, STRIP_BITS)
  assert.equal(rects[0].x, 0)
  assert.ok(Math.abs(rects.at(-1).x + rects.at(-1).w - 1) < 1e-9)
  assert.ok(rects.every((rect) => rect.y === 0 && rect.h <= 0.01))
})
