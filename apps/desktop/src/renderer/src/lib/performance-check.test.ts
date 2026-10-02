import { describe, expect, it } from 'vitest'

import type {
  PerformanceCheckResult,
  PerformanceCheckRungVerdict,
  VideoPreset
} from '../../../shared/backend'
import { defaultCaptureConfig, videoPresets } from './capture'
import {
  autoApplyPreset,
  isShippedDefaultOutput,
  isUntrustedPerformanceCheckResult,
  outputLabel,
  outputVerdict,
  performanceCheckCeiling,
  performanceCheckTooHeavyToast,
  shouldRunPerformanceCheck
} from './performance-check'
import { softwareStreamAdvice, streamingAtSteppedDownProfile } from './go-live-output'
import { performanceCheckLine } from './performance-check-line'

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

  it('reruns Linux v1 did-not-start below-floor poison without applying it', () => {
    const poison = result([['tutorial-720p30', 'failed']], 'tutorial-720p30', true)
    poison.rungs[0].reasons = ['did-not-start']
    expect(isUntrustedPerformanceCheckResult(poison)).toBe(true)
    expect(autoApplyPreset(poison)).toBeUndefined()
    expect(outputVerdict(videoPresets['tutorial-720p30'], poison)).toBe('unknown')
    expect(shouldRunPerformanceCheck({ running: false, stale: false, result: poison })).toBe(true)
    expect(
      performanceCheckLine({
        state: { running: false, stale: false, result: poison },
        progress: null,
        video: videoPresets['tutorial-720p30']
      })
    ).toMatchObject({
      checkLabel: 'Check this computer',
      text: 'This computer has not been measured yet.'
    })
    const trustedV2 = { ...poison, capabilityKey: 'performance-check-v2:abc' }
    expect(isUntrustedPerformanceCheckResult(trustedV2)).toBe(false)
    expect(autoApplyPreset(trustedV2)).toBe('tutorial-720p30')
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
    ).toMatchObject({
      tone: 'warning',
      checkLabel: 'Check again',
      text: 'Nothing held steady on this computer, not even 720p 30. Close other apps and check again.'
    })
  })
})

describe('performanceCheckTooHeavyToast', () => {
  it('warns once when a chosen output is heavier than what held', () => {
    expect(performanceCheckTooHeavyToast(videoPresets['record-4k30'], weak)).toEqual({
      title: '4K 30 is too heavy for this computer',
      description: 'Recordings will stutter. 720p 30 held steady. Switch in Recording → Output.'
    })
  })

  it('does not claim the floor held when nothing passed', () => {
    const nothing = result([['tutorial-720p30', 'failed']], 'tutorial-720p30', true)
    expect(performanceCheckTooHeavyToast(videoPresets['tutorial-720p30'], nothing)).toBeUndefined()
    expect(performanceCheckTooHeavyToast(videoPresets['record-4k30'], nothing)).toBeUndefined()
  })

  it('stays quiet for a shipped default and for a verified selection', () => {
    expect(performanceCheckTooHeavyToast(videoPresets['tutorial-1080p30'], weak)).toBeUndefined()
    expect(performanceCheckTooHeavyToast(videoPresets['tutorial-720p30'], weak)).toBeUndefined()
  })
})

describe('softwareStreamAdvice (plan 090)', () => {
  const stream1080 = videoPresets['stream-safe-1080p30']
  const fresh = (checked: PerformanceCheckResult) => ({
    running: false,
    stale: false,
    result: checked
  })

  it('steps a software-encoded stream down to the output that held steady', () => {
    expect(
      softwareStreamAdvice({
        streamVideo: stream1080,
        encodeBackend: 'software-open-h264',
        state: fresh(weak)
      })
    ).toEqual({
      kind: 'step-down',
      requested: stream1080,
      video: videoPresets['tutorial-720p30']
    })
  })

  it('never advises a hardware-encoded stream, Quick Sync included', () => {
    for (const encodeBackend of [
      'hardware-media-foundation',
      'hardware-videotoolbox',
      'hardware-vaapi',
      'hardware-qsv'
    ] as const) {
      expect(
        softwareStreamAdvice({ streamVideo: stream1080, encodeBackend, state: fresh(weak) })
      ).toBeNull()
    }
  })

  it('warns instead of stepping down when nothing held steady', () => {
    const belowFloor = result(
      [
        ['tutorial-1080p30', 'failed'],
        ['tutorial-720p30', 'failed']
      ],
      'tutorial-720p30',
      true
    )
    expect(
      softwareStreamAdvice({
        streamVideo: stream1080,
        encodeBackend: 'software-open-h264',
        state: fresh(belowFloor)
      })
    ).toEqual({ kind: 'below-floor', floor: videoPresets['tutorial-720p30'] })
  })

  it('leaves a stream alone when it is verified, unmeasured, stale or portrait', () => {
    const software = 'software-open-h264' as const
    expect(
      softwareStreamAdvice({
        streamVideo: videoPresets['tutorial-720p30'],
        encodeBackend: software,
        state: fresh(weak)
      })
    ).toBeNull()
    expect(
      softwareStreamAdvice({
        streamVideo: stream1080,
        encodeBackend: software,
        state: fresh(strong)
      })
    ).toBeNull()
    expect(
      softwareStreamAdvice({ streamVideo: stream1080, encodeBackend: software, state: undefined })
    ).toBeNull()
    expect(
      softwareStreamAdvice({
        streamVideo: stream1080,
        encodeBackend: software,
        state: { running: false, stale: true, result: weak }
      })
    ).toBeNull()
    expect(
      softwareStreamAdvice({
        streamVideo: videoPresets['vertical-1080x1920'],
        encodeBackend: software,
        state: fresh(weak)
      })
    ).toBeNull()
    expect(
      softwareStreamAdvice({
        streamVideo: stream1080,
        encodeBackend: undefined,
        state: fresh(weak)
      })
    ).toBeNull()
  })

  it('moves every enabled landscape destination and nothing else', () => {
    const base = defaultCaptureConfig.streaming
    const [first, second, third] = base.targets
    const streaming = {
      ...base,
      enabled: true,
      targets: [
        { ...first, enabled: true, outputPreset: 'stream-youtube-1080p30' as const },
        { ...second, enabled: true, outputOrientation: 'vertical' as const },
        { ...third, enabled: false },
        ...base.targets.slice(3)
      ]
    }
    const stepped = streamingAtSteppedDownProfile(streaming, videoPresets['tutorial-720p30'])

    expect(stepped.defaultOutputPreset).toBe('tutorial-720p30')
    expect(stepped.defaultBitrateKbps).toBe(4000)
    expect(stepped.targets[0]).toMatchObject({
      outputPreset: 'tutorial-720p30',
      outputBitrateKbps: 4000
    })
    // The vertical leg has its own encode; a disabled destination is untouched.
    expect(stepped.targets[1]).toBe(streaming.targets[1])
    expect(stepped.targets[2]).toBe(streaming.targets[2])
    // The saved settings object is not mutated.
    expect(streaming.targets[0].outputPreset).toBe('stream-youtube-1080p30')
  })
})

describe('540p30 floor (plan 090 D1)', () => {
  // The reporter's class of PC: 720p30 in software ran at 0.69x real time.
  const floorHeld = result(
    [
      ['tutorial-1080p30', 'failed'],
      ['tutorial-720p30', 'failed'],
      ['tutorial-540p30', 'passed']
    ],
    'tutorial-540p30'
  )

  it('is a named preset the renderer and backend agree on', () => {
    expect(videoPresets['tutorial-540p30']).toEqual({
      preset: 'tutorial-540p30',
      width: 960,
      height: 540,
      fps: 30,
      bitrateKbps: 2500
    })
    expect(outputLabel(videoPresets['tutorial-540p30'])).toBe('540p 30')
  })

  it('moves an untouched install to it and verifies it', () => {
    expect(autoApplyPreset(floorHeld)).toBe('tutorial-540p30')
    expect(outputVerdict(videoPresets['tutorial-540p30'], floorHeld)).toBe('verified')
    expect(outputVerdict(videoPresets['tutorial-720p30'], floorHeld)).toBe('too-heavy')
  })

  it('steps a software stream down to it', () => {
    expect(
      softwareStreamAdvice({
        streamVideo: videoPresets['stream-safe-1080p30'],
        encodeBackend: 'software-open-h264',
        state: { running: false, stale: false, result: floorHeld }
      })
    ).toEqual({
      kind: 'step-down',
      requested: videoPresets['stream-safe-1080p30'],
      video: videoPresets['tutorial-540p30']
    })
  })
})
