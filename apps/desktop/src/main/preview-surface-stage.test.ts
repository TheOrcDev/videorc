import { describe, expect, it } from 'vitest'

import { PREVIEW_SURFACE_STAGE_RUNTIME_SCRIPT } from './preview-surface-stage'

type StageRect = { left: number; top: number; width: number; height: number }

const previewSurfaceStageRect = new Function(
  `${PREVIEW_SURFACE_STAGE_RUNTIME_SCRIPT}\nreturn previewSurfaceStageRect;`
)() as (
  windowWidth: unknown,
  windowHeight: unknown,
  canvasWidth: unknown,
  canvasHeight: unknown
) => StageRect | null

describe('previewSurfaceStageRect', () => {
  it('pillarboxes a 9:16 canvas in a 16:9 window', () => {
    expect(previewSurfaceStageRect(1600, 900, 720, 1280)).toEqual({
      left: 547,
      top: 0,
      width: 506,
      height: 900
    })
  })

  it('pillarboxes the vertical canvas in the tiled Hyprland window from the bug', () => {
    const rect = previewSurfaceStageRect(701, 418, 720, 1280)
    expect(rect).not.toBeNull()
    expect(rect?.height).toBe(418)
    expect(rect?.width).toBe(235)
    expect(rect?.left).toBe(233)
    expect(rect?.top).toBe(0)
  })

  it('letterboxes a 16:9 canvas in a 9:16 window', () => {
    expect(previewSurfaceStageRect(900, 1600, 1920, 1080)).toEqual({
      left: 0,
      top: 547,
      width: 900,
      height: 506
    })
  })

  it('keeps the full window when the window already has the canvas aspect', () => {
    expect(previewSurfaceStageRect(1280, 720, 1920, 1080)).toBeNull()
    expect(previewSurfaceStageRect(720, 1280, 720, 1280)).toBeNull()
  })

  it('keeps the full window when the aspects differ only by sub-pixel rounding', () => {
    // 701 / (16 / 9) = 394.31: an aspect-conformed window rounds to 394.
    expect(previewSurfaceStageRect(701, 394, 1920, 1080)).toBeNull()
  })

  it('falls back to the full window for zero, negative or invalid sizes', () => {
    expect(previewSurfaceStageRect(0, 720, 1920, 1080)).toBeNull()
    expect(previewSurfaceStageRect(1280, -1, 1920, 1080)).toBeNull()
    expect(previewSurfaceStageRect(1280, 720, 0, 1080)).toBeNull()
    expect(previewSurfaceStageRect(1280, 720, 1920, Number.NaN)).toBeNull()
    expect(previewSurfaceStageRect(1280, 720, undefined, undefined)).toBeNull()
    expect(previewSurfaceStageRect(Number.POSITIVE_INFINITY, 720, 1920, 1080)).toBeNull()
  })
})
