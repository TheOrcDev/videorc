import { describe, expect, it } from 'vitest'
import { stagePixelSize, stagePoint, type StageMapping } from './stage-viewport'

describe('painted SVG mapping', () => {
  it.each([
    { a: 3, b: 0, c: 0, d: 3, e: 20, f: 40, width: 160, height: 90 },
    // 9:16 viewBox in a wide viewport; its painted width is only 236px.
    { a: 1.4765625, b: 0, c: 0, d: 1.4765625, e: 142, f: 40, width: 160, height: 284.444444 }
  ])('tracks CSS displacement 1:1 including portrait letterboxing', (mapping) => {
    const start = stagePoint(mapping, 200, 160)!
    const next = stagePoint(mapping, 231, 179)!
    const pixels = stagePixelSize(mapping)
    expect((next.x - start.x) * pixels.width).toBeCloseTo(31)
    expect((next.y - start.y) * pixels.height).toBeCloseTo(19)
  })
  it('inverts translation, scale and rotation', () => {
    const mapping = { a: 0, b: 2, c: -2, d: 0, e: 30, f: 50, width: 100, height: 100 }
    expect(stagePoint(mapping, -70, 150)).toEqual({ x: 0.5, y: 0.5 })
  })
  it.each([0, NaN, Infinity])('rejects invalid transforms %s', (value) => {
    const mapping: StageMapping = { a: value, b: 0, c: 0, d: 1, e: 0, f: 0, width: 160, height: 90 }
    expect(stagePoint(mapping, 10, 10)).toBeNull()
  })
})
