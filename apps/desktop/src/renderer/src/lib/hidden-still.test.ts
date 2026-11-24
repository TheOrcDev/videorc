import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HIDDEN_STILL_EDGE_MAX,
  HIDDEN_STILL_MAX_ROWS,
  hiddenStillRgba,
  hiddenStillSize
} from './hidden-still'

type Fixture = {
  tolerance: { level: number; mean: number }
  stills: { width: number; height: number; mean: number[]; samples: number[][] }[]
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/hidden-screen-still.json', import.meta.url),
    'utf8'
  )
) as Fixture

/** The largest R+G+B jump between neighbouring pixels. */
function maxEdge(rgba: Uint8ClampedArray, w: number, h: number): number {
  let max = 0
  const jump = (a: number, b: number) =>
    Math.abs((rgba[a] ?? 0) - (rgba[b] ?? 0)) +
    Math.abs((rgba[a + 1] ?? 0) - (rgba[b + 1] ?? 0)) +
    Math.abs((rgba[a + 2] ?? 0) - (rgba[b + 2] ?? 0))
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (x + 1 < w) max = Math.max(max, jump(o, o + 4))
      if (y + 1 < h) max = Math.max(max, jump(o, o + w * 4))
    }
  return max
}

// Hide screen's still (owner, live show 2026-11-20): one designed picture,
// the same here as in the backend (screen_privacy.rs) and on the web.
describe('the hidden still', () => {
  it('matches the shared fixture the backend and the web match', () => {
    for (const one of fixture.stills) {
      const still = hiddenStillRgba(one.width, one.height)
      for (const [x = 0, y = 0, r, g, b] of one.samples) {
        const o = (y * one.width + x) * 4
        const got = [still[o], still[o + 1], still[o + 2]]
        ;[r, g, b].forEach((want, c) =>
          expect(
            Math.abs((got[c] ?? 0) - (want ?? 0)),
            `${one.width}x${one.height} at (${x}, ${y}): ${got} vs ${[r, g, b]}`
          ).toBeLessThanOrEqual(fixture.tolerance.level)
        )
      }
      const sum = [0, 0, 0]
      for (let i = 0; i < still.length; i += 4) {
        sum[0] += still[i] ?? 0
        sum[1] += still[i + 1] ?? 0
        sum[2] += still[i + 2] ?? 0
      }
      sum.forEach((total, c) =>
        expect(Math.abs(total / (one.width * one.height) - (one.mean[c] ?? 0))).toBeLessThanOrEqual(
          fixture.tolerance.mean
        )
      )
    }
  })

  it('is opaque and soft at every size, so the smokes read it as hidden', () => {
    for (const [w, h] of [
      [640, 360],
      [360, 640],
      [97, 55],
      [3, 2]
    ] as const) {
      const still = hiddenStillRgba(w, h)
      expect(still.length).toBe(w * h * 4)
      expect(still.filter((_, i) => i % 4 === 3).every((alpha) => alpha === 255)).toBe(true)
      expect(maxEdge(still, w, h)).toBeLessThanOrEqual(HIDDEN_STILL_EDGE_MAX)
    }
    expect(hiddenStillRgba(0, 4).length).toBe(0)
  })

  it('is drawn at the screen aspect, capped in rows, 16:9 without a size', () => {
    expect(hiddenStillSize(3840, 2160)).toEqual({ width: 1920, height: HIDDEN_STILL_MAX_ROWS })
    expect(hiddenStillSize(2560, 1440, 720)).toEqual({ width: 1280, height: 720 })
    expect(hiddenStillSize(1080, 1920, 720)).toEqual({ width: 405, height: 720 })
    expect(hiddenStillSize(800, 500)).toEqual({ width: 800, height: 500 })
    expect(hiddenStillSize(0, 0, 720)).toEqual({ width: 1280, height: 720 })
  })
})
