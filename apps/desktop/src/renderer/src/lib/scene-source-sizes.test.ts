import { describe, expect, it } from 'vitest'

import {
  NO_SOURCE_PICTURE_SIZES,
  scenePictureSizes,
  sourcePictureSize,
  sourcePictureSizesFromCapture,
  sourcePictureSizesFromCompositor
} from './scene-source-sizes'

// Plan 216 B2: the streamer's 2228x1440 display reaches the stage as the
// screen source's size, from the compositor's status first and the capture
// status before it.
describe('source picture sizes (plan 216 B2)', () => {
  it("takes every live scene source's size from the compositor and keeps state identity when nothing changed", () => {
    const first = sourcePictureSizesFromCompositor(NO_SOURCE_PICTURE_SIZES, [
      { id: 'source:base', kind: 'screen', width: 2228, height: 1440 },
      { id: 'source:camera', kind: 'camera', width: 1280, height: 720 },
      { id: 'screen-image:1', kind: 'screen-image', width: 4000, height: 3000 },
      { id: 'background-image:1', kind: 'background-image', width: 7680, height: 4320 },
      { id: 'source:later', kind: 'window' }
    ])
    expect(first.byId).toEqual({
      'source:base': { width: 2228, height: 1440 },
      'source:camera': { width: 1280, height: 720 }
    })
    const same = sourcePictureSizesFromCompositor(first, [
      { id: 'source:camera', kind: 'camera', width: 1280, height: 720 },
      { id: 'source:base', kind: 'screen', width: 2228, height: 1440 }
    ])
    expect(same).toBe(first)
    // A display swap is a change.
    const swapped = sourcePictureSizesFromCompositor(first, [
      { id: 'source:base', kind: 'screen', width: 3440, height: 1440 },
      { id: 'source:camera', kind: 'camera', width: 1280, height: 720 }
    ])
    expect(swapped).not.toBe(first)
    expect(swapped.byId['source:base']).toEqual({ width: 3440, height: 1440 })
  })

  it('takes the capture statuses by kind, and only a real size', () => {
    const screen = sourcePictureSizesFromCapture(NO_SOURCE_PICTURE_SIZES, 'screen', {
      width: 2228,
      height: 1440
    })
    expect(screen.screen).toEqual({ width: 2228, height: 1440 })
    expect(sourcePictureSizesFromCapture(screen, 'screen', { width: 2228, height: 1440 })).toBe(
      screen
    )
    expect(sourcePictureSizesFromCapture(screen, 'camera', {}).camera).toBeNull()
    expect(
      sourcePictureSizesFromCapture(screen, 'camera', { width: 0, height: 720 }).camera
    ).toBeNull()
    expect(sourcePictureSizesFromCapture(screen, 'camera', { width: 1280, height: 720 })).toEqual({
      byId: {},
      screen: { width: 2228, height: 1440 },
      camera: { width: 1280, height: 720 }
    })
  })

  it("resolves a source's size: its own from the compositor, else its kind's capture, else nothing", () => {
    const sizes = {
      byId: { 'source:base': { width: 2228, height: 1440 } },
      screen: { width: 1920, height: 1080 },
      camera: { width: 1280, height: 720 }
    }
    expect(sourcePictureSize({ id: 'source:base', kind: 'screen' }, sizes)).toEqual({
      width: 2228,
      height: 1440
    })
    expect(sourcePictureSize({ id: 'source:window', kind: 'window' }, sizes)).toEqual({
      width: 1920,
      height: 1080
    })
    expect(sourcePictureSize({ id: 'source:camera', kind: 'camera' }, sizes)).toEqual({
      width: 1280,
      height: 720
    })
    expect(sourcePictureSize({ id: 'source:pattern', kind: 'test-pattern' }, sizes)).toBeNull()
    expect(
      scenePictureSizes(
        [
          { id: 'source:base', kind: 'screen' },
          { id: 'source:pattern', kind: 'test-pattern' }
        ],
        sizes
      )
    ).toEqual({ 'source:base': { width: 2228, height: 1440 } })
  })
})
