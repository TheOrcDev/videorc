import { describe, expect, it } from 'vitest'

import { colourAlpha, compareRasterOrder, fitSourceRect } from './room-program-raster'

// Plan 249 S23: the Program preview's raster follows CSS: object-fit,
// stacking and painted colours.

describe('room program raster', () => {
  it('fills, covers and contains like object-fit', () => {
    const box = { x: 10, y: 20, w: 160, h: 90 }
    expect(fitSourceRect({ w: 640, h: 480 }, box, 'fill')).toEqual({
      sx: 0,
      sy: 0,
      sw: 640,
      sh: 480,
      dx: 10,
      dy: 20,
      dw: 160,
      dh: 90
    })
    // A 4:3 camera covering a 16:9 tile loses its top and bottom.
    const cover = fitSourceRect({ w: 640, h: 480 }, box, 'cover')!
    expect(cover).toMatchObject({ sx: 0, sw: 640, dx: 10, dy: 20, dw: 160, dh: 90 })
    expect(cover.sy).toBeCloseTo(60)
    expect(cover.sh).toBeCloseTo(360)
    // A 4:3 screen contained in a 16:9 tile is pillarboxed.
    const contain = fitSourceRect({ w: 640, h: 480 }, box, 'contain')!
    expect(contain).toMatchObject({ sx: 0, sy: 0, sw: 640, sh: 480, dy: 20, dh: 90 })
    expect(contain.dw).toBeCloseTo(120)
    expect(contain.dx).toBeCloseTo(30)
    // scale-down never enlarges.
    expect(fitSourceRect({ w: 80, h: 45 }, box, 'scale-down')).toMatchObject({ dw: 80, dh: 45 })
    expect(fitSourceRect({ w: 0, h: 45 }, box, 'fill')).toBeNull()
    expect(fitSourceRect({ w: 80, h: 45 }, { ...box, w: 0 }, 'cover')).toBeNull()
  })

  it('stacks by z-index path, then document order', () => {
    const op = (z: number[], order: number) => ({ clips: [], opacity: 1, z, order })
    const ops = [op([2], 0), op([1, 5], 1), op([1], 2), op([], 3), op([1, 5], 4)]
    expect([...ops].sort(compareRasterOrder).map((entry) => entry.order)).toEqual([3, 2, 1, 4, 0])
  })

  it('reads a computed colour alpha', () => {
    expect(colourAlpha('rgb(1, 2, 3)')).toBe(1)
    expect(colourAlpha('rgba(1, 2, 3, 0.25)')).toBe(0.25)
    expect(colourAlpha('rgba(0, 0, 0, 0)')).toBe(0)
    expect(colourAlpha('rgb(1 2 3 / 50%)')).toBe(0.5)
    expect(colourAlpha('transparent')).toBe(0)
    expect(colourAlpha('')).toBe(0)
  })
})
