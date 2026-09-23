import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import {
  colorDistance,
  contrastRatio,
  decodePng,
  laplacianVariance,
  parseHexColor,
  regionMean,
  relativeLuminance
} from './image-stats.mjs'

// Minimal PNG writer for fixtures: RGB or RGBA, one filter type for every row.
// decodePng ignores CRCs, so the fixtures write zeros there.
function encodePng({ width, height, channels, pixel, filter = 0 }) {
  const stride = width * channels
  const rows = []
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride)
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y)
      for (let c = 0; c < channels; c += 1) row[x * channels + c] = value[c]
    }
    const filtered = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0
      const up = previous[i]
      const upLeft = i >= channels ? previous[i - channels] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const toLeft = Math.abs(estimate - left)
        const toUp = Math.abs(estimate - up)
        const toUpLeft = Math.abs(estimate - upLeft)
        predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
      }
      filtered[i] = (row[i] - predicted) & 0xff
    }
    rows.push(Buffer.from([filter]), filtered)
    previous = row
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const gradient = (x, y) => [(x * 13 + y * 7) & 0xff, (x * 3 + y * 29) & 0xff, (x * y) & 0xff, 200]

test('decodePng reverses every scanline filter for RGB and RGBA', () => {
  for (const channels of [3, 4]) {
    for (const filter of [0, 1, 2, 3, 4]) {
      const image = decodePng(encodePng({ width: 9, height: 7, channels, pixel: gradient, filter }))
      assert.equal(image.width, 9)
      assert.equal(image.height, 7)
      for (const [x, y] of [
        [0, 0],
        [8, 6],
        [4, 3]
      ]) {
        const index = (y * 9 + x) * 4
        const expected = gradient(x, y)
        assert.deepEqual(
          [...image.data.subarray(index, index + 3)],
          expected.slice(0, 3),
          `channels ${channels} filter ${filter} at ${x},${y}`
        )
        assert.equal(image.data[index + 3], channels === 4 ? 200 : 255)
      }
    }
  }
})

test('decodePng rejects non-PNG input', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG/)
})

test('regionMean averages only the requested rect', () => {
  const image = decodePng(
    encodePng({
      width: 20,
      height: 10,
      channels: 3,
      pixel: (x) => (x < 10 ? [255, 0, 0] : [0, 0, 255])
    })
  )
  assert.deepEqual(regionMean(image, { x: 0, y: 0, width: 10, height: 10 }), { r: 255, g: 0, b: 0 })
  assert.deepEqual(regionMean(image, { x: 10, y: 0, width: 10, height: 10 }), {
    r: 0,
    g: 0,
    b: 255
  })
  assert.throws(() => regionMean(image, { x: 40, y: 0, width: 10, height: 10 }), /outside/)
})

test('laplacianVariance is zero for flat colour and high for hard detail', () => {
  const flat = decodePng(
    encodePng({ width: 24, height: 24, channels: 3, pixel: () => [60, 60, 70] })
  )
  const checker = decodePng(
    encodePng({
      width: 24,
      height: 24,
      channels: 3,
      pixel: (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0])
    })
  )
  const whole = { x: 0, y: 0, width: 24, height: 24 }
  assert.equal(laplacianVariance(flat, whole), 0)
  assert.ok(laplacianVariance(checker, whole) > 10_000)
})

test('contrast helpers match WCAG reference values', () => {
  const white = parseHexColor('#FFFFFF')
  const black = parseHexColor('#000000')
  assert.equal(relativeLuminance(white), 1)
  assert.equal(relativeLuminance(black), 0)
  assert.equal(contrastRatio(white, black), 21)
  assert.equal(contrastRatio(black, white), 21)
  assert.ok(Math.abs(contrastRatio(parseHexColor('#767676'), white) - 4.54) < 0.01)
  assert.equal(Math.round(colorDistance(white, black)), 442)
  assert.throws(() => parseHexColor('red'), /RRGGBB/)
})
