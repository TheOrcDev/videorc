import assert from 'node:assert/strict'
import test from 'node:test'

import { centreMeanLuma, lumaPlaneOfBgra, parseBgraBmp } from './room-remote-frame.mjs'

/** A BMP the way the backend serves it: V4 header, BI_BITFIELDS, top-down. */
function bmp(width, height, bgraOf, { topDown = true } = {}) {
  const offset = 14 + 108
  const out = Buffer.alloc(offset + width * height * 4)
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(offset, 10)
  out.writeUInt32LE(108, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(topDown ? -height : height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(32, 28)
  out.writeUInt32LE(3, 30)
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const at = offset + ((topDown ? row : height - 1 - row) * width + col) * 4
      const [b, g, r, a] = bgraOf(col, row)
      out[at] = b
      out[at + 1] = g
      out[at + 2] = r
      out[at + 3] = a
    }
  }
  return out
}

test('a top-down BGRA BMP reads back as its pictures luma, white 235 and black 16', () => {
  const white = lumaPlaneOfBgra(parseBgraBmp(bmp(8, 4, () => [255, 255, 255, 255])))
  const black = lumaPlaneOfBgra(parseBgraBmp(bmp(8, 4, () => [0, 0, 0, 255])))
  assert.equal(centreMeanLuma(white), 235)
  assert.equal(centreMeanLuma(black), 16)
})

test('a bottom-up BMP is flipped so row 0 is the top', () => {
  const picture = (col, row) => (row === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])
  for (const topDown of [true, false]) {
    const plane = lumaPlaneOfBgra(parseBgraBmp(bmp(4, 4, picture, { topDown })))
    assert.equal(plane.y[0], 235, `topDown=${topDown}`)
    assert.equal(plane.y[3 * 4], 16, `topDown=${topDown}`)
  }
})

test('the centre mean ignores a different border', () => {
  const picture = (col, row) =>
    col < 2 || col > 5 || row < 1 || row > 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]
  assert.equal(centreMeanLuma(lumaPlaneOfBgra(parseBgraBmp(bmp(8, 4, picture)))), 235)
})

test('a truncated or foreign file is refused', () => {
  assert.throws(() => parseBgraBmp(Buffer.from('nope')), /not a BMP/)
  const short = bmp(8, 4, () => [0, 0, 0, 255]).subarray(0, 100)
  assert.throws(() => parseBgraBmp(short), /unsupported BMP/)
})
