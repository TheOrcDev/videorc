import { describe, expect, it } from 'vitest'

import type { DiagnosticStats, StreamHealth, StreamTargetRuntime } from '@/lib/backend'
import {
  classifyStreamHealthAttribution,
  type StreamHealthAttribution
} from '@/lib/stream-health-attribution'

type ClassifierInput = {
  diagnosticStats: DiagnosticStats
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
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
}> = [
  { expected: 'device', diagnosticStats: { deviceDisconnected: true } },
  { expected: 'audio', diagnosticStats: { micDroppedFrames: 1 } },
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
  { expected: 'preview', diagnosticStats: { previewDroppedFrames: 1 } }
]

function withProblemSignals(...signals: (typeof problemSignals)[number][]): ClassifierInput {
  const input = healthyInput()
  input.diagnosticStats = diagnosticStats(
    Object.assign({}, ...signals.map((signal) => signal.diagnosticStats))
  )
  input.streamTargets = signals.flatMap((signal) => signal.streamTargets ?? [])
  return input
}

function classify(input: ClassifierInput): StreamHealthAttribution {
  return classifyStreamHealthAttribution(
    input.diagnosticStats,
    input.streamHealth,
    input.streamTargets
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

  it('attributes output drops, duplicate frames, and bridge errors to the encoder', () => {
    const encoderSignals: Partial<DiagnosticStats>[] = [
      { droppedFrames: 1 },
      { encoderBridgeDroppedFrames: 1 },
      { encoderBridgeOutputQueueDroppedFrames: 1 },
      { encoderBridgeStreamQueueDroppedFrames: 1 },
      { encoderBridgeEncodedOutputErrors: 1 },
      { encoderBridgeError: 'writer stopped' },
      { streamDuplicatedFrames: 1 }
    ]

    for (const signal of encoderSignals) {
      expect(classify(withOverrides({ diagnosticStats: signal }))).toBe('encoder')
    }
    expect(classify(withOverrides({ streamHealth: { droppedFrames: 1 } }))).toBe('encoder')
    expect(classify(withOverrides({ streamHealth: { duplicatedFrames: 1 } }))).toBe('encoder')
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

  it('uses rolling bitrate below 90 percent only after media health is known', () => {
    expect(classify(withOverrides({ streamHealth: { bitrateKbps: 5_400 } }))).toBe('healthy')
    expect(classify(withOverrides({ streamHealth: { bitrateKbps: 5_399 } }))).toBe('network')

    const input = unknownInput()
    input.streamHealth = streamHealth({ fps: undefined, speed: undefined, bitrateKbps: 1_000 })
    input.diagnosticStats.streamOutputBitrateKbps = 6_000
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
  streamTargets
}: {
  diagnosticStats?: Partial<DiagnosticStats>
  streamHealth?: Partial<StreamHealth>
  streamTargets?: StreamTargetRuntime[]
}): ClassifierInput {
  return {
    diagnosticStats: diagnosticStats(diagnosticOverrides),
    streamHealth: streamHealth(healthOverrides),
    streamTargets: streamTargets ?? [streamTarget('live')]
  }
}

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
