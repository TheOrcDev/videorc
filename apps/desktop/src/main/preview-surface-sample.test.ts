import { describe, expect, it } from 'vitest'

import {
  meanRectsFromBitmap,
  parseNormalizedRects,
  PREVIEW_SURFACE_SAMPLE_MAX_RECTS,
  stageCaptureRect
} from './preview-surface-sample'

/** A BGRA bitmap filled by `colour(x, y)` → [r, g, b]. */
function bitmap(
  width: number,
  height: number,
  colour: (x: number, y: number) => [number, number, number]
): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y)
      const i = (y * width + x) * 4
      out[i] = b
      out[i + 1] = g
      out[i + 2] = r
      out[i + 3] = 255
    }
  }
  return out
}

describe('meanRectsFromBitmap', () => {
  it('reads BGRA as RGB and averages only the middle fifth of each rect', () => {
    // Left half magenta, right half cyan; a 1 px yellow border the middle
    // fifth never reaches.
    const image = bitmap(100, 50, (x, y) =>
      x === 0 || y === 0 || x === 99 || y === 49
        ? [255, 255, 0]
        : x < 50
          ? [255, 0, 255]
          : [0, 255, 255]
    )
    const [left, right] = meanRectsFromBitmap(image, 100, 50, [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 }
    ])
    expect(left).toEqual({ r: 255, g: 0, b: 255 })
    expect(right).toEqual({ r: 0, g: 255, b: 255 })
  })

  it('matches the middle-fifth window of meanRectsRgb24 and preview.debug.sample', () => {
    // A horizontal ramp: the mean over [floor(0.4w), ceil(0.6w)) is exact.
    const image = bitmap(10, 10, (x) => [x * 10, 0, 0])
    const [mean] = meanRectsFromBitmap(image, 10, 10, [{ x: 0, y: 0, w: 1, h: 1 }])
    // Columns 4 and 5.
    expect(mean.r).toBe(45)
  })

  it('keeps at least one pixel for a rect thinner than a pixel and clamps to the frame', () => {
    const image = bitmap(16, 200, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0]))
    const cells = meanRectsFromBitmap(
      image,
      16,
      200,
      Array.from({ length: 16 }, (_, bit) => ({ x: bit / 16, y: 0, w: 1 / 16, h: 0.005 }))
    )
    expect(cells.map(({ r }) => r)).toEqual(
      Array.from({ length: 16 }, (_, bit) => (bit % 2 ? 255 : 0))
    )
    const [outside] = meanRectsFromBitmap(image, 16, 200, [{ x: 2, y: 2, w: 1, h: 1 }])
    expect(outside).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('refuses a bitmap shorter than its size', () => {
    expect(() => meanRectsFromBitmap(new Uint8Array(10), 4, 4, [])).toThrow(/needs 64 bytes/)
    expect(() => meanRectsFromBitmap(new Uint8Array(0), 0, 4, [])).toThrow(/Not a bitmap size/)
  })
})

describe('parseNormalizedRects', () => {
  it('accepts finite rects with a positive size', () => {
    expect(parseNormalizedRects([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }])).toEqual([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    ])
  })

  it('names the bad entry', () => {
    expect(() => parseNormalizedRects([])).toThrow(/non-empty/)
    expect(() => parseNormalizedRects('x')).toThrow(/non-empty/)
    expect(() => parseNormalizedRects([null])).toThrow(/Rect 0 is not an object/)
    expect(() => parseNormalizedRects([{ x: 0, y: 0, w: 1 }])).toThrow(/exactly x, y, w and h/)
    expect(() => parseNormalizedRects([{ x: 0, y: 0, w: 1, h: 1, z: 1 }])).toThrow(/exactly/)
    expect(() => parseNormalizedRects([{ x: Number.NaN, y: 0, w: 1, h: 1 }])).toThrow(/non-finite/)
    expect(() => parseNormalizedRects([{ x: 0, y: 0, w: 0, h: 1 }])).toThrow(/positive/)
    expect(() =>
      parseNormalizedRects(
        Array.from({ length: PREVIEW_SURFACE_SAMPLE_MAX_RECTS + 1 }, () => ({
          x: 0,
          y: 0,
          w: 1,
          h: 1
        }))
      )
    ).toThrow(/at most/)
  })
})

describe('stageCaptureRect', () => {
  it('rounds the stage and clips it to the viewport', () => {
    expect(
      stageCaptureRect(
        { left: 10.4, top: -2, width: 640.2, height: 400 },
        { width: 600, height: 360 }
      )
    ).toEqual({ x: 10, y: 0, width: 590, height: 360 })
  })

  it('is null for a stage that is missing or off screen', () => {
    expect(stageCaptureRect(null, { width: 100, height: 100 })).toBeNull()
    expect(
      stageCaptureRect({ left: 200, top: 0, width: 50, height: 50 }, { width: 100, height: 100 })
    ).toBeNull()
    expect(
      stageCaptureRect(
        { left: Number.NaN, top: 0, width: 50, height: 50 },
        { width: 100, height: 100 }
      )
    ).toBeNull()
  })
})
