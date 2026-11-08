import { describe, expect, it } from 'vitest'

import {
  clampToRange,
  formatValue,
  parseNumericInput,
  stepValue,
  valuePercent,
  type SliderRange
} from './power-slider-math'

const linear: SliderRange = { min: 0, max: 100, step: 5 }
const bipolar: SliderRange = { min: -100, max: 100, step: 1 }
const fine: SliderRange = { min: 0, max: 1, step: 0.1 }

describe('clampToRange', () => {
  it('clamps outside the range to the nearest bound', () => {
    expect(clampToRange(-20, linear)).toBe(0)
    expect(clampToRange(250, linear)).toBe(100)
  })

  it('snaps to the step grid', () => {
    expect(clampToRange(7, linear)).toBe(5)
    expect(clampToRange(8, linear)).toBe(10)
  })

  it('avoids floating-point drift on fractional steps', () => {
    expect(clampToRange(0.1 + 0.2, fine)).toBe(0.3)
    expect(clampToRange(0.7000000001, fine)).toBe(0.7)
  })

  it('guards NaN to min and clamps infinities to their bound', () => {
    expect(clampToRange(Number.NaN, linear)).toBe(0)
    expect(clampToRange(Number.POSITIVE_INFINITY, bipolar)).toBe(100)
    expect(clampToRange(Number.NEGATIVE_INFINITY, bipolar)).toBe(-100)
  })
})

describe('stepValue', () => {
  it('moves by one step in the given direction', () => {
    expect(stepValue(50, linear, 1)).toBe(55)
    expect(stepValue(50, linear, -1)).toBe(45)
  })

  it('moves by a large step on Shift+arrow', () => {
    expect(stepValue(50, linear, 1, { large: true })).toBe(100) // 10 × step = 50, clamped
    expect(stepValue(50, linear, -1, { large: true, largeStep: 20 })).toBe(30)
  })

  it('never leaves the range', () => {
    expect(stepValue(100, linear, 1)).toBe(100)
    expect(stepValue(-100, bipolar, -1)).toBe(-100)
  })
})

describe('parseNumericInput', () => {
  it('returns null for blank or non-numeric input', () => {
    expect(parseNumericInput('', linear)).toBeNull()
    expect(parseNumericInput('   ', linear)).toBeNull()
    expect(parseNumericInput('abc', linear)).toBeNull()
    expect(parseNumericInput('5px', linear)).toBeNull()
  })

  it('parses, clamps, and snaps a valid entry', () => {
    expect(parseNumericInput('  12 ', linear)).toBe(10)
    expect(parseNumericInput('999', linear)).toBe(100)
    expect(parseNumericInput('-250', bipolar)).toBe(-100)
    expect(parseNumericInput('-37', bipolar)).toBe(-37)
  })
})

describe('formatValue', () => {
  it('appends the unit suffix at the step precision', () => {
    expect(formatValue(40, { suffix: 'px', step: 1 })).toBe('40px')
    expect(formatValue(0.3, { suffix: '', step: 0.1 })).toBe('0.3')
    expect(formatValue(33.333, { decimals: 1 })).toBe('33.3')
  })

  it('signs bipolar values, leaving zero and negatives untouched by the plus', () => {
    expect(formatValue(50, { bipolar: true })).toBe('+50')
    expect(formatValue(-50, { bipolar: true })).toBe('-50')
    expect(formatValue(0, { bipolar: true })).toBe('0')
  })
})

describe('valuePercent', () => {
  it('maps the value onto a 0–100 track position', () => {
    expect(valuePercent(0, linear)).toBe(0)
    expect(valuePercent(100, linear)).toBe(100)
    expect(valuePercent(50, linear)).toBe(50)
  })

  it('places the bipolar midpoint at the center', () => {
    expect(valuePercent(0, bipolar)).toBe(50)
  })

  it('clamps out-of-range positions and guards a zero-width range', () => {
    expect(valuePercent(250, linear)).toBe(100)
    expect(valuePercent(5, { min: 5, max: 5, step: 1 })).toBe(0)
  })
})
