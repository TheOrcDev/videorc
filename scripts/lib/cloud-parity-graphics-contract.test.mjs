import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import {
  graphicsPatchPng,
  assertGraphicsPixel,
  assertGraphicsRect
} from './cloud-parity-graphics-contract.mjs'
test('acceptance fixture contains opaque, half alpha and transparent source pixels', () => {
  const png = graphicsPatchPng()
  assert.equal(png.readUInt32BE(16), 300)
  assert.equal(png.readUInt32BE(20), 120)
  let offset = 8
  const data = []
  while (offset < png.length) {
    const n = png.readUInt32BE(offset),
      kind = png.toString('ascii', offset + 4, offset + 8)
    if (kind === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + n))
    offset += n + 12
  }
  const raw = inflateSync(Buffer.concat(data))
  assert.deepEqual([raw[4], raw[404], raw[804]], [255, 128, 0])
})
test('artifact checks reject double opacity, wrong ordering and stretched placement', () => {
  assertGraphicsPixel([127, 128, 128], [127, 128, 128], 'half alpha')
  assert.throws(() => assertGraphicsPixel([191, 64, 64], [127, 128, 128], 'opacity applied twice'))
  assert.throws(() => assertGraphicsPixel([255, 0, 0], [0, 255, 255], 'wrong order'))
  assertGraphicsRect({ x: 0.1, y: 0.6, w: 675 / 1920, h: 0.25 }, 'h')
  assert.throws(() => assertGraphicsRect({ x: 0.1, y: 0.6, w: 0.6, h: 0.25 }, 'h'))
})

import { assertGraphicsFade } from './cloud-parity-graphics-contract.mjs'
test('observed fades use the native absolute clock and reject delayed animation', () => {
  assertGraphicsFade(
    [
      { at: 1050, opacity: 0.578125 },
      { at: 1100, opacity: 0.875 }
    ],
    [{ at: 1000, from: 0, to: 1 }]
  )
  assert.throws(() =>
    assertGraphicsFade([{ at: 1400, opacity: 0.5 }], [{ at: 1000, from: 0, to: 1 }])
  )
  assert.throws(() =>
    assertGraphicsFade([{ at: 1100, opacity: 1 }], [{ at: 1000, from: 0, to: 1 }])
  )
  // The page steps the fade on its 50 ms clock: a sample shows a step up to
  // 50 ms old (release-gate run, 2026-11-20: 12 ms and 46 ms after a Show).
  const show = [{ at: 1740, from: 0, to: 1 }]
  assertGraphicsFade(
    [
      { at: 1773, opacity: 0.283 },
      { at: 1807, opacity: 0.283 }
    ],
    show
  )
  // Never ahead of the curve, and never staler than the step plus a frame.
  assert.throws(() => assertGraphicsFade([{ at: 1750, opacity: 0.6 }], show))
  assert.throws(() => assertGraphicsFade([{ at: 1860, opacity: 0.283 }], show))
})
