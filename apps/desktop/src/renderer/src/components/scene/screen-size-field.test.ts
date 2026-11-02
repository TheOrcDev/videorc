import { describe, expect, it } from 'vitest'

import { previewProofBackgroundStageMargin } from '../../../../shared/native-preview-proof-geometry'
import {
  SCREEN_SIZE_MAX,
  SCREEN_SIZE_MIN,
  screenSizeOf,
  visibilityForScreenSize
} from './screen-size-field'

describe('Screen size is the background Visibility (plan 213 G4)', () => {
  it('reads as the stage the screen really gets, the same stage Rust draws', () => {
    // The stage mirror pins Rust's background_stage_margin: a margin on
    // each side, so the screen's share is one less both margins.
    for (const visibilityPercent of [0, 5, 20, 33, 40]) {
      const margin = previewProofBackgroundStageMargin({ visibilityPercent })
      expect(screenSizeOf(visibilityPercent) / 100).toBeCloseTo(1 - margin * 2)
    }
    expect(screenSizeOf(20)).toBe(80)
  })

  it('writes back the one Visibility it shows, inside Assets’ 0–40 range', () => {
    for (const screenSize of [SCREEN_SIZE_MIN, 72, 80, SCREEN_SIZE_MAX])
      expect(screenSizeOf(visibilityForScreenSize(screenSize))).toBe(screenSize)
    expect(visibilityForScreenSize(100)).toBe(0)
    expect(visibilityForScreenSize(10)).toBe(40)
    expect(visibilityForScreenSize(120)).toBe(0)
  })
})
