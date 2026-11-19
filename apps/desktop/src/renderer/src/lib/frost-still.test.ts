import { describe, expect, it } from 'vitest'

import {
  FROST_SAMPLE_ROWS,
  frostPlan,
  frostRgba,
  frostedStillUrl,
  keepFrostSample
} from './frost-still'

// Plan 210 D8 in a room: the native frost (screen_privacy.rs), so the Show
// stage draws a hidden screen as the Studio does. Paired with the web's
// tests/cloud-screen-frost.test.ts.

function frame(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number]
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([...paint(x, y), 255], (y * width + x) * 4)
  return data
}

/** A canvas stand-in: what was drawn into it reads back as `pixels`. */
function fakeCanvas(pixels: (w: number, h: number) => Uint8ClampedArray | null) {
  const canvas = {
    width: 0,
    height: 0,
    drawn: [] as unknown[],
    getContext: () => ({
      drawImage(image: unknown) {
        canvas.drawn.push(image)
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        const data = pixels(w, h)
        if (!data) throw new Error('SecurityError')
        return { data }
      }
    })
  }
  return canvas
}

function fakePage() {
  const made: { width: number; height: number; put: Uint8ClampedArray | null }[] = []
  const page = {
    createElement: () => {
      const still = {
        width: 0,
        height: 0,
        put: null as Uint8ClampedArray | null,
        getContext: () => ({
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData(image: { data: Uint8ClampedArray }) {
            still.put = image.data
          }
        }),
        toDataURL: () => `data:image/png;base64,${still.width}x${still.height}`
      }
      made.push(still)
      return still
    }
  } as unknown as Document
  return { page, made }
}

describe('the frost (plan 210 D8)', () => {
  it('keeps the aspect ratio and never upscales, as the native plan', () => {
    expect(frostPlan(1920, 1080)).toEqual({ width: 85, height: 48 })
    expect(frostPlan(3840, 2160)).toEqual({ width: 85, height: 48 })
    expect(frostPlan(1080, 1920)).toEqual({ width: 27, height: 48 })
    expect(frostPlan(100, 30)).toEqual({ width: 100, height: 30 })
    expect(frostPlan(1, 1)).toEqual({ width: 1, height: 1 })
  })

  it('keeps a colour, is opaque, and is grey with no frame', () => {
    const red = frostRgba(
      frame(640, 360, () => [220, 0, 0]),
      640,
      360
    )
    expect(red.data).toHaveLength(85 * 48 * 4)
    for (let i = 0; i < red.data.length; i += 4)
      expect([...red.data.subarray(i, i + 4)]).toEqual([220, 0, 0, 255])
    const none = frostRgba(new Uint8ClampedArray(16), 8, 4)
    expect([...none.data.subarray(0, 4)]).toEqual([128, 128, 128, 255])
  })

  it('keeps the shapes and loses the strokes', () => {
    const page = frame(640, 360, (x, y) =>
      y >= 150 && y < 200 && x >= 80 && x < 560 && x % 7 < 3 ? [0, 0, 0] : [255, 255, 255]
    )
    const still = frostRgba(page, 640, 360)
    const luma = (x: number, y: number) => still.data[(y * still.width + x) * 4] ?? 0
    let step = 0
    for (let y = 0; y < still.height; y++)
      for (let x = 1; x < still.width; x++)
        step = Math.max(step, Math.abs(luma(x, y) - luma(x - 1, y)))
    expect(step).toBeLessThan(40)
    expect(luma(42, 3) - luma(42, 23)).toBeGreaterThan(40)
  })
})

describe('the hidden screen still', () => {
  it('copies the last frame as a blit, at most FROST_SAMPLE_ROWS tall, and not a 2×2 end', () => {
    const into = fakeCanvas(() => null)
    const last = {} as CanvasImageSource
    const sample = into as unknown as HTMLCanvasElement
    expect(keepFrostSample(sample, { image: last, width: 2, height: 2 })).toBe(false)
    expect(into.drawn).toEqual([])
    expect(keepFrostSample(sample, { image: last, width: 1920, height: 1080 })).toBe(true)
    expect([into.width, into.height]).toEqual([683, FROST_SAMPLE_ROWS])
    expect(into.drawn).toEqual([last])
  })

  it('frosts the copy into a small PNG, and gives none for the grey or a refused read', () => {
    const blue = fakeCanvas((w, h) => frame(w, h, () => [0, 0, 200]))
    blue.width = 683
    blue.height = 384
    const { page, made } = fakePage()
    expect(frostedStillUrl(page, blue as unknown as HTMLCanvasElement)).toBe(
      'data:image/png;base64,85x48'
    )
    expect([...(made[0]?.put?.subarray(0, 4) ?? [])]).toEqual([0, 0, 200, 255])
    const grey = fakeCanvas((w, h) => frame(w, h, () => [128, 127, 129]))
    grey.width = 64
    grey.height = 36
    expect(frostedStillUrl(page, grey as unknown as HTMLCanvasElement)).toBeNull()
    const refused = fakeCanvas(() => null)
    refused.width = 64
    refused.height = 36
    expect(frostedStillUrl(page, refused as unknown as HTMLCanvasElement)).toBeNull()
  })
})
