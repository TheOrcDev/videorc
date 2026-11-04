import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { SceneSourceKind, SourceCrop } from './backend'
import {
  containRectPixels,
  sceneFrameRect,
  scenePictureRect,
  scenePictureRectPixels,
  sceneRectPixels,
  sceneStageRect,
  screenBoxIsPicture,
  type FractionRect,
  type PictureFit,
  type PixelRect,
  type PixelSize
} from './scene-picture-geometry'

interface PictureCase {
  name: string
  frame: FractionRect
  kind: SceneSourceKind
  fit: PictureFit
  source: PixelSize | null
  crop?: Partial<SourceCrop>
  stageMargin?: number
  canvas: PixelSize
  expected: PixelRect
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/scene-picture-geometry.json', import.meta.url),
    'utf8'
  )
) as { schemaVersion: number; cases: PictureCase[] }

const within = (actual: PixelRect, expected: PixelRect, tolerance: number, name: string): void => {
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(actual[key] - expected[key]), `${name}: ${key}`).toBeLessThanOrEqual(tolerance)
}

// Plan 216 B1: one rule for where a source's picture lands inside its frame,
// shared with Rust `scene_geometry::scene_picture_rect_pixels` through the
// fixture. The compositor fits the picture with the same arithmetic.
describe('scene picture geometry (plan 216 B1)', () => {
  it('reproduces every shared fixture case within a pixel', () => {
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.cases.length).toBeGreaterThanOrEqual(12)
    for (const testCase of fixture.cases) {
      const pixels = scenePictureRectPixels(testCase)
      within(pixels, testCase.expected, 1, testCase.name)
      // The fraction form is the pixel form over the canvas.
      const fraction = scenePictureRect(testCase)
      within(
        {
          x: fraction.x * testCase.canvas.width,
          y: fraction.y * testCase.canvas.height,
          width: fraction.width * testCase.canvas.width,
          height: fraction.height * testCase.canvas.height
        },
        testCase.expected,
        1,
        `${testCase.name} (fractions)`
      )
    }
  })

  it("the streamer's case: a 2228x1440 display Fit in a 16:9 frame is about 2021 px wide", () => {
    const streamer = fixture.cases[0]
    const picture = scenePictureRect(streamer)
    expect(picture.x).toBeCloseTo(0.152, 3)
    expect(picture.width).toBeCloseTo(0.789, 3)
    expect(picture.y).toBeCloseTo(streamer.frame.y, 3)
    expect(picture.height).toBeCloseTo(streamer.frame.height, 3)
  })

  it('maps a frame onto the stage margin and back exactly', () => {
    const frame: FractionRect = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 }
    for (const kind of ['screen', 'window', 'test-pattern'] as const) {
      const staged = sceneStageRect(frame, kind, 0.1)
      const expected = { x: 0.18, y: 0.26, width: 0.4, height: 0.48 }
      for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(staged[key]).toBeCloseTo(expected[key], 12)
      const back = sceneFrameRect(staged, kind, 0.1)
      for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(back[key]).toBeCloseTo(frame[key], 12)
    }
    // The camera never sits on the stage; no margin leaves every kind alone.
    expect(sceneStageRect(frame, 'camera', 0.1)).toEqual(frame)
    expect(sceneFrameRect(frame, 'camera', 0.1)).toEqual(frame)
    expect(sceneStageRect(frame, 'screen', 0)).toEqual(frame)
  })

  it('rounds a frame to canvas pixels like the backend, signed and uncut', () => {
    expect(
      sceneRectPixels(
        { x: -0.25, y: -0.25, width: 1.5, height: 1.5 },
        { width: 1920, height: 1080 }
      )
    ).toEqual({
      x: -480,
      y: -270,
      width: 2880,
      height: 1620
    })
    // At least one pixel a side; the protocol's bounds on the way in.
    expect(
      sceneRectPixels({ x: 9, y: -9, width: 0, height: 9 }, { width: 100, height: 100 })
    ).toEqual({
      x: 400,
      y: -300,
      width: 1,
      height: 400
    })
  })

  it('contains a picture inside a box, centred, with the compositor rounding', () => {
    expect(containRectPixels(2228, 1440, { x: 239, y: 134, width: 2321, height: 1306 })).toEqual({
      x: 389,
      y: 134,
      width: 2021,
      height: 1306
    })
    // A wider picture than the box letterboxes top and bottom.
    expect(containRectPixels(3440, 1440, { x: 0, y: 0, width: 2560, height: 1440 })).toEqual({
      x: 0,
      y: 184,
      width: 2560,
      height: 1072
    })
    // A degenerate box or source is left alone.
    expect(containRectPixels(0, 1440, { x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4
    })
  })

  it('D3: a display swap changes the picture, never the frame, and swapping back is exact', () => {
    // The streamer's LG ultrawide (3440x1440) on a 2560x1440 canvas, saved
    // as a Freeform box the shape of its picture.
    const canvas = { width: 2560, height: 1440 }
    const ultrawide = { width: 3440, height: 1440 }
    const macbook = { width: 2228, height: 1440 }
    const frame = scenePictureRect({
      frame: { x: 0, y: 0, width: 1, height: 1 },
      kind: 'screen',
      fit: 'contain',
      source: ultrawide,
      canvas
    })
    expect(frame.height).toBeCloseTo(1072 / 1440, 6)
    // Their MacBook display stands in: the whole picture sits centred inside
    // the stored frame, which stays as it was.
    const standIn = scenePictureRect({
      frame,
      kind: 'screen',
      fit: 'contain',
      source: macbook,
      canvas
    })
    expect(standIn.height).toBeCloseTo(frame.height, 6)
    expect(standIn.width).toBeCloseTo(1659 / 2560, 6)
    expect(standIn.x).toBeCloseTo(450 / 2560, 6)
    // The ultrawide comes back: the frame is its picture again.
    const back = scenePictureRect({
      frame,
      kind: 'screen',
      fit: 'contain',
      source: ultrawide,
      canvas
    })
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(back[key]).toBeCloseTo(frame[key], 6)
  })

  it('a Freeform screen follows its picture only on Fit with a known size', () => {
    const size = { width: 2228, height: 1440 }
    expect(screenBoxIsPicture('screen', 'contain', size)).toBe(true)
    expect(screenBoxIsPicture('window', 'contain', size)).toBe(true)
    expect(screenBoxIsPicture('screen', 'cover', size)).toBe(false)
    expect(screenBoxIsPicture('screen', 'contain', null)).toBe(false)
    expect(screenBoxIsPicture('screen', 'contain', { width: 0, height: 1440 })).toBe(false)
    expect(screenBoxIsPicture('camera', 'contain', size)).toBe(false)
    expect(screenBoxIsPicture('test-pattern', 'contain', size)).toBe(false)
  })
})
