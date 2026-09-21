import { describe, expect, it } from 'vitest'

import { MIN_SOURCE_FRACTION } from './stage-transform'
import {
  clampTransformField,
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

describe('clampTransformField', () => {
  it('mirrors the backend position range', () => {
    expect(clampTransformField('x', -5)).toBe(-1)
    expect(clampTransformField('y', 5)).toBe(2)
    expect(clampTransformField('x', 0.4)).toBe(0.4)
  })

  it('keeps sizes between the stage minimum and the canvas', () => {
    expect(clampTransformField('width', 0)).toBe(MIN_SOURCE_FRACTION)
    expect(clampTransformField('height', 3)).toBe(1)
  })
})

describe('transformFieldPatch', () => {
  const committed = { x: 0.6, y: 0.6, width: 0.3, height: 0.2 }

  it('position edits patch only their own axis', () => {
    expect(transformFieldPatch('x', 0.25, committed, true)).toEqual({ x: 0.25 })
    expect(transformFieldPatch('y', 0.1, committed, false)).toEqual({ y: 0.1 })
  })

  it('free size edits patch one axis', () => {
    expect(transformFieldPatch('width', 0.5, committed, false)).toEqual({ width: 0.5 })
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
    // Height would need 2/3 at width=1; the height axis limits at 1 first? No:
    // width 1 gives height 0.6667 which fits, so width is the limiter here.
    expect(transformFieldPatch('width', 2, committed, true)).toEqual({
      width: 1,
      height: 0.6667
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
