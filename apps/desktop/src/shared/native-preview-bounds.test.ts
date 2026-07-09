import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceBounds } from './backend'
import {
  normalizePreviewSurfaceBounds,
  previewSurfaceBoundsChanged,
  previewSurfaceDrawableBoundsChanged,
  previewSurfaceNativeDrawableMatchesBounds
} from './native-preview-bounds'

type FuturePreviewSurfaceBounds = PreviewSurfaceBounds & { futurePlacementToken: string }

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

  it('preserves detached-window stacking fields', () => {
    expect(
      normalizePreviewSurfaceBounds({
        screenX: 10,
        screenY: 20,
        width: 640,
        height: 360,
        scaleFactor: 2,
        orderAboveWindowId: 42,
        elevated: true
      })
    ).toMatchObject({
      orderAboveWindowId: 42,
      elevated: true
    })
  })

  it('preserves unknown future fields while normalizing known fields', () => {
    const futureBounds: FuturePreviewSurfaceBounds = {
      screenX: Number.NaN,
      screenY: 20,
      width: 0,
      height: 360,
      scaleFactor: 2,
      futurePlacementToken: 'keep-me'
    }
    const normalized = normalizePreviewSurfaceBounds(futureBounds) as PreviewSurfaceBounds & {
      futurePlacementToken: string
    }

    expect(normalized.screenX).toBe(0)
    expect(normalized.width).toBe(1)
    expect(normalized.futurePlacementToken).toBe('keep-me')
  })
})

describe('previewSurfaceBoundsChanged', () => {
  const base = normalizePreviewSurfaceBounds({
    screenX: 150,
    screenY: 105,
    width: 640,
    height: 360,
    scaleFactor: 2,
    screenHeight: 1080,
    visible: true
  })

  it('always reports a change from null', () => {
    expect(previewSurfaceBoundsChanged(null, base)).toBe(true)
  })

  it('ignores sub-pixel jitter', () => {
    expect(previewSurfaceBoundsChanged(base, { ...base, screenX: base.screenX + 0.4 })).toBe(false)
  })

  it('detects window moves, clip changes, visibility flips, and stacking changes', () => {
    expect(previewSurfaceBoundsChanged(base, { ...base, screenX: base.screenX + 10 })).toBe(true)
    expect(
      previewSurfaceBoundsChanged(base, { ...base, clipHeight: (base.clipHeight ?? 0) - 40 })
    ).toBe(true)
    expect(previewSurfaceBoundsChanged(base, { ...base, visible: false })).toBe(true)
    expect(previewSurfaceBoundsChanged(base, { ...base, orderAboveWindowId: 42 })).toBe(true)
    expect(previewSurfaceBoundsChanged(base, { ...base, elevated: true })).toBe(true)
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

describe('previewSurfaceDrawableBoundsChanged', () => {
  const base = normalizePreviewSurfaceBounds({
    screenX: 100,
    screenY: 200,
    width: 640,
    height: 360,
    scaleFactor: 2,
    visible: true,
    orderAboveWindowId: 10
  })

  it('ignores absolute movement and z-order for an in-process child layer', () => {
    expect(
      previewSurfaceDrawableBoundsChanged(base, {
        ...base,
        screenX: 500,
        screenY: 600,
        screenHeight: 1440,
        orderAboveWindowId: 99,
        elevated: true
      })
    ).toBe(false)
  })

  it('detects size, scale, and visibility changes that affect the child layer', () => {
    expect(previewSurfaceDrawableBoundsChanged(base, { ...base, width: 800 })).toBe(true)
    expect(previewSurfaceDrawableBoundsChanged(base, { ...base, scaleFactor: 1 })).toBe(true)
    expect(previewSurfaceDrawableBoundsChanged(base, { ...base, visible: false })).toBe(true)
  })
})

describe('previewSurfaceNativeDrawableMatchesBounds', () => {
  const docked = normalizePreviewSurfaceBounds({
    screenX: 100,
    screenY: 200,
    width: 440,
    height: 247,
    scaleFactor: 2,
    visible: true
  })

  it('rejects stale floating drawable metrics after logical bounds already changed to docked', () => {
    expect(
      previewSurfaceNativeDrawableMatchesBounds(
        {
          nativePreviewDrawableWidth: 1440,
          nativePreviewDrawableHeight: 810,
          nativePreviewContentsScale: 2
        },
        docked
      )
    ).toBe(false)
  })

  it('accepts drawable pixels that equal docked points times display scale', () => {
    expect(
      previewSurfaceNativeDrawableMatchesBounds(
        {
          nativePreviewDrawableWidth: 880,
          nativePreviewDrawableHeight: 494,
          nativePreviewContentsScale: 2
        },
        docked
      )
    ).toBe(true)
  })

  it('fails closed while native drawable metrics are unavailable', () => {
    expect(previewSurfaceNativeDrawableMatchesBounds({}, docked)).toBe(false)
  })
})
