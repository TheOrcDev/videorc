import { describe, expect, it } from 'vitest'

import {
  SCREEN_ZOOM_HINT,
  SCREEN_ZOOM_MAX,
  SCREEN_ZOOM_MIN,
  screenZoomOf,
  screenZoomPatch
} from './screen-zoom'

// Plan 215 E4 (D2): the screen's Zoom slider, 100 to 400%, scales the box
// around its centre.

describe('screenZoomOf', () => {
  it('reads the longer side as a percent of the canvas', () => {
    expect(screenZoomOf({ x: 0, y: 0, width: 1, height: 1 })).toBe(100)
    expect(screenZoomOf({ x: -0.25, y: -0.25, width: 1.5, height: 1.5 })).toBe(150)
    expect(screenZoomOf({ x: -1.5, y: -1.5, width: 4, height: 4 })).toBe(400)
    expect(screenZoomOf({ x: 0, y: 0.2, width: 2, height: 0.6 })).toBe(200)
  })

  it('reads 100 for a box smaller than the canvas, the slider floor', () => {
    expect(screenZoomOf({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })).toBe(100)
  })

  it('runs 100 to 400 and names what zooming does', () => {
    expect([SCREEN_ZOOM_MIN, SCREEN_ZOOM_MAX]).toEqual([100, 400])
    expect(SCREEN_ZOOM_HINT).toBe('Zooming softens text. Crop to show part of the screen sharply.')
  })
})

describe('screenZoomPatch', () => {
  it('keeps the centre and the aspect while it scales the box', () => {
    const full = { x: 0, y: 0, width: 1, height: 1 }
    expect(screenZoomPatch(full, 200)).toEqual({ x: -0.5, y: -0.5, width: 2, height: 2 })
    expect(screenZoomPatch(full, 400)).toEqual({ x: -1.5, y: -1.5, width: 4, height: 4 })
    // A box already off-centre keeps its own centre.
    const offCentre = { x: 0, y: 0.3, width: 1, height: 0.45 }
    const zoomed = screenZoomPatch(offCentre, 300)
    expect(zoomed.width).toBeCloseTo(3)
    expect(zoomed.height).toBeCloseTo(1.35)
    expect(zoomed.x + zoomed.width / 2).toBeCloseTo(0.5)
    expect(zoomed.y + zoomed.height / 2).toBeCloseTo(0.525)
    // Back to 100 undoes it.
    expect(screenZoomPatch(zoomed, 100)).toEqual(offCentre)
    // A box smaller than the canvas grows to the canvas at 100: Zoom is the
    // longer side's share of the canvas, never below the slider's floor.
    expect(screenZoomPatch({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 100)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1
    })
  })

  it('clamps to the slider range and rounds as a commit does', () => {
    const full = { x: 0, y: 0, width: 1, height: 1 }
    expect(screenZoomPatch(full, 50)).toEqual(full)
    expect(screenZoomPatch(full, 900)).toEqual({ x: -1.5, y: -1.5, width: 4, height: 4 })
    expect(screenZoomPatch({ x: 0.1234567, y: 0, width: 1, height: 0.5625 }, 100)).toEqual({
      x: 0.1235,
      y: 0,
      width: 1,
      height: 0.5625
    })
  })

  it('keeps 5% of the canvas covered, like a drag would', () => {
    // A box whose centre sits past the canvas's right edge: zoomed, its
    // left edge would pass that edge too; it stays 5% in.
    const past = { x: 2, y: 0, width: 1, height: 0.5625 }
    expect(screenZoomPatch(past, 100)).toEqual({ x: 0.95, y: 0, width: 1, height: 0.5625 })
    // And a 400% box keeps at least 5% of the canvas on each axis.
    expect(screenZoomPatch({ x: -3, y: -3, width: 1, height: 1 }, 400)).toEqual({
      x: -3,
      y: -3,
      width: 4,
      height: 4
    })
  })
})
