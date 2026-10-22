import { describe, expect, it } from 'vitest'

import { cameraFacts, screenFacts } from '@/lib/source-facts'

// Plan 173: the facts line under a live video source's picker.

describe('screenFacts', () => {
  it('gives the native size of a live screen, with no frame rate', () => {
    expect(
      screenFacts({
        state: 'live',
        nativeWidth: 2560,
        nativeHeight: 1664,
        width: 1920,
        height: 1248
      })
    ).toBe('2560 × 1664')
  })

  it('falls back to the delivered size when the native one is unknown', () => {
    expect(screenFacts({ state: 'live', width: 1920, height: 1080 })).toBe('1920 × 1080')
  })

  it('says nothing unless live and measured', () => {
    expect(screenFacts(null)).toBeNull()
    expect(screenFacts({ state: 'starting', nativeWidth: 2560, nativeHeight: 1664 })).toBeNull()
    expect(screenFacts({ state: 'live', nativeWidth: 0, nativeHeight: 1664 })).toBeNull()
  })
})

describe('cameraFacts', () => {
  const live = {
    state: 'live' as const,
    targetFps: 30,
    selectedFormatWidth: 1920,
    selectedFormatHeight: 1080,
    selectedFormatMaxFps: 60
  }

  it('gives the selected format at the requested rate', () => {
    expect(cameraFacts(live)).toBe('1920 × 1080 · 30 fps')
  })

  it("caps the rate at what the format can do, rounding the camera's 29.97", () => {
    expect(cameraFacts({ ...live, selectedFormatMaxFps: 25 })).toBe('1920 × 1080 · 25 fps')
    expect(cameraFacts({ ...live, targetFps: 60, selectedFormatMaxFps: 29.97 })).toBe(
      '1920 × 1080 · 30 fps'
    )
  })

  it('falls back to the delivered size, and to no rate when none is known', () => {
    expect(
      cameraFacts({
        state: 'live',
        targetFps: 0,
        actualWidth: 1280,
        actualHeight: 720
      })
    ).toBe('1280 × 720')
  })

  it('says nothing unless live and measured', () => {
    expect(cameraFacts(null)).toBeNull()
    expect(cameraFacts({ ...live, state: 'starting' })).toBeNull()
    expect(cameraFacts({ state: 'live', targetFps: 30 })).toBeNull()
  })
})
