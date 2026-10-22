import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cellRect,
  decodeCode,
  encodeCode,
  markerRegions,
  pixelRect
} from '../card/marker-codec.mjs'
import { decodeMarkers, loadMarkerSpec, renderMarkerFrame } from './card-markers.mjs'

const spec = loadMarkerSpec()

test('codes round-trip with guards and even parity', () => {
  assert.deepEqual(encodeCode(5, 4), [1, 0, 1, 0, 1, 0, 0])
  assert.deepEqual(encodeCode(7, 4), [1, 0, 1, 1, 1, 1, 0])
  for (const value of [0, 1, 42, 511, 1023]) {
    assert.deepEqual(decodeCode(encodeCode(value, 10), 10), { value })
  }
  assert.throws(() => encodeCode(1024, 10), RangeError)
  assert.throws(() => encodeCode(-1, 4), RangeError)
  const flipped = encodeCode(42, 10)
  flipped[3] ^= 1
  assert.match(decodeCode(flipped, 10).error, /parity/)
  const unguarded = encodeCode(42, 10)
  unguarded[0] = 0
  assert.match(decodeCode(unguarded, 10).error, /guard/)
})

test('the spec regions do not overlap and stay inside the card', () => {
  const card = { x: 0, y: 0, width: 1920, height: 1080 }
  const boxes = markerRegions(spec).map((region) => ({
    name: region.name,
    ...pixelRect(region.rect, card)
  }))
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.y >= 0, box.name)
    assert.ok(box.x + box.width <= 1920 && box.y + box.height <= 1080, box.name)
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y
      assert.ok(apart, `${a.name} overlaps ${b.name}`)
    }
  }
  // Cells are square-ish and at least 20 px on a 1080p card, so they survive
  // a 720p YouTube rendition.
  for (const region of markerRegions(spec)) {
    const cell = cellRect(pixelRect(region.rect, card), region.columns, region.rows, 0, 0)
    assert.ok(
      cell.width >= 20 && cell.height >= 20,
      `${region.name} cell ${cell.width}x${cell.height}`
    )
    assert.ok(Math.abs(cell.width - cell.height) <= 2, `${region.name} cells are square`)
  }
})

for (const [width, height] of [
  [1920, 1080],
  [1280, 720],
  [854, 480]
]) {
  test(`decodes step and scene from a clean ${width}x${height} frame`, () => {
    for (const [stepIndex, sceneId] of [
      [0, 0],
      [7, 3],
      [612, 15],
      [1023, 9]
    ]) {
      const frame = renderMarkerFrame({ width, height, stepIndex, sceneId })
      const result = decodeMarkers(frame, width, height)
      assert.equal(result.ok, true, result.errors.join('; '))
      assert.equal(result.step, stepIndex)
      assert.equal(result.sceneId, sceneId)
      assert.equal(result.flash, false)
      assert.deepEqual(result.fiducials, { tl: true, tr: true, bl: true, br: true })
    }
  })
}

test('step indexes past the code range wrap', () => {
  const frame = renderMarkerFrame({ width: 1280, height: 720, stepIndex: 1024 + 17 })
  assert.equal(decodeMarkers(frame, 1280, 720).step, 17)
})

test('survives compression-like noise and a 1080p to 720p downscale', () => {
  const big = renderMarkerFrame({ width: 1920, height: 1080, stepIndex: 345, sceneId: 6 })
  // Box-downscale 3:2 to 1280x720.
  const width = 1280
  const height = 720
  const small = new Uint8Array(width * height * 3)
  let seed = 7
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return (seed / 2147483648) * 60 - 30
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.floor(x * 1.5)
      const sy = Math.floor(y * 1.5)
      for (let c = 0; c < 3; c += 1) {
        const sum =
          big[(sy * 1920 + sx) * 3 + c] +
          big[(sy * 1920 + sx + 1) * 3 + c] +
          big[((sy + 1) * 1920 + sx) * 3 + c] +
          big[((sy + 1) * 1920 + sx + 1) * 3 + c]
        small[(y * width + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(sum / 4 + noise())))
      }
    }
  }
  const result = decodeMarkers(small, width, height)
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.step, 345)
  assert.equal(result.sceneId, 6)
})

test('a flash frame still decodes and reports the flash', () => {
  const frame = renderMarkerFrame({
    width: 1280,
    height: 720,
    stepIndex: 12,
    sceneId: 2,
    background: '#ffffff'
  })
  const result = decodeMarkers(frame, 1280, 720)
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.flash, true)
  assert.equal(result.step, 12)
})

test('a frame without the card is not ok', () => {
  const frame = new Uint8Array(640 * 360 * 3).fill(20)
  const result = decodeMarkers(frame, 640, 360)
  assert.equal(result.ok, false)
  assert.equal(result.aligned, false)
  assert.equal(result.step, null)
  assert.equal(result.sceneId, null)
  assert.ok(result.errors.length > 0)
})

function transformed(frame, width, height, map) {
  const out = new Uint8Array(frame.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [tx, ty] = map(x, y)
      const from = (y * width + x) * 3
      const to = (ty * width + tx) * 3
      out[to] = frame[from]
      out[to + 1] = frame[from + 1]
      out[to + 2] = frame[from + 2]
    }
  }
  return out
}

test('a mirrored, flipped or rotated card fails the fiducials', () => {
  const width = 1280
  const height = 720
  const frame = renderMarkerFrame({ width, height, stepIndex: 3 })
  for (const [name, map] of [
    ['mirrored', (x, y) => [width - 1 - x, y]],
    ['flipped', (x, y) => [x, height - 1 - y]],
    ['rotated', (x, y) => [width - 1 - x, height - 1 - y]]
  ]) {
    const result = decodeMarkers(transformed(frame, width, height, map), width, height)
    assert.equal(result.aligned, false, name)
    assert.equal(result.fiducials.tl, false, name)
    assert.equal(result.ok, false, name)
  }
})

test('reads rgba frames and a letterboxed card rect', () => {
  const width = 1280
  const height = 800
  const cardRect = { x: 0, y: 40, width: 1280, height: 720 }
  const rgb = renderMarkerFrame({
    width,
    height,
    stepIndex: 99,
    sceneId: 11,
    cardRect,
    background: '#000000'
  })
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = rgb[index * 3]
    rgba[index * 4 + 1] = rgb[index * 3 + 1]
    rgba[index * 4 + 2] = rgb[index * 3 + 2]
    rgba[index * 4 + 3] = 255
  }
  const result = decodeMarkers(rgba, width, height, { channels: 4, cardRect })
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.step, 99)
  assert.equal(result.sceneId, 11)
  assert.throws(() =>
    decodeMarkers(rgba, width, height, { channels: 4, cardRect: { ...cardRect, y: 100 } })
  )
  assert.throws(() => decodeMarkers(new Uint8Array(10), width, height))
})
