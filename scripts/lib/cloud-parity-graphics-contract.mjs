/** S9 fixture pixels and artifact assertions. Pure; no page or process starts. */
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
export const GRAPHICS_PATCH = { width: 300, height: 120, fadeMs: 200, tolerance: 12 }
export const GRAPHICS_PLACEMENT = {
  horizontal: { x: 0.1, y: 0.6, w: 0.6, h: 0.25 },
  vertical: { x: 0.1, y: 0.65, w: 0.8, h: 0.15 }
}
export const GRAPHICS_DRAW = {
  h: { x: 0.1, y: 0.6, w: 675 / 1920, h: 0.25 },
  v: { x: 180 / 1080, y: 0.65, w: 720 / 1080, h: 0.15 }
}
function chunk(type, bytes) {
  const name = Buffer.from(type),
    body = Buffer.concat([name, bytes])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4),
    sum = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, body, sum])
}
export function graphicsPatchPng(base = false) {
  const { width, height } = GRAPHICS_PATCH,
    raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 4 + 1) + 1 + x * 4
      raw.set(base ? [255, 0, 0, 255] : [0, 255, 255, x < 100 ? 255 : x < 200 ? 128 : 0], at)
    }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
export function assertGraphicsPixel(actual, expected, label) {
  assert.equal(actual.length, 3)
  assert.ok(
    actual.every((n, i) => Math.abs(n - expected[i]) <= GRAPHICS_PATCH.tolerance),
    `${label}: expected ${expected}, got ${actual}`
  )
}
export function assertGraphicsRect(actual, orientation) {
  const expected = GRAPHICS_DRAW[orientation]
  for (const k of ['x', 'y', 'w', 'h'])
    assert.ok(
      Math.abs(actual[k] - expected[k]) < 0.002,
      `${orientation}: ${k} differs from native contained placement`
    )
}

/**
 * How stale a sampled opacity may be. The program page does not step a fade
 * per frame: it sets the opacity on its 50 ms clock (videorcweb `stage.ts`
 * `CLOCK_TIMER_MS`), so a sample read at any moment shows the value of a
 * step up to 50 ms old, plus one 60 Hz frame for the observer's own read.
 * The lag is one-sided: a sample is never ahead of the curve.
 */
export const GRAPHICS_FADE_MAX_LAG_MS = 66
export function assertGraphicsFade(samples, transitions) {
  const intermediate = samples.filter((row) => row.opacity > 0 && row.opacity < 1)
  assert.ok(intermediate.length, 'The real consumer must paint the fade')
  for (const row of intermediate) {
    let fits = false
    for (let lag = 0; lag <= GRAPHICS_FADE_MAX_LAG_MS && !fits; lag += 2)
      fits = transitions.some((fade) => {
        const t = Math.max(0, Math.min(1, (row.at - lag - fade.at) / 200))
        return (
          Math.abs(row.opacity - (fade.from + (fade.to - fade.from) * (1 - (1 - t) ** 3))) <= 0.08
        )
      })
    assert.ok(fits, `Fade sample at ${row.at} differs from native 200ms ease-out`)
  }
}
