import { describe, expect, it } from 'vitest'

import type {
  PerformanceCheckResult,
  PerformanceCheckRungVerdict,
  VideoPreset
} from '../../../shared/backend'
import { videoPresets } from './capture'
import {
  autoApplyPreset,
  isShippedDefaultOutput,
  outputLabel,
  outputVerdict,
  performanceCheckLine,
  performanceCheckCeiling,
  shouldRunPerformanceCheck
} from './performance-check'

function result(
  rungs: Array<[VideoPreset, PerformanceCheckRungVerdict]>,
  recommended: VideoPreset,
  belowFloor = false
): PerformanceCheckResult {
  return {
    capabilityKey: 'performance-check-v1:test',
    checkedAt: '2026-09-20T00:00:00Z',
    appVersion: '0.9.96',
    durationMs: 6000,
    recommended: videoPresets[recommended],
    belowFloor,
    rungs: rungs.map(([preset, verdict]) => ({
      video: videoPresets[preset],
      verdict,
      reasons: verdict === 'failed' ? ['encoder-below-realtime'] : []
    }))
  }
}

// The UHD 600 tester: 1440p30 selected on a 1080p display, only 720p holds.
const weak = result(
  [
    ['tutorial-1440p30', 'failed'],
    ['tutorial-1080p30', 'failed'],
    ['tutorial-720p30', 'passed']
  ],
  'tutorial-720p30'
)
const strong = result([['record-4k30', 'passed']], 'record-4k30')

describe('performanceCheckCeiling', () => {
  it('tests the selection when it is larger than the display', () => {
    expect(
      performanceCheckCeiling(videoPresets['tutorial-1440p30'], { width: 1920, height: 1080 })
    ).toEqual({ ceilingWidth: 2560, ceilingHeight: 1440, ceilingFps: 30 })
  })

  it('tests up to the display, capped at 4K, and keeps a 60 fps selection', () => {
    expect(
      performanceCheckCeiling(videoPresets['stream-safe-1080p60'], { width: 5120, height: 2880 })
    ).toEqual({ ceilingWidth: 3840, ceilingHeight: 2160, ceilingFps: 60 })
    expect(performanceCheckCeiling(videoPresets['tutorial-1080p30'])).toEqual({
      ceilingWidth: 1920,
      ceilingHeight: 1080,
      ceilingFps: 30
    })
  })
})

describe('outputVerdict', () => {
  it('marks everything at or above a failed rung too heavy, the passed rung verified', () => {
    expect(outputVerdict(videoPresets['record-4k30'], weak)).toBe('too-heavy')
    expect(outputVerdict(videoPresets['tutorial-1440p30'], weak)).toBe('too-heavy')
    expect(outputVerdict(videoPresets['tutorial-1080p30'], weak)).toBe('too-heavy')
    expect(outputVerdict(videoPresets['vertical-1080x1920'], weak)).toBe('too-heavy')
    expect(outputVerdict(videoPresets['tutorial-720p30'], weak)).toBe('verified')
  })

  it('implies lower rungs from a pass but never 60 fps from a 30 fps pass', () => {
    expect(outputVerdict(videoPresets['tutorial-1440p30'], strong)).toBe('verified')
    expect(outputVerdict(videoPresets['vertical-1080x1920'], strong)).toBe('verified')
    expect(outputVerdict(videoPresets['stream-safe-1080p60'], strong)).toBe('unknown')
    expect(outputVerdict(videoPresets['record-4k60-experimental'], strong)).toBe('unknown')
    expect(outputVerdict(videoPresets['tutorial-1080p30'], undefined)).toBe('unknown')
  })
})

describe('autoApplyPreset', () => {
  it('lowers a weak machine and never raises a strong one above the old default', () => {
    expect(autoApplyPreset(weak)).toBe('tutorial-720p30')
    expect(autoApplyPreset(strong)).toBe('tutorial-1440p30')
    expect(autoApplyPreset(result([['tutorial-1080p30', 'passed']], 'tutorial-1080p30'))).toBe(
      'tutorial-1080p30'
    )
  })

  it('falls to the unverified floor when nothing passed', () => {
    const nothing = result([['tutorial-720p30', 'failed']], 'tutorial-720p30', true)
    expect(autoApplyPreset(nothing)).toBe('tutorial-720p30')
  })
})

describe('isShippedDefaultOutput', () => {
  it('treats only the two shipped defaults as never chosen', () => {
    expect(isShippedDefaultOutput(videoPresets['tutorial-1440p30'])).toBe(true)
    expect(isShippedDefaultOutput(videoPresets['tutorial-1080p30'])).toBe(true)
    expect(isShippedDefaultOutput(videoPresets['record-4k30'])).toBe(false)
    expect(isShippedDefaultOutput(videoPresets['stream-youtube-1080p30'])).toBe(false)
    expect(isShippedDefaultOutput({ ...videoPresets['tutorial-1080p30'], fps: 60 })).toBe(false)
  })
})

describe('shouldRunPerformanceCheck', () => {
  it('runs for an unmeasured or stale machine only', () => {
    expect(shouldRunPerformanceCheck(undefined)).toBe(false)
    expect(shouldRunPerformanceCheck({ running: false, stale: false })).toBe(true)
    expect(shouldRunPerformanceCheck({ running: true, stale: false })).toBe(false)
    expect(shouldRunPerformanceCheck({ running: false, stale: true, result: strong })).toBe(true)
    expect(shouldRunPerformanceCheck({ running: false, stale: false, result: strong })).toBe(false)
  })
})

describe('outputLabel', () => {
  it('names outputs the way the picker does', () => {
    expect(outputLabel(videoPresets['record-4k30'])).toBe('4K 30')
    expect(outputLabel(videoPresets['tutorial-720p30'])).toBe('720p 30')
    expect(outputLabel(videoPresets['vertical-1080x1920'])).toBe('1080p 30')
  })
})

describe('performanceCheckLine', () => {
  const line = (
    state: Parameters<typeof performanceCheckLine>[0]['state'],
    preset: VideoPreset,
    progress: Parameters<typeof performanceCheckLine>[0]['progress'] = null
  ) => performanceCheckLine({ state, progress, video: videoPresets[preset] })

  it('stays silent until the backend answered and narrates a running check', () => {
    expect(line(undefined, 'tutorial-1080p30')).toBeNull()
    expect(
      line({ running: true, stale: false }, 'tutorial-1080p30', {
        rungIndex: 0,
        rungCount: 3,
        video: videoPresets['tutorial-1440p30']
      })
    ).toMatchObject({ busy: true, text: 'Checking what this computer can record… 1440p 30' })
    expect(line({ running: false, stale: false }, 'tutorial-1080p30')).toMatchObject({
      checkLabel: 'Check this computer'
    })
  })

  it('warns and offers the measured output when the selection is too heavy', () => {
    expect(line({ running: false, stale: false, result: weak }, 'tutorial-1440p30')).toEqual({
      tone: 'warning',
      busy: false,
      text: '1440p 30 is too heavy for this computer. Recordings will stutter. 720p 30 held steady.',
      checkLabel: 'Check again',
      applyPreset: 'tutorial-720p30',
      applyLabel: 'Use 720p 30'
    })
  })

  it('confirms a verified selection without offering anything', () => {
    const verified = line({ running: false, stale: false, result: strong }, 'tutorial-1440p30')
    expect(verified).toMatchObject({
      tone: 'muted',
      text: '1440p 30 is verified for this computer.'
    })
    expect(verified?.applyPreset).toBeUndefined()
  })

  it('says so when an output was never measured, and when nothing held', () => {
    expect(
      line({ running: false, stale: false, result: strong }, 'stream-safe-1080p60')
    ).toMatchObject({
      tone: 'muted',
      text: '1080p 60 has not been measured. 4K 30 held steady.',
      applyPreset: 'record-4k30'
    })
    const nothing = result([['tutorial-720p30', 'failed']], 'tutorial-720p30', true)
    expect(
      line({ running: false, stale: false, result: nothing }, 'tutorial-720p30')
    ).toMatchObject({ tone: 'warning', checkLabel: 'Check again' })
  })
})
