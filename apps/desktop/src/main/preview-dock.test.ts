import { describe, expect, it } from 'vitest'

import {
  DOCK_SLOT_MIN_VISIBLE_FRACTION,
  composeDockedScreenRect,
  decideDockVisibility,
  parseDockSlotReport,
  parsePreviewWindowMode,
  type DockSlotReport,
  type DockVisibilityInput
} from './preview-dock'

const slot: DockSlotReport = {
  epoch: 3,
  x: 240,
  y: 96,
  width: 800,
  height: 450,
  visibleFraction: 1,
  mounted: true
}

const visibleInput: DockVisibilityInput = {
  slot,
  currentEpoch: 3,
  mainWindowVisible: true,
  mainWindowMinimized: false,
  mainWindowFullScreen: false,
  overlayOpen: false
}

describe('parsePreviewWindowMode', () => {
  it('defaults legacy prefs without a mode to floating', () => {
    expect(parsePreviewWindowMode(undefined)).toBe('floating')
    expect(parsePreviewWindowMode(null)).toBe('floating')
    expect(parsePreviewWindowMode('attached')).toBe('floating')
  })

  it('accepts docked', () => {
    expect(parsePreviewWindowMode('docked')).toBe('docked')
  })
})

describe('parseDockSlotReport', () => {
  it('round-trips a well-formed report', () => {
    expect(parseDockSlotReport({ ...slot })).toEqual(slot)
  })

  it('rejects non-objects and missing/non-finite numbers', () => {
    expect(parseDockSlotReport(null)).toBeNull()
    expect(parseDockSlotReport('rect')).toBeNull()
    expect(parseDockSlotReport({ ...slot, x: Number.NaN })).toBeNull()
    expect(parseDockSlotReport({ ...slot, epoch: undefined })).toBeNull()
    expect(parseDockSlotReport({ ...slot, width: Infinity })).toBeNull()
  })

  it('clamps dimensions and visibleFraction into range', () => {
    const parsed = parseDockSlotReport({ ...slot, width: -20, visibleFraction: 1.4 })
    expect(parsed).toMatchObject({ width: 0, visibleFraction: 1 })
    expect(parseDockSlotReport({ ...slot, visibleFraction: -0.1 })?.visibleFraction).toBe(0)
  })

  it('treats a missing mounted flag as unmounted', () => {
    expect(parseDockSlotReport({ ...slot, mounted: undefined })?.mounted).toBe(false)
  })
})

describe('composeDockedScreenRect', () => {
  it('offsets the window-relative slot by the main content origin', () => {
    expect(composeDockedScreenRect(slot, { x: 100, y: 50, width: 1280, height: 800 })).toEqual({
      x: 340,
      y: 146,
      width: 800,
      height: 450
    })
  })

  it('rounds fractional CSS coordinates to whole pixels', () => {
    expect(
      composeDockedScreenRect(
        { x: 10.4, y: 7.6, width: 300.5, height: 168.9 },
        { x: 0.0, y: 25, width: 1180, height: 780 }
      )
    ).toEqual({ x: 10, y: 33, width: 301, height: 169 })
  })

  it('never produces a zero-sized frame', () => {
    const rect = composeDockedScreenRect(
      { x: 0, y: 0, width: 0.2, height: 0 },
      { x: 0, y: 0, width: 1180, height: 780 }
    )
    expect(rect.width).toBeGreaterThanOrEqual(1)
    expect(rect.height).toBeGreaterThanOrEqual(1)
  })
})

describe('decideDockVisibility', () => {
  it('shows a mounted, fully visible slot with a current epoch', () => {
    expect(decideDockVisibility(visibleInput)).toEqual({ visible: true, hiddenReason: null })
  })

  it('rejects stale-epoch reports (the glue attempt race)', () => {
    // A report measured before a redock must not resurface the old placement.
    expect(decideDockVisibility({ ...visibleInput, currentEpoch: 4 })).toEqual({
      visible: false,
      hiddenReason: 'no-slot-report'
    })
  })

  it('hides with no-slot-report until the renderer answers a dock engage', () => {
    expect(decideDockVisibility({ ...visibleInput, slot: null }).hiddenReason).toBe(
      'no-slot-report'
    )
  })

  it('hides when the slot unmounts (tab switch)', () => {
    expect(
      decideDockVisibility({ ...visibleInput, slot: { ...slot, mounted: false } }).hiddenReason
    ).toBe('slot-unmounted')
  })

  it('hides instead of clipping when scrolled below the visibility floor', () => {
    expect(
      decideDockVisibility({
        ...visibleInput,
        slot: { ...slot, visibleFraction: DOCK_SLOT_MIN_VISIBLE_FRACTION - 0.01 }
      }).hiddenReason
    ).toBe('scrolled-away')
    expect(
      decideDockVisibility({
        ...visibleInput,
        slot: { ...slot, visibleFraction: DOCK_SLOT_MIN_VISIBLE_FRACTION }
      }).visible
    ).toBe(true)
  })

  it('hides for zero-area slots', () => {
    expect(
      decideDockVisibility({ ...visibleInput, slot: { ...slot, height: 0 } }).hiddenReason
    ).toBe('scrolled-away')
  })

  it('hides while a blocking overlay is open', () => {
    expect(decideDockVisibility({ ...visibleInput, overlayOpen: true }).hiddenReason).toBe(
      'overlay-open'
    )
  })

  it('hides with the main window (hidden or minimized), outranking slot reasons', () => {
    expect(
      decideDockVisibility({ ...visibleInput, mainWindowVisible: false, slot: null }).hiddenReason
    ).toBe('main-window-hidden')
    expect(decideDockVisibility({ ...visibleInput, mainWindowMinimized: true }).hiddenReason).toBe(
      'main-window-hidden'
    )
  })

  it('hides in fullscreen with its own reason', () => {
    expect(decideDockVisibility({ ...visibleInput, mainWindowFullScreen: true }).hiddenReason).toBe(
      'main-window-fullscreen'
    )
  })
})
