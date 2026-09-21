import { describe, expect, it } from 'vitest'

import {
  MIN_SOURCE_FRACTION,
  STAGE_HANDLE_IDS,
  STAGE_SNAP_THRESHOLD,
  handleCursor,
  moveGhost,
  resizeGhost,
  roundRectForCommit,
  stageHandlePoints,
  stageSnapTargets,
  type StageRect
} from './stage-transform'

const box = (x: number, y: number, width = 0.3, height = 0.3): StageRect => ({
  x,
  y,
  width,
  height
})

const noTargets = { x: [], y: [] }

describe('stage snap threshold mirror', () => {
  it('pins the backend SNAP_THRESHOLD (crates/videorc-backend/src/scene.rs)', () => {
    // If this fails, the backend's commit snap and the stage's guides have
    // drifted apart — update BOTH together.
    expect(STAGE_SNAP_THRESHOLD).toBe(0.015)
  })
})

describe('moveGhost', () => {
  it('moves by the pointer delta', () => {
    const { rect } = moveGhost({
      start: box(0.2, 0.2),
      dx: 0.1,
      dy: -0.05,
      constrainAxis: false,
      disableSnap: true,
      targets: noTargets
    })
    expect(rect.x).toBeCloseTo(0.3)
    expect(rect.y).toBeCloseTo(0.15)
    expect(rect.width).toBeCloseTo(0.3)
    expect(rect.height).toBeCloseTo(0.3)
  })

  it('clamps to the canvas', () => {
    const { rect } = moveGhost({
      start: box(0.6, 0.6),
      dx: 0.9,
      dy: 0.9,
      constrainAxis: false,
      disableSnap: true,
      targets: noTargets
    })
    expect(rect.x).toBeCloseTo(0.7)
    expect(rect.y).toBeCloseTo(0.7)
  })

  it('keeps a full-canvas box pinned at the origin', () => {
    const { rect } = moveGhost({
      start: box(0, 0, 1, 1),
      dx: 0.4,
      dy: 0.4,
      constrainAxis: false,
      disableSnap: true,
      targets: noTargets
    })
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(0)
  })

  it('constrains to the dominant axis with Shift', () => {
    const { rect } = moveGhost({
      start: box(0.2, 0.2),
      dx: 0.2,
      dy: 0.04,
      constrainAxis: true,
      disableSnap: true,
      targets: noTargets
    })
    expect(rect.x).toBeCloseTo(0.4)
    expect(rect.y).toBeCloseTo(0.2)
  })

  it('snaps the leading edge to the canvas edge and reports a guide', () => {
    const { rect, guides } = moveGhost({
      start: box(0.2, 0.4),
      dx: -0.19,
      dy: 0,
      constrainAxis: false,
      disableSnap: false,
      targets: stageSnapTargets([])
    })
    expect(rect.x).toBe(0)
    expect(guides).toContainEqual({ axis: 'x', position: 0 })
  })

  it('snaps the box center to the canvas center', () => {
    const start = box(0.2, 0.2, 0.4, 0.4)
    const { rect, guides } = moveGhost({
      start,
      dx: 0.31 - 0.2,
      dy: 0,
      constrainAxis: false,
      disableSnap: false,
      targets: stageSnapTargets([])
    })
    // Center of a 0.4 box at x=0.31 is 0.51, inside the 0.015 magnet of 0.5.
    expect(rect.x).toBeCloseTo(0.3)
    expect(guides).toContainEqual({ axis: 'x', position: 0.5 })
  })

  it('snaps to a sibling edge', () => {
    const sibling = box(0.6, 0.1, 0.3, 0.3)
    const { rect, guides } = moveGhost({
      start: box(0.2, 0.1),
      dx: 0.09,
      dy: 0,
      constrainAxis: false,
      disableSnap: false,
      targets: stageSnapTargets([sibling])
    })
    // Trailing edge lands at 0.59, inside the magnet of the sibling's left edge.
    expect(rect.x + rect.width).toBeCloseTo(0.6)
    expect(guides).toContainEqual({ axis: 'x', position: 0.6 })
  })

  it('does not snap with Alt held', () => {
    const { rect, guides } = moveGhost({
      start: box(0.2, 0.4),
      dx: -0.19,
      dy: 0,
      constrainAxis: false,
      disableSnap: true,
      targets: stageSnapTargets([])
    })
    expect(rect.x).toBeCloseTo(0.01)
    expect(guides).toEqual([])
  })

  it('ignores targets outside the snap threshold', () => {
    const { rect, guides } = moveGhost({
      start: box(0.2, 0.4),
      dx: -0.1,
      dy: 0,
      constrainAxis: false,
      disableSnap: false,
      targets: stageSnapTargets([])
    })
    expect(rect.x).toBeCloseTo(0.1)
    expect(guides).toEqual([])
  })
})

describe('resizeGhost (free aspect)', () => {
  it('pulls the south-east corner', () => {
    const { rect } = resizeGhost({
      start: box(0.1, 0.1),
      handle: 'se',
      dx: 0.2,
      dy: 0.1,
      lockAspect: false
    })
    expect(rect.x).toBeCloseTo(0.1)
    expect(rect.y).toBeCloseTo(0.1)
    expect(rect.width).toBeCloseTo(0.5)
    expect(rect.height).toBeCloseTo(0.4)
  })

  it('pulls the north-west corner, anchoring the south-east', () => {
    const { rect } = resizeGhost({
      start: box(0.2, 0.2),
      handle: 'nw',
      dx: 0.1,
      dy: 0.1,
      lockAspect: false
    })
    expect(rect.x).toBeCloseTo(0.3)
    expect(rect.y).toBeCloseTo(0.3)
    expect(rect.width).toBeCloseTo(0.2)
    expect(rect.height).toBeCloseTo(0.2)
    expect(rect.x + rect.width).toBeCloseTo(0.5)
    expect(rect.y + rect.height).toBeCloseTo(0.5)
  })

  it('edge handles resize one axis only', () => {
    const { rect } = resizeGhost({
      start: box(0.2, 0.2),
      handle: 'e',
      dx: 0.15,
      dy: 0.4,
      lockAspect: false
    })
    expect(rect.width).toBeCloseTo(0.45)
    expect(rect.height).toBeCloseTo(0.3)
    expect(rect.y).toBeCloseTo(0.2)
  })

  it('enforces the minimum size', () => {
    const { rect } = resizeGhost({
      start: box(0.2, 0.2),
      handle: 'se',
      dx: -0.5,
      dy: -0.5,
      lockAspect: false
    })
    expect(rect.width).toBeCloseTo(MIN_SOURCE_FRACTION)
    expect(rect.height).toBeCloseTo(MIN_SOURCE_FRACTION)
  })

  it('never leaves the canvas', () => {
    const { rect } = resizeGhost({
      start: box(0.6, 0.6),
      handle: 'se',
      dx: 0.9,
      dy: 0.9,
      lockAspect: false
    })
    expect(rect.x + rect.width).toBeLessThanOrEqual(1)
    expect(rect.y + rect.height).toBeLessThanOrEqual(1)
  })
})

describe('resizeGhost (aspect locked)', () => {
  it('keeps the aspect on a corner pull', () => {
    const start = box(0.1, 0.1, 0.4, 0.2)
    const { rect } = resizeGhost({
      start,
      handle: 'se',
      dx: 0.2,
      dy: 0,
      lockAspect: true
    })
    expect(rect.width / rect.height).toBeCloseTo(2)
    expect(rect.width).toBeCloseTo(0.6)
    expect(rect.height).toBeCloseTo(0.3)
    expect(rect.x).toBeCloseTo(0.1)
    expect(rect.y).toBeCloseTo(0.1)
  })

  it('keeps the aspect on an edge pull, centered on the other axis', () => {
    const start = box(0.3, 0.4, 0.2, 0.2)
    const { rect } = resizeGhost({
      start,
      handle: 'e',
      dx: 0.1,
      dy: 0,
      lockAspect: true
    })
    expect(rect.width).toBeCloseTo(0.3)
    expect(rect.height).toBeCloseTo(0.3)
    // Vertically centered on the original center (0.5).
    expect(rect.y + rect.height / 2).toBeCloseTo(0.5)
    // Anchored at the untouched left edge.
    expect(rect.x).toBeCloseTo(0.3)
  })

  it('clamps the scale so the anchored box stays on the canvas', () => {
    const start = box(0.5, 0.5, 0.4, 0.4)
    const { rect } = resizeGhost({
      start,
      handle: 'se',
      dx: 0.5,
      dy: 0.5,
      lockAspect: true
    })
    expect(rect.x).toBeCloseTo(0.5)
    expect(rect.y).toBeCloseTo(0.5)
    expect(rect.width).toBeCloseTo(0.5)
    expect(rect.height).toBeCloseTo(0.5)
  })

  it('respects the minimum on shrink', () => {
    const { rect } = resizeGhost({
      start: box(0.2, 0.2, 0.4, 0.2),
      handle: 'nw',
      dx: 0.6,
      dy: 0.6,
      lockAspect: true
    })
    // The limiting axis (height) stops at the minimum; width keeps the 2:1 aspect.
    expect(rect.height).toBeCloseTo(MIN_SOURCE_FRACTION)
    expect(rect.width).toBeCloseTo(MIN_SOURCE_FRACTION * 2)
    // Anchor (south-east corner) holds.
    expect(rect.x + rect.width).toBeCloseTo(0.6)
    expect(rect.y + rect.height).toBeCloseTo(0.4)
  })
})

describe('selection frame helpers', () => {
  it('lays out eight handles on the box perimeter', () => {
    const points = stageHandlePoints(box(0.2, 0.2, 0.4, 0.2))
    expect(points.map((point) => point.id)).toEqual([...STAGE_HANDLE_IDS])
    const se = points.find((point) => point.id === 'se')
    expect(se).toEqual({ id: 'se', x: 0.6000000000000001, y: 0.4 })
    const n = points.find((point) => point.id === 'n')
    expect(n?.x).toBeCloseTo(0.4)
    expect(n?.y).toBeCloseTo(0.2)
  })

  it('maps handles to resize cursors', () => {
    expect(handleCursor('nw')).toBe('nwse-resize')
    expect(handleCursor('sw')).toBe('nesw-resize')
    expect(handleCursor('n')).toBe('ns-resize')
    expect(handleCursor('w')).toBe('ew-resize')
  })

  it('rounds commits to four decimals', () => {
    expect(
      roundRectForCommit({ x: 0.123456, y: 0.6543219, width: 0.3333333, height: 0.1 })
    ).toEqual({ x: 0.1235, y: 0.6543, width: 0.3333, height: 0.1 })
  })
})
