import { describe, expect, it } from 'vitest'

import { MIN_SOURCE_FRACTION } from './stage-transform'
import {
  clampTransformField,
  cropFieldPatch,
  formatPercentValue,
  parsePercentValue,
  pixelReadout,
  transformFieldPatch
} from './transform-fields-math'

describe('formatPercentValue', () => {
  it('renders whole percents without a decimal', () => {
    expect(formatPercentValue(0.5)).toBe('50')
    expect(formatPercentValue(1)).toBe('100')
    expect(formatPercentValue(0)).toBe('0')
  })

  it('keeps one decimal for fractional percents', () => {
    expect(formatPercentValue(0.1234)).toBe('12.3')
    expect(formatPercentValue(0.0505)).toBe('5.1')
  })
})

describe('parsePercentValue', () => {
  it('parses plain numbers as percent', () => {
    expect(parsePercentValue('50')).toBeCloseTo(0.5)
    expect(parsePercentValue(' 12.3 ')).toBeCloseTo(0.123)
  })

  it('accepts a trailing percent sign and comma decimals', () => {
    expect(parsePercentValue('75%')).toBeCloseTo(0.75)
    expect(parsePercentValue('12,5')).toBeCloseTo(0.125)
  })

  it('rejects non-numbers', () => {
    expect(parsePercentValue('')).toBeNull()
    expect(parsePercentValue('abc')).toBeNull()
    expect(parsePercentValue('1/2')).toBeNull()
  })
})

describe('clampTransformField (plan 215 E3)', () => {
  it('mirrors the backend position range', () => {
    expect(clampTransformField('x', -5)).toBe(-3)
    expect(clampTransformField('y', 5)).toBe(4)
    expect(clampTransformField('x', 0.4)).toBe(0.4)
    expect(clampTransformField('x', -0.25)).toBe(-0.25)
  })

  it('keeps sizes between the stage minimum and 400% of the canvas', () => {
    expect(clampTransformField('width', 0)).toBe(MIN_SOURCE_FRACTION)
    expect(clampTransformField('height', 3)).toBe(3)
    expect(clampTransformField('height', 9)).toBe(4)
  })
})

describe('transformFieldPatch', () => {
  const committed = { x: 0.6, y: 0.6, width: 0.3, height: 0.2 }

  it('position edits patch only their own axis', () => {
    expect(transformFieldPatch('x', 0.25, committed, true)).toEqual({ x: 0.25 })
    expect(transformFieldPatch('y', 0.1, committed, false)).toEqual({ y: 0.1 })
  })

  it('a position edit may hang the box off the canvas, keeping 5% of it covered', () => {
    // The box (0.3 wide) may start 0.25 left of the canvas: 0.05 stays on.
    expect(transformFieldPatch('x', -0.25, committed, false)).toEqual({ x: -0.25 })
    expect(transformFieldPatch('x', -0.9, committed, false)).toEqual({ x: -0.25 })
    // And end 0.05 in from the right edge.
    expect(transformFieldPatch('y', 3, committed, false)).toEqual({ y: 0.95 })
    // A 400% box may sit anywhere its bounds allow.
    const huge = { x: -1.5, y: -1.5, width: 4, height: 4 }
    expect(transformFieldPatch('x', -3, huge, false)).toEqual({ x: -3 })
    expect(transformFieldPatch('x', -3.5, huge, false)).toEqual({ x: -3 })
    expect(transformFieldPatch('x', 0.95, huge, false)).toEqual({ x: 0.95 })
  })

  it('free size edits patch one axis', () => {
    expect(transformFieldPatch('width', 0.5, committed, false)).toEqual({ width: 0.5 })
    // Up to 400% of the canvas: the box grows to the right from its place.
    expect(transformFieldPatch('width', 4, committed, false)).toEqual({ width: 4 })
    expect(transformFieldPatch('width', 9, committed, false)).toEqual({ width: 4 })
  })

  it('a size edit that would leave less than 5% of the canvas covered moves the box back on', () => {
    // At x 0.97 a width of 0.3 keeps 0.03 on the canvas; shrinking to 0.1
    // would leave 0.03 still, so the box slides to 0.95.
    expect(transformFieldPatch('width', 0.1, { ...committed, x: 0.97 }, false)).toEqual({
      width: 0.1,
      x: 0.95
    })
  })

  it('locked size edits scale both axes around the committed aspect', () => {
    expect(transformFieldPatch('width', 0.6, committed, true)).toEqual({
      width: 0.6,
      height: 0.4
    })
    expect(transformFieldPatch('height', 0.1, committed, true)).toEqual({
      width: 0.15,
      height: 0.1
    })
  })

  it('locked edits clamp to the limiting axis and keep the aspect', () => {
    // Width 4 (the 400% ceiling) gives height 2.6667, which fits, so width
    // is the limiter here (plan 215 E3; before, the canvas was).
    expect(transformFieldPatch('width', 9, committed, true)).toEqual({
      width: 4,
      height: 2.6667
    })
    expect(transformFieldPatch('width', 2, committed, true)).toEqual({
      width: 2,
      height: 1.3333
    })
    // Shrinking: the height axis hits the 5% floor first (aspect 1.5).
    expect(transformFieldPatch('width', 0.01, committed, true)).toEqual({
      width: 0.075,
      height: 0.05
    })
  })
})

describe('pixelReadout', () => {
  it('projects the normalized box onto the output canvas', () => {
    expect(pixelReadout({ x: 0, y: 0, width: 0.2, height: 0.3 }, 1920, 1080)).toBe(
      '384 × 324 px on 1920 × 1080'
    )
  })
})

describe('cropFieldPatch (plan 213 G2)', () => {
  const none = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }

  it('commits the one side, as a share of the picture', () => {
    expect(cropFieldPatch('cropLeft', 0.125, none)).toEqual({ cropLeft: 0.125 })
    expect(cropFieldPatch('cropBottom', 0.33333, none)).toEqual({ cropBottom: 0.3333 })
  })

  it('never crops below nothing or past 5% of the picture beside the other side', () => {
    expect(cropFieldPatch('cropTop', -0.2, none)).toEqual({ cropTop: 0 })
    expect(cropFieldPatch('cropRight', 1.2, none)).toEqual({ cropRight: 0.95 })
    expect(cropFieldPatch('cropRight', 0.9, { ...none, cropLeft: 0.6 })).toEqual({
      cropRight: 0.35
    })
    // The other axis does not limit it.
    expect(cropFieldPatch('cropLeft', 0.5, { ...none, cropTop: 0.9 })).toEqual({ cropLeft: 0.5 })
  })
})
