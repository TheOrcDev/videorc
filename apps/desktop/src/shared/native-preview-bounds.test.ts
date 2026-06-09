import { describe, expect, it } from 'vitest'

import {
  computePreviewSurfaceBounds,
  normalizePreviewSurfaceBounds,
  previewSurfaceBoundsChanged,
  type ComputePreviewSurfaceBoundsInput
} from './native-preview-bounds'

describe('normalizePreviewSurfaceBounds', () => {
  it('preserves valid fractional CSS bounds and device scale for CAMetalLayer drawable sizing', () => {
    expect(
      normalizePreviewSurfaceBounds({
        screenX: 123.4,
        screenY: 56.7,
        width: 640.5,
        height: 360.25,
        scaleFactor: 2,
        screenHeight: 1440.5
      })
    ).toEqual({
      screenX: 123.4,
      screenY: 56.7,
      width: 640.5,
      height: 360.25,
      scaleFactor: 2,
      screenHeight: 1440.5
    })
  })

  it('clamps impossible dimensions and scale before they reach native preview hosts', () => {
    expect(
      normalizePreviewSurfaceBounds({
        screenX: Number.NaN,
        screenY: Number.POSITIVE_INFINITY,
        width: 0,
        height: -10,
        scaleFactor: 0,
        screenHeight: Number.NaN
      })
    ).toEqual({
      screenX: 0,
      screenY: 0,
      width: 1,
      height: 1,
      scaleFactor: 1,
      screenHeight: undefined
    })
  })

  it('passes clip and visibility through and clamps a negative clip size', () => {
    expect(
      normalizePreviewSurfaceBounds({
        screenX: 100,
        screenY: 200,
        width: 640,
        height: 360,
        scaleFactor: 2,
        clipX: 120,
        clipY: 220,
        clipWidth: -5,
        clipHeight: 180,
        visible: true
      })
    ).toEqual({
      screenX: 100,
      screenY: 200,
      width: 640,
      height: 360,
      scaleFactor: 2,
      screenHeight: undefined,
      clipX: 120,
      clipY: 220,
      clipWidth: 0,
      clipHeight: 180,
      visible: true
    })
  })

  it('leaves clip fields absent for legacy callers that never computed one', () => {
    const normalized = normalizePreviewSurfaceBounds({
      screenX: 1,
      screenY: 2,
      width: 3,
      height: 4,
      scaleFactor: 1
    })
    expect('clipX' in normalized).toBe(false)
    expect('visible' in normalized).toBe(false)
  })
})

describe('computePreviewSurfaceBounds', () => {
  const baseInput: ComputePreviewSurfaceBoundsInput = {
    slotRect: { left: 100, top: 80, width: 640, height: 360 },
    clipRects: [],
    viewportWidth: 1200,
    viewportHeight: 800,
    windowScreenX: 50,
    windowScreenY: 25,
    scaleFactor: 2,
    screenHeight: 1080,
    documentVisible: true
  }

  it('reports a fully visible slot with a clip equal to the slot rect', () => {
    expect(computePreviewSurfaceBounds(baseInput)).toEqual({
      screenX: 150,
      screenY: 105,
      width: 640,
      height: 360,
      scaleFactor: 2,
      screenHeight: 1080,
      clipX: 150,
      clipY: 105,
      clipWidth: 640,
      clipHeight: 360,
      visible: true
    })
  })

  it('shrinks the clip when a scroll container crops the slot (scrolled half away)', () => {
    const bounds = computePreviewSurfaceBounds({
      ...baseInput,
      // Scroll container sits below the first 200px of the slot.
      clipRects: [{ left: 0, top: 280, width: 1200, height: 520 }]
    })
    expect(bounds.visible).toBe(true)
    // Slot top is at 80; container clips everything above y=280.
    expect(bounds.clipY).toBe(25 + 280)
    expect(bounds.clipHeight).toBe(360 - 200)
    expect(bounds.clipX).toBe(150)
    expect(bounds.clipWidth).toBe(640)
    // The slot rect itself stays untouched — the native host needs both.
    expect(bounds.screenY).toBe(105)
    expect(bounds.height).toBe(360)
  })

  it('clips against the viewport when the slot scrolls partially off-window', () => {
    const bounds = computePreviewSurfaceBounds({
      ...baseInput,
      slotRect: { left: -120, top: 80, width: 640, height: 360 }
    })
    expect(bounds.visible).toBe(true)
    expect(bounds.clipX).toBe(50)
    expect(bounds.clipWidth).toBe(640 - 120)
  })

  it('reports visible:false with an empty clip when the slot is fully scrolled away', () => {
    const bounds = computePreviewSurfaceBounds({
      ...baseInput,
      clipRects: [{ left: 0, top: 600, width: 1200, height: 200 }]
    })
    expect(bounds.visible).toBe(false)
    expect(bounds.clipWidth).toBe(0)
    expect(bounds.clipHeight).toBe(0)
  })

  it('reports visible:false when the document is hidden regardless of geometry', () => {
    const bounds = computePreviewSurfaceBounds({ ...baseInput, documentVisible: false })
    expect(bounds.visible).toBe(false)
    expect(bounds.clipWidth).toBe(0)
  })

  it('reports visible:false while an open overlay intersects the slot (B3 contract)', () => {
    const occluded = computePreviewSurfaceBounds({ ...baseInput, overlayOccluded: true })
    expect(occluded.visible).toBe(false)
    expect(occluded.clipWidth).toBe(0)
    const restored = computePreviewSurfaceBounds({ ...baseInput, overlayOccluded: false })
    expect(restored.visible).toBe(true)
  })

  it('intersects nested clipping ancestors', () => {
    const bounds = computePreviewSurfaceBounds({
      ...baseInput,
      clipRects: [
        { left: 0, top: 0, width: 500, height: 800 },
        { left: 150, top: 100, width: 1050, height: 700 }
      ]
    })
    expect(bounds.visible).toBe(true)
    expect(bounds.clipX).toBe(50 + 150)
    expect(bounds.clipY).toBe(25 + 100)
    expect(bounds.clipWidth).toBe(500 - 150)
    expect(bounds.clipHeight).toBe(340)
  })

  it('carries devicePixelRatio changes into scaleFactor', () => {
    expect(computePreviewSurfaceBounds({ ...baseInput, scaleFactor: 1 }).scaleFactor).toBe(1)
    expect(computePreviewSurfaceBounds({ ...baseInput, scaleFactor: 2 }).scaleFactor).toBe(2)
  })
})

describe('previewSurfaceBoundsChanged', () => {
  const base = computePreviewSurfaceBounds({
    slotRect: { left: 100, top: 80, width: 640, height: 360 },
    clipRects: [],
    viewportWidth: 1200,
    viewportHeight: 800,
    windowScreenX: 50,
    windowScreenY: 25,
    scaleFactor: 2,
    screenHeight: 1080,
    documentVisible: true
  })

  it('always reports a change from null', () => {
    expect(previewSurfaceBoundsChanged(null, base)).toBe(true)
  })

  it('ignores sub-pixel jitter', () => {
    expect(previewSurfaceBoundsChanged(base, { ...base, screenX: base.screenX + 0.4 })).toBe(false)
  })

  it('detects window moves, clip changes, and visibility flips', () => {
    expect(previewSurfaceBoundsChanged(base, { ...base, screenX: base.screenX + 10 })).toBe(true)
    expect(
      previewSurfaceBoundsChanged(base, { ...base, clipHeight: (base.clipHeight ?? 0) - 40 })
    ).toBe(true)
    expect(previewSurfaceBoundsChanged(base, { ...base, visible: false })).toBe(true)
  })

  it('treats absent clip as full-rect clip so legacy bounds compare cleanly', () => {
    const legacy = {
      screenX: base.screenX,
      screenY: base.screenY,
      width: base.width,
      height: base.height,
      scaleFactor: base.scaleFactor,
      screenHeight: base.screenHeight
    }
    expect(previewSurfaceBoundsChanged(legacy, base)).toBe(false)
  })
})
