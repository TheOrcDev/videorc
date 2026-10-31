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
  firstRunSetupStartsPerformanceCheck,
  performanceCheckTooHeavyToast,
  shouldRunPerformanceCheck
} from './performance-check'
import {
  GO_LIVE_CPU_COMPOSITOR_HEADROOM,
  cpuCompositorStreamAdvice,
  softwareStreamAdvice,
  streamPerformanceAdvice,
  streamQualityUntouched,
  streamingAtSteppedDownProfile
} from './go-live-output'
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

  it('tells the check when the next take also writes the separate files', () => {
    // Plan 200 D4: only when on, so an ordinary check sends what it always sent.
    expect(
      performanceCheckCeiling(videoPresets['record-4k30'], { width: 1920, height: 1080 }, true)
    ).toEqual({
      ceilingWidth: 3840,
      ceilingHeight: 2160,
      ceilingFps: 30,
      separateSourceRecordings: true
    })
    expect(
      performanceCheckCeiling(videoPresets['tutorial-1080p30'], { width: 5120, height: 2880 }, true)
    ).toEqual({
      ceilingWidth: 3840,
      ceilingHeight: 2160,
      ceilingFps: 30,
      separateSourceRecordings: true
    })
    expect(performanceCheckCeiling(videoPresets['tutorial-1080p30'], undefined, false)).toEqual({
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
      text: "This computer hasn't been measured yet."
    })
    const trustedV2 = { ...poison, capabilityKey: 'performance-check-v2:abc' }
    expect(isUntrustedPerformanceCheckResult(trustedV2)).toBe(false)
    expect(autoApplyPreset(trustedV2)).toBe('tutorial-720p30')
  })
})

describe('outputLabel', () => {
  it('names outputs in the one video spelling (plan 174 S1.4)', () => {
    expect(outputLabel(videoPresets['record-4k30'])).toBe('4K · 30 fps')
    expect(outputLabel(videoPresets['tutorial-720p30'])).toBe('720p · 30 fps')
    // A portrait canvas keeps both sides (plan 174 S1.4).
    expect(outputLabel(videoPresets['vertical-1080x1920'])).toBe('1080 × 1920 · 30 fps')
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
    ).toMatchObject({ busy: true, text: 'Checking what this computer can record… 1440p · 30 fps' })
    expect(line({ running: false, stale: false }, 'tutorial-1080p30')).toMatchObject({
      checkLabel: 'Check this computer'
    })
  })

  it('warns and offers the measured output when the selection is too heavy', () => {
    expect(line({ running: false, stale: false, result: weak }, 'tutorial-1440p30')).toEqual({
      tone: 'warning',
      busy: false,
      text: '1440p · 30 fps is too heavy for this computer. Recordings will stutter. 720p · 30 fps held steady.',
      checkLabel: 'Check again',
      applyPreset: 'tutorial-720p30',
      applyLabel: 'Use 720p · 30 fps'
    })
  })

  it('confirms a verified selection without offering anything', () => {
    const verified = line({ running: false, stale: false, result: strong }, 'tutorial-1440p30')
    expect(verified).toMatchObject({
      tone: 'muted',
      text: '1440p · 30 fps is verified for this computer.'
    })
    expect(verified?.applyPreset).toBeUndefined()
  })

  it('says so when an output was never measured, and when nothing held', () => {
    expect(
      line({ running: false, stale: false, result: strong }, 'stream-safe-1080p60')
    ).toMatchObject({
      tone: 'muted',
      text: "1080p · 60 fps hasn't been measured. 4K · 30 fps held steady.",
      applyPreset: 'record-4k30'
    })
    const nothing = result([['tutorial-720p30', 'failed']], 'tutorial-720p30', true)
    expect(
      line({ running: false, stale: false, result: nothing }, 'tutorial-720p30')
    ).toMatchObject({
      tone: 'warning',
      checkLabel: 'Check again',
      text: 'Nothing held steady on this computer, not even 720p · 30 fps. Close other apps and check again.'
    })
  })
})

describe('performanceCheckTooHeavyToast', () => {
  it('warns once when a chosen output is heavier than what held', () => {
    expect(performanceCheckTooHeavyToast(videoPresets['record-4k30'], weak)).toEqual({
      title: '4K · 30 fps is too heavy for this computer',
      description: 'Recordings will stutter. 720p · 30 fps held steady.',
      actionLabel: 'Use 720p · 30 fps',
      preset: 'tutorial-720p30'
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
      reason: 'encoder',
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
    expect(outputLabel(videoPresets['tutorial-540p30'])).toBe('540p · 30 fps')
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
      reason: 'encoder',
      requested: videoPresets['stream-safe-1080p30'],
      video: videoPresets['tutorial-540p30']
    })
  })
})

describe('Go Live headroom on a CPU compositor (retest 153)', () => {
  // ogre: i7-8750H, CPU compositor, VAAPI. A 1080p30 Record holds 30 fps, a
  // 1080p30 Go Live runs at ~14: the check passes 1080p, Go Live can't.
  const cpu = (
    rungs: Array<[VideoPreset, PerformanceCheckRungVerdict]>,
    recommended: VideoPreset,
    compositorBackend: 'cpu' | 'metal' = 'cpu'
  ): PerformanceCheckResult => {
    const checked = result(rungs, recommended)
    return {
      ...checked,
      rungs: checked.rungs.map((rung) => ({
        ...rung,
        compositorBackend,
        encodeBackend: 'hardware-vaapi' as const
      }))
    }
  }
  const fresh = (checked: PerformanceCheckResult) => ({
    running: false,
    stale: false,
    result: checked
  })
  const ogre = cpu(
    [
      ['tutorial-1080p30', 'passed'],
      ['tutorial-720p30', 'passed']
    ],
    'tutorial-1080p30'
  )
  const untouched = defaultCaptureConfig.streaming
  const picked = { ...untouched, defaultOutputPreset: 'stream-safe-1080p30' as const }
  const stream1080 = videoPresets['stream-safe-1080p30']
  const default720 = videoPresets['tutorial-720p30']

  it('knows an untouched stream quality from a picked one', () => {
    expect(streamQualityUntouched(untouched)).toBe(true)
    expect(streamQualityUntouched(picked)).toBe(false)
    const [first, ...rest] = untouched.targets
    expect(
      streamQualityUntouched({
        ...untouched,
        targets: [{ ...first, enabled: true, outputPreset: 'stream-safe-1080p30' }, ...rest]
      })
    ).toBe(false)
    // A disabled destination's own quality doesn't count.
    expect(
      streamQualityUntouched({
        ...untouched,
        targets: [{ ...first, enabled: false, outputPreset: 'stream-safe-1080p30' }, ...rest]
      })
    ).toBe(true)
  })

  it('steps an untouched 1080p stream down to 720p30 when 1080p held only for a Record', () => {
    expect(
      cpuCompositorStreamAdvice({
        streamVideo: stream1080,
        streaming: untouched,
        state: fresh(ogre)
      })
    ).toEqual({
      kind: 'step-down',
      reason: 'go-live-headroom',
      requested: stream1080,
      video: default720
    })
  })

  it('does the same when 1080p failed or was never measured', () => {
    const failed = cpu(
      [
        ['tutorial-1440p30', 'failed'],
        ['tutorial-1080p30', 'failed'],
        ['tutorial-720p30', 'passed']
      ],
      'tutorial-720p30'
    )
    const only720 = cpu([['tutorial-720p30', 'passed']], 'tutorial-720p30')
    for (const checked of [failed, only720]) {
      expect(
        cpuCompositorStreamAdvice({
          streamVideo: stream1080,
          streaming: untouched,
          state: fresh(checked)
        })
      ).toMatchObject({ kind: 'step-down', video: default720 })
    }
  })

  it('goes to the smaller output that held when 720p did not', () => {
    const floor = cpu(
      [
        ['tutorial-720p30', 'failed'],
        ['tutorial-540p30', 'passed']
      ],
      'tutorial-540p30'
    )
    expect(
      cpuCompositorStreamAdvice({
        streamVideo: stream1080,
        streaming: untouched,
        state: fresh(floor)
      })
    ).toMatchObject({ kind: 'step-down', video: videoPresets['tutorial-540p30'] })
  })

  it('steps down to the floor when not even the floor held', () => {
    // ogre under load: every rung failed, 540p came closest (27.5 fps).
    const belowFloor = {
      ...cpu(
        [
          ['tutorial-1080p30', 'failed'],
          ['tutorial-720p30', 'failed'],
          ['tutorial-540p30', 'failed']
        ],
        'tutorial-540p30'
      ),
      belowFloor: true
    }
    expect(
      cpuCompositorStreamAdvice({
        streamVideo: stream1080,
        streaming: untouched,
        state: fresh(belowFloor)
      })
    ).toMatchObject({
      kind: 'step-down',
      reason: 'go-live-headroom',
      video: videoPresets['tutorial-540p30']
    })
    expect(
      cpuCompositorStreamAdvice({
        streamVideo: stream1080,
        streaming: picked,
        state: fresh(belowFloor)
      })
    ).toMatchObject({ kind: 'go-live-heavy', video: videoPresets['tutorial-540p30'] })
  })

  it('only warns about a stream quality the user picked', () => {
    expect(
      cpuCompositorStreamAdvice({ streamVideo: stream1080, streaming: picked, state: fresh(ogre) })
    ).toEqual({ kind: 'go-live-heavy', requested: stream1080, video: default720 })
  })

  it('leaves the stream alone with measured headroom, a GPU compositor or no trusted check', () => {
    expect(GO_LIVE_CPU_COMPOSITOR_HEADROOM).toBe(1.5)
    const headroom = cpu([['tutorial-1440p30', 'passed']], 'tutorial-1440p30')
    const metal = cpu([['tutorial-1080p30', 'passed']], 'tutorial-1080p30', 'metal')
    for (const state of [
      fresh(headroom),
      fresh(metal),
      { running: false, stale: true, result: ogre },
      undefined
    ]) {
      expect(
        cpuCompositorStreamAdvice({ streamVideo: stream1080, streaming: untouched, state })
      ).toBeNull()
    }
    // 720p is the default a CPU compositor lands on, so it is never moved.
    expect(
      cpuCompositorStreamAdvice({
        streamVideo: default720,
        streaming: untouched,
        state: fresh(ogre)
      })
    ).toBeNull()
    // Portrait streams have their own ladder.
    expect(
      cpuCompositorStreamAdvice({
        streamVideo: videoPresets['vertical-1080x1920'],
        streaming: untouched,
        state: fresh(ogre)
      })
    ).toBeNull()
  })

  it('lets a software encoder step-down speak first', () => {
    const weakCpu = cpu(
      [
        ['tutorial-1080p30', 'failed'],
        ['tutorial-720p30', 'passed']
      ],
      'tutorial-720p30'
    )
    expect(
      streamPerformanceAdvice({
        streamVideo: stream1080,
        encodeBackend: 'software-open-h264',
        streaming: picked,
        state: fresh(weakCpu)
      })
    ).toMatchObject({ kind: 'step-down', reason: 'encoder' })
    expect(
      streamPerformanceAdvice({
        streamVideo: stream1080,
        encodeBackend: 'hardware-vaapi',
        streaming: untouched,
        state: fresh(ogre)
      })
    ).toMatchObject({ kind: 'step-down', reason: 'go-live-headroom' })
  })
})

describe('firstRunSetupStartsPerformanceCheck (plan 212 D1)', () => {
  const firstRun = { kind: 'first-run' }
  const replay = { kind: 'replay' }
  const nothingMeasured = { running: false, stale: false }
  const measured = {
    running: false,
    stale: false,
    result: result([['tutorial-1080p30', 'passed']], 'tutorial-1080p30')
  }

  it('starts one when this machine has no verdict', () => {
    expect(firstRunSetupStartsPerformanceCheck(firstRun, nothingMeasured, false)).toBe(true)
  })

  it('starts nothing when a verdict from this machine exists', () => {
    expect(firstRunSetupStartsPerformanceCheck(firstRun, measured, false)).toBe(false)
  })

  it('re-measures a verdict from another machine, or one that never measured', () => {
    expect(firstRunSetupStartsPerformanceCheck(firstRun, { ...measured, stale: true }, false)).toBe(
      true
    )
    const poison = {
      ...result([['tutorial-540p30', 'failed']], 'tutorial-540p30', true),
      rungs: [
        { video: videoPresets['tutorial-540p30'], verdict: 'failed', reasons: ['did-not-start'] }
      ]
    } satisfies PerformanceCheckResult
    expect(
      firstRunSetupStartsPerformanceCheck(
        firstRun,
        { running: false, stale: false, result: poison },
        false
      )
    ).toBe(true)
  })

  it('waits for the backend to answer, and never doubles a running check', () => {
    expect(firstRunSetupStartsPerformanceCheck(firstRun, undefined, false)).toBe(false)
    expect(
      firstRunSetupStartsPerformanceCheck(firstRun, { running: true, stale: false }, false)
    ).toBe(false)
  })

  it('never takes the studio from a running take', () => {
    expect(firstRunSetupStartsPerformanceCheck(firstRun, nothingMeasured, true)).toBe(false)
  })

  it('a replay of setup from Settings is not a first run', () => {
    expect(firstRunSetupStartsPerformanceCheck(replay, nothingMeasured, false)).toBe(false)
  })
})
