// Unit tests for frame-cadence classification and freeze corroboration.
//
// Run: node --test scripts/lib/frame-cadence.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  STANDARD_FRAME_RATES,
  cadenceMismatch,
  classifyFrameRate,
  corroborateFreezes,
  longestSegmentSeconds
} from './frame-cadence.mjs'

describe('classifyFrameRate', () => {
  it('snaps NTSC film rate exactly', () => {
    const result = classifyFrameRate(24000 / 1001)
    assert.equal(result.label, '23.976p (NTSC film)')
    assert.ok(result.deviationPct < 0.001)
  })

  it('snaps a slightly-decayed measurement (23.7 within 2%) only when tolerance allows', () => {
    assert.equal(classifyFrameRate(23.7), null) // default 0.5% tolerance: unstable
    const loose = classifyFrameRate(23.7, 2)
    assert.equal(loose.label, '23.976p (NTSC film)')
  })

  it('distinguishes 23.976 from 24 and 29.97 from 30', () => {
    assert.equal(classifyFrameRate(24).label, '24p (film)')
    assert.equal(classifyFrameRate(30000 / 1001).label, '29.97p (NTSC)')
    assert.equal(classifyFrameRate(30).label, '30p')
    assert.equal(classifyFrameRate(60000 / 1001).label, '59.94p (NTSC)')
  })

  it('returns null for garbage input', () => {
    assert.equal(classifyFrameRate(null), null)
    assert.equal(classifyFrameRate(0), null)
    assert.equal(classifyFrameRate(Number.NaN), null)
    assert.equal(classifyFrameRate(17), null)
  })

  it('covers every standard rate round-trip', () => {
    for (const { fps, label } of STANDARD_FRAME_RATES) {
      assert.equal(classifyFrameRate(fps).label, label)
    }
  })
})

describe('cadenceMismatch', () => {
  it('flags a 23.976p file against a 30fps intent (the 2026-07 incident shape)', () => {
    const mismatch = cadenceMismatch(24000 / 1001, 30)
    assert.ok(mismatch)
    assert.equal(mismatch.containerLabel, '23.976p (NTSC film)')
    assert.ok(mismatch.deviationPct > 19 && mismatch.deviationPct < 21)
  })

  it('treats the NTSC offset as matching (29.97 vs 30, 23.976 vs 24)', () => {
    assert.equal(cadenceMismatch(30000 / 1001, 30), null)
    assert.equal(cadenceMismatch(24000 / 1001, 24), null)
    assert.equal(cadenceMismatch(60000 / 1001, 60), null)
  })

  it('returns null when either rate is missing', () => {
    assert.equal(cadenceMismatch(null, 30), null)
    assert.equal(cadenceMismatch(30, undefined), null)
    assert.equal(cadenceMismatch(0, 30), null)
  })

  it('respects a custom tolerance', () => {
    assert.equal(cadenceMismatch(29, 30, 5), null)
    assert.ok(cadenceMismatch(29, 30, 2))
  })
})

describe('corroborateFreezes', () => {
  const freezes = [
    { start: 10.0, duration: 0.5 },
    { start: 42.0, duration: 1.0 }
  ]

  it('marks a freeze corroborated when an exact-repeat burst overlaps it', () => {
    // 30fps: frames 300..315 = 10.0s..10.5s — overlaps the first freeze only.
    const bursts = [{ startIndex: 300, run: 15 }]
    const { corroborated, similarityOnly } = corroborateFreezes(freezes, bursts, 30)
    assert.deepEqual(corroborated, [freezes[0]])
    assert.deepEqual(similarityOnly, [freezes[1]])
  })

  it('everything is similarity-only when there are zero exact repeats', () => {
    const { corroborated, similarityOnly } = corroborateFreezes(freezes, [], 30)
    assert.equal(corroborated.length, 0)
    assert.equal(similarityOnly.length, 2)
  })

  it('tolerates one frame interval of slack at burst edges', () => {
    // Burst frames 316..320 (10.533s..10.667s) sits just past freeze end 10.5s;
    // the ±1-frame window (33ms at 30fps) still counts it as overlapping.
    const bursts = [{ startIndex: 316, run: 4 }]
    const { corroborated } = corroborateFreezes([{ start: 10.0, duration: 0.5 }], bursts, 30)
    assert.equal(corroborated.length, 1)
  })

  it('falls back to similarity-only without a usable fps', () => {
    const bursts = [{ startIndex: 300, run: 15 }]
    const { corroborated, similarityOnly } = corroborateFreezes(freezes, bursts, null)
    assert.equal(corroborated.length, 0)
    assert.equal(similarityOnly.length, 2)
  })

  it('handles empty freeze lists', () => {
    const result = corroborateFreezes([], [{ startIndex: 0, run: 5 }], 30)
    assert.deepEqual(result, { corroborated: [], similarityOnly: [] })
  })
})

describe('longestSegmentSeconds', () => {
  it('returns the longest duration and 0 for empty input', () => {
    assert.equal(longestSegmentSeconds([{ duration: 0.2 }, { duration: 1.4 }]), 1.4)
    assert.equal(longestSegmentSeconds([]), 0)
    assert.equal(longestSegmentSeconds(null), 0)
  })
})
