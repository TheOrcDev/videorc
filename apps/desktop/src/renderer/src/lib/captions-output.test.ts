import { describe, expect, it } from 'vitest'

import { DEFAULT_OVERLAY_LAYOUT } from './overlay-layout'
import {
  burnTargetFromOverlaySwitches,
  overlaySwitchesFromBurnTarget,
  seedCaptionsSwitchesFromBurnTarget
} from './captions-output'

describe('captions burnTarget derives from the overlay switches (plan 164, D14)', () => {
  it('maps all four switch combinations and back', () => {
    const table = [
      [false, false, 'off'],
      [true, false, 'stream'],
      [false, true, 'recording'],
      [true, true, 'both']
    ] as const
    for (const [showOnStream, showInRecording, burnTarget] of table) {
      expect(burnTargetFromOverlaySwitches({ showOnStream, showInRecording })).toBe(burnTarget)
      expect(overlaySwitchesFromBurnTarget(burnTarget)).toStrictEqual({
        showOnStream,
        showInRecording
      })
    }
  })

  it('seeds a fresh layout from a saved target once and never overrides a placed one', () => {
    const fresh = DEFAULT_OVERLAY_LAYOUT.captions
    expect(seedCaptionsSwitchesFromBurnTarget(fresh, 'off')).toBeNull()
    expect(seedCaptionsSwitchesFromBurnTarget(fresh, 'stream')).toStrictEqual({
      ...fresh,
      showOnStream: true,
      showInRecording: false
    })
    expect(seedCaptionsSwitchesFromBurnTarget(fresh, 'both')).toMatchObject({
      showOnStream: true,
      showInRecording: true
    })
    const placed = { ...fresh, showInRecording: true }
    expect(seedCaptionsSwitchesFromBurnTarget(placed, 'stream')).toBeNull()
  })
})
