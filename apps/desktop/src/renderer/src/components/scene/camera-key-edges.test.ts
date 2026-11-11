import { describe, expect, it } from 'vitest'

import { normalizeCameraKeyEdges, normalizeLayoutSettings } from '@/lib/capture'

import {
  cameraKeyEdgesOf,
  cameraKeyEdgesPatch,
  cameraKeyEdgesSet,
  parseCameraKeyEdgePct
} from './camera-key-edges'

const NONE = { leftPct: 0, topPct: 0, rightPct: 0, bottomPct: 0 }

describe('Hide edges (plan 227 B)', () => {
  it('reads a typed side as a whole percent from 0 to 25', () => {
    expect(parseCameraKeyEdgePct('2')).toBe(2)
    expect(parseCameraKeyEdgePct(' 3 % ')).toBe(3)
    expect(parseCameraKeyEdgePct('1,6')).toBe(2)
    expect(parseCameraKeyEdgePct('90')).toBe(25)
    expect(parseCameraKeyEdgePct('-4')).toBe(0)
    expect(parseCameraKeyEdgePct('')).toBeNull()
    expect(parseCameraKeyEdgePct('left')).toBeNull()
  })

  it('patches one side and ignores a no-op', () => {
    expect(cameraKeyEdgesPatch(NONE, 'leftPct', '2')).toEqual({ ...NONE, leftPct: 2 })
    expect(cameraKeyEdgesPatch({ ...NONE, leftPct: 2 }, 'leftPct', '2')).toBeNull()
    expect(cameraKeyEdgesPatch(NONE, 'bottomPct', 'x')).toBeNull()
  })

  it('reads a layout without edges as none', () => {
    expect(cameraKeyEdgesOf({})).toEqual(NONE)
    expect(cameraKeyEdgesSet(NONE)).toBe(false)
    expect(cameraKeyEdgesSet({ ...NONE, topPct: 1 })).toBe(true)
  })

  it('normalizes a stored layout: clamps each side and drops all-zero edges', () => {
    expect(normalizeCameraKeyEdges({ leftPct: 4.4, rightPct: 80, topPct: 'x' })).toEqual({
      leftPct: 4,
      topPct: 0,
      rightPct: 25,
      bottomPct: 0
    })
    expect(normalizeCameraKeyEdges(NONE)).toBeUndefined()
    expect(normalizeCameraKeyEdges(undefined)).toBeUndefined()
    expect(normalizeLayoutSettings({}).cameraChromaKeyEdges).toBeUndefined()
    expect(
      normalizeLayoutSettings({ cameraChromaKeyEdges: { ...NONE, bottomPct: 5 } })
        .cameraChromaKeyEdges
    ).toEqual({ ...NONE, bottomPct: 5 })
    expect('cameraChromaKeyEdges' in normalizeLayoutSettings({ cameraChromaKeyEdges: NONE })).toBe(
      false
    )
  })
})
