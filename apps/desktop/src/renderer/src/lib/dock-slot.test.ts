import { describe, expect, it } from 'vitest'

import {
  buildDockSlotReport,
  clipRectOf,
  dockSlotReportChanged,
  measureDockSlot,
  overlaysOccludeSlot,
  rectsIntersect
} from './dock-slot'

const viewport = { width: 1180, height: 780 }

describe('measureDockSlot', () => {
  it('reports full visibility for an on-screen slot', () => {
    const { visibleFraction } = measureDockSlot(
      { x: 240, y: 96, width: 800, height: 450 },
      viewport
    )
    expect(visibleFraction).toBe(1)
  })

  it('reports the visible fraction when the slot scrolls above the viewport', () => {
    const { visibleFraction } = measureDockSlot(
      { x: 0, y: -225, width: 800, height: 450 },
      viewport
    )
    expect(visibleFraction).toBeCloseTo(0.5)
  })

  it('reports zero when fully off-screen or zero-area', () => {
    expect(
      measureDockSlot({ x: 0, y: -500, width: 800, height: 450 }, viewport).visibleFraction
    ).toBe(0)
    expect(measureDockSlot({ x: 0, y: 0, width: 0, height: 450 }, viewport).visibleFraction).toBe(0)
  })

  // The pane that scrolls starts under the 40 px toolbar: a slot scrolled a
  // little under its top edge is still inside the window, and the native
  // surface (clipped by no DOM) would paint over the toolbar unless the
  // pane's clip counts (probe:preview-window, dock-scroll-edge).
  it('counts the clipping pane, not only the viewport', () => {
    const pane = { x: 0, y: 40, width: 1180, height: 714 }
    const slot = { x: 224, y: 12, width: 619, height: 348 }
    expect(measureDockSlot(slot, viewport).visibleFraction).toBe(1)
    expect(measureDockSlot(slot, viewport, pane).visibleFraction).toBeCloseTo((348 - 28) / 348, 5)
  })

  it('shows nothing of a slot its ancestors clip away entirely', () => {
    const slot = { x: 224, y: 56, width: 619, height: 348 }
    expect(
      measureDockSlot(slot, viewport, { x: 0, y: 0, width: 0, height: 0 }).visibleFraction
    ).toBe(0)
  })
})

describe('clipRectOf', () => {
  it('intersects nested boxes and reports no area for disjoint ones', () => {
    expect(
      clipRectOf([
        { x: 0, y: 40, width: 1180, height: 714 },
        { x: 100, y: 0, width: 600, height: 400 }
      ])
    ).toEqual({ x: 100, y: 40, width: 600, height: 360 })
    expect(
      clipRectOf([
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 200, y: 200, width: 100, height: 100 }
      ])
    ).toBeNull()
    expect(clipRectOf([])).toBeNull()
  })
})

describe('dockSlotReportChanged', () => {
  const base = buildDockSlotReport(
    2,
    'studio',
    { rect: { x: 240, y: 96, width: 800, height: 450 }, visibleFraction: 1 },
    true
  )

  it('always sends the first report', () => {
    expect(dockSlotReportChanged(null, base)).toBe(true)
  })

  it('carries the slot the report was measured in', () => {
    expect(base.slot).toBe('studio')
    expect(
      buildDockSlotReport(
        2,
        'scene',
        { rect: { x: 0, y: 0, width: 10, height: 10 }, visibleFraction: 1 },
        true
      ).slot
    ).toBe('scene')
  })

  it('sends when the slot changes even at the same rect', () => {
    expect(dockSlotReportChanged(base, { ...base, slot: 'scene' })).toBe(true)
  })

  it('swallows sub-pixel jitter', () => {
    expect(
      dockSlotReportChanged(base, { ...base, x: 240.4, y: 96.3, visibleFraction: 0.999 })
    ).toBe(false)
  })

  it('sends on >=1px moves, epoch bumps, unmounts, and 1% fraction steps', () => {
    expect(dockSlotReportChanged(base, { ...base, y: 97.2 })).toBe(true)
    expect(dockSlotReportChanged(base, { ...base, epoch: 3 })).toBe(true)
    expect(dockSlotReportChanged(base, { ...base, mounted: false })).toBe(true)
    expect(dockSlotReportChanged(base, { ...base, visibleFraction: 0.97 })).toBe(true)
  })
})

describe('overlay occlusion', () => {
  const slot = { x: 240, y: 96, width: 800, height: 450 }

  it('any open scrim occludes regardless of geometry', () => {
    expect(overlaysOccludeSlot(1, [], slot)).toBe(true)
    expect(overlaysOccludeSlot(1, [], null)).toBe(true)
  })

  it('popper content occludes only when it overlaps the slot', () => {
    expect(overlaysOccludeSlot(0, [{ x: 250, y: 100, width: 200, height: 300 }], slot)).toBe(true)
    expect(overlaysOccludeSlot(0, [{ x: 0, y: 600, width: 200, height: 150 }], slot)).toBe(false)
    // Zero-sized popper rects (mid-mount) never occlude.
    expect(overlaysOccludeSlot(0, [{ x: 250, y: 100, width: 0, height: 0 }], slot)).toBe(false)
  })

  it('rectsIntersect treats touching edges as non-overlapping', () => {
    expect(rectsIntersect(slot, { x: 240 + 800, y: 96, width: 10, height: 10 })).toBe(false)
  })
})
