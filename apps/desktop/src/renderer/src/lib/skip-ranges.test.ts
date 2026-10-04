import { describe, expect, it } from 'vitest'

import {
  keptDurationMs,
  normalizeSkipRanges,
  skipTargetMs,
  skippedDurationMs,
  type SkipRange
} from './skip-ranges'

describe('normalizeSkipRanges', () => {
  it('sorts, merges touching and overlapping ranges, and drops empty ones', () => {
    expect(
      normalizeSkipRanges([
        { startMs: 5_000, endMs: 6_000 },
        { startMs: 1_000, endMs: 2_000 },
        { startMs: 2_000, endMs: 3_000 },
        { startMs: 2_500, endMs: 2_700 },
        { startMs: 4_000, endMs: 4_000 }
      ])
    ).toEqual([
      { startMs: 1_000, endMs: 3_000 },
      { startMs: 5_000, endMs: 6_000 }
    ])
  })

  it('clamps to the recording and ignores garbage', () => {
    expect(
      normalizeSkipRanges(
        [
          { startMs: -500, endMs: 200 },
          { startMs: 9_000, endMs: 20_000 },
          { startMs: Number.NaN, endMs: 100 },
          { startMs: 300, endMs: Number.POSITIVE_INFINITY },
          { startMs: 700, endMs: 600 }
        ],
        10_000
      )
    ).toEqual([
      { startMs: 0, endMs: 200 },
      { startMs: 9_000, endMs: 10_000 }
    ])
    // Without a known duration nothing is clamped at the end.
    expect(normalizeSkipRanges([{ startMs: 9_000, endMs: 20_000 }])).toEqual([
      { startMs: 9_000, endMs: 20_000 }
    ])
    expect(normalizeSkipRanges(undefined)).toEqual([])
    expect(normalizeSkipRanges([], 1_000)).toEqual([])
  })

  it('does not mutate its input', () => {
    const input: SkipRange[] = [
      { startMs: 2_000, endMs: 3_000 },
      { startMs: 1_000, endMs: 2_500 }
    ]
    normalizeSkipRanges(input)
    expect(input).toEqual([
      { startMs: 2_000, endMs: 3_000 },
      { startMs: 1_000, endMs: 2_500 }
    ])
  })
})

describe('skipTargetMs', () => {
  const ranges = normalizeSkipRanges([
    { startMs: 1_000, endMs: 2_000 },
    { startMs: 2_000, endMs: 3_000 },
    { startMs: 10_000, endMs: 12_000 }
  ])

  it('jumps to the end of the merged range the playhead is in', () => {
    expect(skipTargetMs(ranges, 1_000)).toBe(3_000)
    expect(skipTargetMs(ranges, 1_500)).toBe(3_000)
    expect(skipTargetMs(ranges, 2_999)).toBe(3_000)
    expect(skipTargetMs(ranges, 11_000)).toBe(12_000)
  })

  it('leaves kept content alone, including the exact end of a range', () => {
    expect(skipTargetMs(ranges, 0)).toBeNull()
    expect(skipTargetMs(ranges, 999)).toBeNull()
    expect(skipTargetMs(ranges, 3_000)).toBeNull()
    expect(skipTargetMs(ranges, 5_000)).toBeNull()
    expect(skipTargetMs(ranges, 12_000)).toBeNull()
    expect(skipTargetMs(ranges, 99_999)).toBeNull()
    expect(skipTargetMs([], 1_500)).toBeNull()
    expect(skipTargetMs(ranges, Number.NaN)).toBeNull()
  })

  it('never points backwards, so consecutive ranges cannot loop', () => {
    for (const position of [1_000, 1_999, 2_000, 2_001, 10_000, 11_999]) {
      const target = skipTargetMs(ranges, position)
      expect(target).not.toBeNull()
      expect(target!).toBeGreaterThan(position)
      // Landing on the target is kept content: no second jump.
      expect(skipTargetMs(ranges, target!)).toBeNull()
    }
  })

  it('treats a position within the lookahead as already inside the range', () => {
    expect(skipTargetMs(ranges, 970, 40)).toBe(3_000)
    expect(skipTargetMs(ranges, 950, 40)).toBeNull()
  })
})

describe('durations', () => {
  it('sums removed time and reports what is left of the recording', () => {
    const ranges = [
      { startMs: 1_000, endMs: 3_000 },
      { startMs: 10_000, endMs: 12_000 }
    ]
    expect(skippedDurationMs(ranges)).toBe(4_000)
    expect(keptDurationMs(20_000, ranges)).toBe(16_000)
    // Ranges past the end count only up to the end.
    expect(keptDurationMs(11_000, ranges)).toBe(8_000)
    expect(keptDurationMs(0, ranges)).toBe(0)
    expect(keptDurationMs(Number.NaN, ranges)).toBe(0)
  })
})
