import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'

import {
  DIFF_THRESHOLD,
  comparePictures,
  decodePng,
  encodePng,
  pairOf,
  resizeNearest,
  shotStem,
  sideBySide,
  sliceOfBranch
} from './gpui-compare.mjs'

function picture(width, height, pixel) {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba.set(pixel(x, y), (y * width + x) * 4)
  }
  return { width, height, rgba }
}

/** A PNG with the given colour type and one filter per row, built by hand. */
function handMadePng(width, height, colorType, rows) {
  const chunk = (type, body) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed) >>> 0)
    return Buffer.concat([length, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('sRGB', Buffer.from([0])),
    chunk('IDAT', deflateSync(Buffer.concat(rows.map((row) => Buffer.from(row))))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

test('a picture survives the PNG writer and reader', () => {
  const original = picture(5, 3, (x, y) => [x * 40, y * 80, 7, 255 - x])
  const decoded = decodePng(encodePng(original))
  assert.equal(decoded.width, 5)
  assert.equal(decoded.height, 3)
  assert.deepEqual([...decoded.rgba], [...original.rgba])
  assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG/)
  assert.throws(
    () => encodePng({ width: 2, height: 2, rgba: Buffer.alloc(3) }),
    /not a 2x2 RGBA picture/
  )
})

test('the reader undoes every PNG filter, in RGB and RGBA', () => {
  // RGB, 2x5, one row per filter (None, Sub, Up, Average, Paeth). The
  // expected pixels, then each row as its filter writes it.
  const expected = [
    [10, 20, 30, 40, 50, 60],
    [11, 21, 31, 51, 61, 71],
    [12, 22, 32, 52, 62, 72],
    [13, 23, 33, 53, 63, 73],
    [14, 24, 34, 54, 64, 74]
  ]
  const rows = [
    [0, ...expected[0]],
    // Sub: each byte minus the one a pixel to the left.
    [1, ...expected[1].map((value, i) => (i >= 3 ? value - expected[1][i - 3] : value) & 0xff)],
    // Up: minus the byte above.
    [2, ...expected[2].map((value, i) => (value - expected[1][i]) & 0xff)],
    // Average: minus floor((left + up) / 2).
    [
      3,
      ...expected[3].map(
        (value, i) => (value - (((i >= 3 ? expected[3][i - 3] : 0) + expected[2][i]) >> 1)) & 0xff
      )
    ],
    // Paeth.
    [
      4,
      ...expected[4].map((value, i) => {
        const a = i >= 3 ? expected[4][i - 3] : 0
        const b = expected[3][i]
        const c = i >= 3 ? expected[3][i - 3] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        return (value - predictor) & 0xff
      })
    ]
  ]
  const decoded = decodePng(handMadePng(2, 5, 2, rows))
  const rgba = []
  for (const row of expected) {
    rgba.push(row[0], row[1], row[2], 255, row[3], row[4], row[5], 255)
  }
  assert.deepEqual([...decoded.rgba], rgba)
  assert.throws(() => decodePng(handMadePng(1, 1, 3, [[0, 0]])), /8-bit RGB or RGBA/)
})

test('the pixel report counts what moved past the threshold, at the baseline size', () => {
  const baseline = picture(4, 2, () => [100, 100, 100, 255])
  const same = picture(4, 2, () => [100 + DIFF_THRESHOLD, 100, 100, 255])
  assert.equal(comparePictures(baseline, same).report.differingPixels, 0)
  const moved = picture(4, 2, (x) => (x === 0 ? [200, 100, 100, 255] : [100, 100, 100, 255]))
  const { report, diff } = comparePictures(baseline, moved)
  assert.equal(report.differingPixels, 2)
  assert.equal(report.differingShare, 0.25)
  assert.equal(report.maxDelta, 100)
  assert.equal(report.sizeMatch, true)
  assert.deepEqual([...diff.rgba.subarray(0, 4)], [255, 0, 0, 255], 'red where it differs')
  // A GPUI shot at twice the size is compared at the baseline's.
  const double = resizeNearest(moved, 8, 4)
  const scaled = comparePictures(baseline, double).report
  assert.equal(scaled.sizeMatch, false)
  assert.equal(scaled.differingPixels, 2)
  assert.deepEqual(scaled.gpuiSize, { width: 8, height: 4 })
})

test('the pair puts the baseline, the shot and the difference side by side', () => {
  const baseline = encodePng(picture(4, 2, () => [0, 0, 0, 255]))
  const gpui = encodePng(picture(4, 2, () => [255, 255, 255, 255]))
  const { report, png } = pairOf(baseline, gpui)
  const pair = decodePng(png)
  assert.equal(pair.width, 4 * 3 + 16 * 2)
  assert.equal(pair.height, 2)
  assert.equal(report.differingPixels, 8)
  const strip = sideBySide([
    picture(1, 3, () => [1, 2, 3, 255]),
    picture(2, 1, () => [9, 9, 9, 255])
  ])
  assert.equal(strip.width, 1 + 16 + 2)
  assert.equal(strip.height, 3)
  assert.deepEqual([...strip.rgba.subarray(0, 4)], [1, 2, 3, 255])
})

test('shots are named as the S0.10 baseline names them; the slice comes from the branch', () => {
  assert.equal(
    shotStem({ state: 'idle', width: 1280, height: 800, theme: 'dark', contrast: 'more' }),
    'idle-1280x800-dark-contrast'
  )
  assert.equal(
    shotStem({ state: 'idle', width: 960, height: 660, theme: 'light', contrast: 'normal' }),
    'idle-960x660-light'
  )
  assert.equal(sliceOfBranch('gpui/s2.3a-preview-element\n'), 's2.3a')
  assert.equal(sliceOfBranch('gpui/s2-5b-baseline-diff-checker'), 's2.5b')
  assert.equal(sliceOfBranch('gpui/s0-10-electron-baseline'), 's0.10')
  assert.equal(sliceOfBranch('main'), 'adhoc')
  assert.equal(sliceOfBranch('gpui/a b'), 'adhoc')
})
