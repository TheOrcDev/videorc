import { describe, expect, it } from 'vitest'

import {
  freeformSwitching,
  layoutSwitchTarget,
  pendingLayoutEvidence,
  presetSwitching
} from './layout-switch-pending'

// Plan 216 A4: one "Switching…" label. The streamer's Freeform click lit both
// the "Screen + camera" button and the Freeform toggle.

describe('which control says "Switching…"', () => {
  it('entering Freeform from a preset lights Freeform only', () => {
    const pending = layoutSwitchTarget({
      layoutPreset: 'screen-camera',
      arrangementMode: 'freeform'
    })
    expect(freeformSwitching(pending)).toBe(true)
    expect(presetSwitching(pending, 'screen-camera')).toBe(false)
    expect(presetSwitching(pending, 'camera-only')).toBe(false)
    expect(pendingLayoutEvidence(pending)).toBe('freeform')
  })

  it('a preset from Freeform lights that preset only', () => {
    const pending = layoutSwitchTarget({ layoutPreset: 'camera-only', arrangementMode: 'preset' })
    expect(presetSwitching(pending, 'camera-only')).toBe(true)
    expect(presetSwitching(pending, 'screen-camera')).toBe(false)
    expect(freeformSwitching(pending)).toBe(false)
    expect(pendingLayoutEvidence(pending)).toBe('camera-only')
  })

  it('a preset from a preset lights the target preset only', () => {
    const pending = layoutSwitchTarget({ layoutPreset: 'screen-only', arrangementMode: 'preset' })
    expect(presetSwitching(pending, 'screen-only')).toBe(true)
    expect(presetSwitching(pending, 'screen-camera')).toBe(false)
    expect(freeformSwitching(pending)).toBe(false)
  })

  it('nothing pending lights nothing', () => {
    expect(presetSwitching(null, 'screen-only')).toBe(false)
    expect(freeformSwitching(null)).toBe(false)
    expect(pendingLayoutEvidence(null)).toBeNull()
  })
})
