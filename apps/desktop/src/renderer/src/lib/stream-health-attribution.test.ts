import { describe, expect, it } from 'vitest'

import type { DiagnosticStats, StreamHealth, StreamTargetRuntime } from '@/lib/backend'
import {
  advanceStreamDropActivity,
  emptyStreamDropActivity,
  NO_RECENT_DROPS,
  RECENT_DROP_WINDOW_MS,
  recentStreamDrops,
  type RecentStreamDrops
} from '@/lib/stream-drop-activity'
import {
  classifyStreamHealthAttribution,
  liveProblemLabel,
  RECENT_UPLINK_OVERFLOW_WINDOW_MS,
  type StreamHealthAttribution
} from '@/lib/stream-health-attribution'

// Plan 174 S3.2: one wording per stage, shared by the Livestream page and
// the Studio's Stream fact; nothing a streamer cannot act on reads as jargon.
describe('liveProblemLabel', () => {
  it('names each stage in a few words, and never a raw attribution', () => {
    const labels: Record<StreamHealthAttribution, string> = {
      device: 'Capture device lost',
      audio: 'Audio dropping',
      choppy: 'Stream skipping frames',
      uplink: 'Connection too slow',
      capture: 'Capture running slow',
      render: 'Rendering slow',
      encoder: 'Encoder dropping frames',
      fallback: 'Encoder fallback',
      network: 'Delivery degraded',
      preview: 'Preview degraded',
      healthy: 'Healthy',
      unknown: 'Checking…'
    }
    for (const [attribution, label] of Object.entries(labels)) {
      expect(liveProblemLabel(attribution as StreamHealthAttribution)).toBe(label)
    }
  })
})

type ClassifierInput = {
  diagnosticStats: DiagnosticStats
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
  recentDrops?: Partial<RecentStreamDrops>
}

type ProblemAttribution = Exclude<StreamHealthAttribution, 'healthy' | 'unknown'>

function diagnosticStats(overrides: Partial<DiagnosticStats> = {}): DiagnosticStats {
  return {
    sessionId: 'session-a',
    targetFps: 60,
    captureFps: 60,
    renderFps: 60,
    encoderSpeed: 1,
    skippedFrames: 0,
    droppedFrames: 0,
    micDroppedFrames: 0,
    micCaptureCoverage: 1,
    deviceDisconnected: false,
    bottleneck: 'none',
    previewDroppedFrames: 0,
    streamOutputBitrateKbps: 6_000,
    streamMeasuredBitrateKbps: 6_000,
    streamOutputTotalBytes: 1_000_000,
    streamDuplicatedFrames: 0,
    encoderBridgeDroppedFrames: 0,
    encoderBridgeOutputQueueDroppedFrames: 0,
    encoderBridgeStreamQueueDroppedFrames: 0,
    encoderBridgeEncodedOutputErrors: 0,
    ...overrides
  } as DiagnosticStats
}

function streamHealth(overrides: Partial<StreamHealth> = {}): StreamHealth {
  return {
    sessionId: 'session-a',
    fps: 60,
    droppedFrames: 0,
    speed: 1,
    bitrateKbps: 6_000,
    totalBytes: 1_000_000,
    duplicatedFrames: 0,
    createdAt: '2026-07-29T10:00:00.000Z',
    ...overrides
  }
}

function streamDelivery(
  overrides: Partial<NonNullable<DiagnosticStats['streamDelivery']>> = {}
): NonNullable<DiagnosticStats['streamDelivery']> {
  return {
    targetFps: 60,
    deliveredFps: 60,
    dropPercent: 0,
    windowSeconds: 30,
    degraded: false,
    atFloor: false,
    uplinkOverflows: 0,
    ...overrides
  }
}

function overflowingTarget(atMs: number): StreamTargetRuntime {
  return {
    targetId: 'target-overflowing',
    platform: 'youtube',
    label: 'YouTube',
    state: 'live',
    uplinkOverflows: 2,
    uplinkOverflowAt: new Date(atMs).toISOString()
  }
}

function streamTarget(state: StreamTargetRuntime['state'], message?: string): StreamTargetRuntime {
  return {
    targetId: `target-${state}`,
    platform: 'custom',
    label: 'Custom RTMP',
    state,
    message
  }
}

function healthyInput(): ClassifierInput {
  return {
    diagnosticStats: diagnosticStats(),
    streamHealth: streamHealth(),
    streamTargets: [streamTarget('live')]
  }
}

const problemSignals: Array<{
  expected: ProblemAttribution
  diagnosticStats?: Partial<DiagnosticStats>
  streamTargets?: StreamTargetRuntime[]
  recentDrops?: Partial<RecentStreamDrops>
}> = [
  { expected: 'device', diagnosticStats: { deviceDisconnected: true } },
  { expected: 'audio', recentDrops: { audio: true } },
  {
    expected: 'choppy',
    diagnosticStats: {
      streamDelivery: streamDelivery({ degraded: true, deliveredFps: 42, dropPercent: 30 })
    }
  },
  { expected: 'uplink', streamTargets: [overflowingTarget(Date.now())] },
  { expected: 'capture', diagnosticStats: { captureFps: 30 } },
  { expected: 'render', diagnosticStats: { renderFps: 30 } },
  { expected: 'encoder', diagnosticStats: { encoderSpeed: 0.8 } },
  {
    expected: 'fallback',
    diagnosticStats: {
      encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
      encoderBridgeEffectiveVideoOutput: 'raw-yuv420p',
      encoderBridgeEncodedOutputFallbackReason: 'hardware topology rejected'
    }
  },
  { expected: 'network', streamTargets: [streamTarget('failed', 'RTMP disconnected.')] },
  { expected: 'preview', recentDrops: { preview: true } }
]

function withProblemSignals(...signals: (typeof problemSignals)[number][]): ClassifierInput {
  const input = healthyInput()
  input.diagnosticStats = diagnosticStats(
    Object.assign({}, ...signals.map((signal) => signal.diagnosticStats))
  )
  input.streamTargets = signals.flatMap((signal) => signal.streamTargets ?? [])
  input.recentDrops = Object.assign({}, ...signals.map((signal) => signal.recentDrops))
  return input
}

function classify(input: ClassifierInput): StreamHealthAttribution {
  return classifyStreamHealthAttribution(
    input.diagnosticStats,
    input.streamHealth,
    input.streamTargets,
    { ...NO_RECENT_DROPS, ...input.recentDrops }
  )
}

describe('classifyStreamHealthAttribution', () => {
  it.each(problemSignals)('classifies the $expected stage', (signal) => {
    expect(classify(withProblemSignals(signal))).toBe(signal.expected)
  })

  for (const [higherIndex, higher] of problemSignals.entries()) {
    for (const lower of problemSignals.slice(higherIndex + 1)) {
      it(`${higher.expected} takes precedence over ${lower.expected}`, () => {
        expect(classify(withProblemSignals(higher, lower))).toBe(higher.expected)
      })
    }
  }

  it('uses audio capture coverage as an audio-stage signal', () => {
    expect(
      classify(
        withOverrides({
          diagnosticStats: { micCaptureCoverage: 0.949 }
        })
      )
    ).toBe('audio')
    expect(
      classify(
        withOverrides({
          diagnosticStats: { micCaptureCoverage: 0.95 }
        })
      )
    ).toBe('healthy')
  })

  it('uses the documented FPS and encoder-speed boundaries', () => {
    expect(classify(withOverrides({ diagnosticStats: { captureFps: 54, renderFps: 54 } }))).toBe(
      'healthy'
    )
    expect(classify(withOverrides({ diagnosticStats: { captureFps: 53.99 } }))).toBe('capture')
    expect(classify(withOverrides({ diagnosticStats: { renderFps: 53.99 } }))).toBe('render')
    expect(classify(withOverrides({ diagnosticStats: { encoderSpeed: 0.98 } }))).toBe('healthy')
    expect(classify(withOverrides({ diagnosticStats: { encoderSpeed: 0.979 } }))).toBe('encoder')
  })

  it('attributes recent drops and bridge errors to the encoder, never a session total', () => {
    expect(classify(withOverrides({ recentDrops: { encoder: true } }))).toBe('encoder')
    expect(
      classify(withOverrides({ diagnosticStats: { encoderBridgeError: 'writer stopped' } }))
    ).toBe('encoder')

    // #981: these are session totals. One frame dropped while a destination
    // reconnected must not read as "Encoder dropping frames" for the rest of
    // the stream; only the window (below) says whether drops are current.
    const sessionTotals: Partial<DiagnosticStats>[] = [
      { droppedFrames: 1 },
      { encoderBridgeDroppedFrames: 1 },
      { encoderBridgeOutputQueueDroppedFrames: 1 },
      { encoderBridgeStreamQueueDroppedFrames: 1 },
      { encoderBridgeEncodedOutputErrors: 1 },
      { streamDuplicatedFrames: 1 },
      { micDroppedFrames: 1 },
      { previewDroppedFrames: 1 }
    ]
    for (const total of sessionTotals) {
      expect(classify(withOverrides({ diagnosticStats: total }))).toBe('healthy')
    }
    expect(classify(withOverrides({ streamHealth: { droppedFrames: 1 } }))).toBe('healthy')
    expect(classify(withOverrides({ streamHealth: { duplicatedFrames: 1 } }))).toBe('healthy')
  })

  it('requires a requested/effective mismatch and a reason before naming fallback', () => {
    const fallback = {
      encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
      encoderBridgeEffectiveVideoOutput: 'raw-yuv420p',
      encoderBridgeEncodedOutputFallbackReason: 'hardware topology rejected'
    }
    expect(classify(withOverrides({ diagnosticStats: fallback }))).toBe('fallback')
    expect(
      classify(
        withOverrides({
          diagnosticStats: {
            ...fallback,
            encoderBridgeEncodedOutputFallbackReason: undefined
          }
        })
      )
    ).toBe('healthy')
    expect(
      classify(
        withOverrides({
          diagnosticStats: {
            ...fallback,
            encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts'
          }
        })
      )
    ).toBe('healthy')
  })

  it('recognizes failed, warning, and explicit reconnect target states as network trouble', () => {
    for (const target of [
      streamTarget('failed'),
      streamTarget('warning'),
      streamTarget('connecting', 'Reconnecting to ingest…')
    ]) {
      expect(classify(withOverrides({ streamTargets: [target] }))).toBe('network')
    }
    expect(
      classify(withOverrides({ streamTargets: [streamTarget('connecting', 'Connecting…')] }))
    ).toBe('healthy')
  })

  // Plan 218: the streamer's sessions reported bottleneck "capture" (a static
  // screen idles) while a third of the stream's frames were skipped.
  it('names a choppy stream over the inferred capture bottleneck', () => {
    expect(
      classify(
        withOverrides({
          diagnosticStats: {
            bottleneck: 'capture',
            streamDelivery: streamDelivery({ degraded: true, deliveredFps: 21, dropPercent: 30 })
          }
        })
      )
    ).toBe('choppy')
    expect(
      classify(
        withOverrides({
          diagnosticStats: { streamDelivery: streamDelivery({ deliveredFps: 59, dropPercent: 2 }) }
        })
      )
    ).toBe('healthy')
  })

  it('names a slow connection while the bitrate is lowered, at its floor, or a leg overflowed', () => {
    const lowered = streamDelivery({ bitrateKbps: 4_800, chosenBitrateKbps: 6_000 })
    expect(classify(withOverrides({ diagnosticStats: { streamDelivery: lowered } }))).toBe('uplink')
    expect(
      classify(
        withOverrides({
          diagnosticStats: {
            streamDelivery: streamDelivery({
              bitrateKbps: 3_000,
              chosenBitrateKbps: 6_000,
              atFloor: true
            })
          }
        })
      )
    ).toBe('uplink')
    const restored = streamDelivery({ bitrateKbps: 6_000, chosenBitrateKbps: 6_000 })
    expect(classify(withOverrides({ diagnosticStats: { streamDelivery: restored } }))).toBe(
      'healthy'
    )
    const nowMs = Date.parse('2026-11-05T12:00:00.000Z')
    const input = healthyInput()
    input.streamTargets = [overflowingTarget(nowMs - 30_000)]
    expect(
      classifyStreamHealthAttribution(
        input.diagnosticStats,
        input.streamHealth,
        input.streamTargets,
        NO_RECENT_DROPS,
        nowMs
      )
    ).toBe('uplink')
    input.streamTargets = [overflowingTarget(nowMs - RECENT_UPLINK_OVERFLOW_WINDOW_MS - 1)]
    expect(
      classifyStreamHealthAttribution(
        input.diagnosticStats,
        input.streamHealth,
        input.streamTargets,
        NO_RECENT_DROPS,
        nowMs
      )
    ).toBe('healthy')
  })

  it('never reads a bitrate below the configured one as delivery trouble', () => {
    // #981: a static screen encodes far below the configured rate on
    // purpose (777 of 6000 kbps in the report); delivery trouble is what
    // the destinations report.
    expect(classify(withOverrides({ streamHealth: { bitrateKbps: 777 } }))).toBe('healthy')
    expect(
      classify(
        withOverrides({
          streamHealth: { bitrateKbps: undefined },
          diagnosticStats: { streamMeasuredBitrateKbps: 777 }
        })
      )
    ).toBe('healthy')
    expect(
      classify(
        withOverrides({
          streamHealth: { bitrateKbps: 777 },
          streamTargets: [streamTarget('reconnecting', 'Reconnecting…')]
        })
      )
    ).toBe('network')
  })

  it('does not name a network problem before media health is known', () => {
    const input = unknownInput()
    input.streamHealth = streamHealth({ fps: undefined, speed: undefined, bitrateKbps: 1_000 })
    input.streamTargets = [streamTarget('failed')]
    input.diagnosticStats.bottleneck = 'unknown'
    expect(classify(input)).toBe('unknown')
  })

  it('does not call target trouble network when an earlier media stage is unhealthy', () => {
    expect(
      classify(
        withOverrides({
          diagnosticStats: { encoderSpeed: 0.8 },
          streamTargets: [streamTarget('failed')]
        })
      )
    ).toBe('encoder')
  })

  it('returns healthy only when current-session media evidence exists', () => {
    expect(classify(healthyInput())).toBe('healthy')
    expect(classify(unknownInput())).toBe('unknown')

    const stale = unknownInput()
    stale.diagnosticStats.sessionId = 'session-b'
    stale.diagnosticStats.bottleneck = 'none'
    stale.streamHealth = streamHealth({ sessionId: 'session-a' })
    expect(classify(stale)).toBe('unknown')
  })
})

function withOverrides({
  diagnosticStats: diagnosticOverrides = {},
  streamHealth: healthOverrides = {},
  streamTargets,
  recentDrops
}: {
  diagnosticStats?: Partial<DiagnosticStats>
  streamHealth?: Partial<StreamHealth>
  streamTargets?: StreamTargetRuntime[]
  recentDrops?: Partial<RecentStreamDrops>
}): ClassifierInput {
  return {
    diagnosticStats: diagnosticStats(diagnosticOverrides),
    streamHealth: streamHealth(healthOverrides),
    streamTargets: streamTargets ?? [streamTarget('live')],
    recentDrops
  }
}

// #981: the window reads the growth of the diagnostics' drop counters, so a
// stage is dropping while its counters grow and for the window after, never
// for the rest of the session because a total is above zero.
describe('stream drop window', () => {
  const t0 = 1_700_000_000_000

  function sample(
    activity = emptyStreamDropActivity(),
    stats: Partial<DiagnosticStats> = {},
    health: Partial<StreamHealth> | null = {},
    at = t0
  ) {
    return advanceStreamDropActivity(
      activity,
      diagnosticStats(stats),
      health === null ? null : streamHealth(health),
      at
    )
  }

  it('names a stage while its counters grow, then clears after the window', () => {
    const baseline = sample()
    expect(recentStreamDrops(baseline, t0)).toEqual(NO_RECENT_DROPS)

    const dropped = sample(baseline, { encoderBridgeStreamQueueDroppedFrames: 1 }, {}, t0 + 1_000)
    expect(recentStreamDrops(dropped, t0 + 1_000)).toEqual({ ...NO_RECENT_DROPS, encoder: true })

    // The total stays at 1 for the rest of the stream (the report's case).
    let settled = dropped
    for (let second = 2; second <= 20; second += 1) {
      settled = sample(
        settled,
        { encoderBridgeStreamQueueDroppedFrames: 1 },
        {},
        t0 + second * 1_000
      )
    }
    expect(recentStreamDrops(settled, t0 + 1_000 + RECENT_DROP_WINDOW_MS)).toEqual({
      ...NO_RECENT_DROPS,
      encoder: true
    })
    expect(recentStreamDrops(settled, t0 + 1_001 + RECENT_DROP_WINDOW_MS)).toEqual(NO_RECENT_DROPS)

    const droppedAgain = sample(
      settled,
      { encoderBridgeStreamQueueDroppedFrames: 2 },
      {},
      t0 + 30_000
    )
    expect(recentStreamDrops(droppedAgain, t0 + 30_000).encoder).toBe(true)
  })

  it('watches every counter of every stage', () => {
    const cases: Array<{
      stage: keyof RecentStreamDrops
      stats?: Partial<DiagnosticStats>
      health?: Partial<StreamHealth>
    }> = [
      { stage: 'audio', stats: { micDroppedFrames: 1 } },
      { stage: 'capture', stats: { previewCameraDroppedFrames: 1 } },
      { stage: 'capture', stats: { previewScreenDroppedFrames: 1 } },
      { stage: 'encoder', stats: { droppedFrames: 1 } },
      { stage: 'encoder', stats: { encoderBridgeDroppedFrames: 1 } },
      { stage: 'encoder', stats: { encoderBridgeOutputQueueDroppedFrames: 1 } },
      { stage: 'encoder', stats: { encoderBridgeStreamQueueDroppedFrames: 1 } },
      { stage: 'encoder', stats: { encoderBridgeEncodedOutputErrors: 1 } },
      { stage: 'encoder', stats: { streamDuplicatedFrames: 1 } },
      { stage: 'encoder', health: { droppedFrames: 1 } },
      { stage: 'encoder', health: { duplicatedFrames: 1 } },
      { stage: 'preview', stats: { previewDroppedFrames: 1 } }
    ]
    for (const { stage, stats, health } of cases) {
      const baseline = sample(
        emptyStreamDropActivity(),
        { previewCameraDroppedFrames: 0, previewScreenDroppedFrames: 0 },
        { droppedFrames: 0, duplicatedFrames: 0 }
      )
      const dropped = sample(
        baseline,
        { previewCameraDroppedFrames: 0, previewScreenDroppedFrames: 0, ...stats },
        { droppedFrames: 0, duplicatedFrames: 0, ...health },
        t0 + 1_000
      )
      expect(recentStreamDrops(dropped, t0 + 1_000), JSON.stringify({ stats, health })).toEqual({
        ...NO_RECENT_DROPS,
        [stage]: true
      })
    }
  })

  it('takes a first sight, a reset and a new session as the baseline, not as drops', () => {
    // Opening the Studio mid-stream, with totals already above zero.
    const midStream = sample(emptyStreamDropActivity(), { droppedFrames: 7 }, { droppedFrames: 7 })
    expect(recentStreamDrops(midStream, t0)).toEqual(NO_RECENT_DROPS)

    // A new run resets the bridge's counters to zero.
    const reset = sample(midStream, { droppedFrames: 0 }, { droppedFrames: 0 }, t0 + 1_000)
    expect(recentStreamDrops(reset, t0 + 1_000)).toEqual(NO_RECENT_DROPS)

    // Stream health appearing with a total is a baseline too.
    const healthArrives = sample(sample(baseline(), {}, null), {}, { droppedFrames: 3 }, t0 + 1_000)
    expect(recentStreamDrops(healthArrives, t0 + 1_000)).toEqual(NO_RECENT_DROPS)

    // A new session starts over: the old session's drop is forgotten and its
    // totals never count against the new one.
    const dropped = sample(reset, { droppedFrames: 1 }, { droppedFrames: 1 }, t0 + 2_000)
    expect(recentStreamDrops(dropped, t0 + 2_000).encoder).toBe(true)
    const nextSession = sample(
      dropped,
      { sessionId: 'session-b', droppedFrames: 0 },
      { sessionId: 'session-b', droppedFrames: 0 },
      t0 + 3_000
    )
    expect(recentStreamDrops(nextSession, t0 + 3_000)).toEqual(NO_RECENT_DROPS)
    expect(nextSession.sessionId).toBe('session-b')

    function baseline() {
      return emptyStreamDropActivity()
    }
  })

  it('ignores stream health from another session', () => {
    const base = sample(emptyStreamDropActivity(), {}, { droppedFrames: 0 })
    const stale = sample(base, {}, { sessionId: 'session-b', droppedFrames: 5 }, t0 + 1_000)
    expect(recentStreamDrops(stale, t0 + 1_000)).toEqual(NO_RECENT_DROPS)
  })
})

function unknownInput(): ClassifierInput {
  return {
    diagnosticStats: diagnosticStats({
      sessionId: undefined,
      targetFps: undefined,
      captureFps: undefined,
      renderFps: undefined,
      encoderSpeed: undefined,
      streamMeasuredBitrateKbps: undefined,
      streamOutputTotalBytes: undefined,
      bottleneck: 'unknown'
    }),
    streamHealth: null,
    streamTargets: []
  }
}
