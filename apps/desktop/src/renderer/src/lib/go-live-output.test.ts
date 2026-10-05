import { describe, expect, it, vi } from 'vitest'

import { STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON } from '@/hooks/use-studio'

import type {
  StreamOutputTopologyProbeParams,
  StreamOutputTopologyProbeResult
} from '../../../shared/backend'
import { defaultCaptureConfig, videoPresets, type CaptureConfig } from './capture'
import {
  goLiveSessionOutputNotice,
  settleGoLiveSessionOutput,
  type GoLiveSessionOutputDeps
} from './go-live-output'

const stream = videoPresets['stream-safe-1080p30']

function recordAndStreamConfig(overrides: Partial<CaptureConfig> = {}): CaptureConfig {
  return {
    ...defaultCaptureConfig,
    recordEnabled: true,
    streamEnabled: true,
    // The recording asks for more than the stream.
    video: { ...stream, preset: 'custom', bitrateKbps: 8000 },
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      defaultOutputPreset: stream.preset,
      defaultBitrateKbps: stream.bitrateKbps,
      enabledTargetIds: ['youtube'],
      targets: defaultCaptureConfig.streaming.targets.map((target) => ({
        ...target,
        enabled: target.id === 'youtube'
      }))
    },
    ...overrides
  }
}

// A host with no usable hardware encoder: every request comes back on the raw
// path with OpenH264, so a split request is a rejected split.
function softwareHost(params: StreamOutputTopologyProbeParams): StreamOutputTopologyProbeResult {
  return {
    capabilityKey: `stream-output-topology-v1:${'0'.repeat(64)}`,
    streamProfile: params.streamProfile,
    ...(params.recordingProfile ? { recordingProfile: params.recordingProfile } : {}),
    outputRoles: params.outputRoles,
    requestedBridgeOutput: 'windows-media-foundation-h264-mpegts',
    effectiveBridgeOutput: 'raw-yuv420p',
    effectiveEncodeBackend: 'software-open-h264',
    probeState: 'rejected',
    fallbackReason: 'stage=process-output HRESULT=0x8000FFFF'
  }
}

function deps(
  captureConfig: CaptureConfig,
  overrides: Partial<GoLiveSessionOutputDeps> = {}
): GoLiveSessionOutputDeps & { request: ReturnType<typeof vi.fn> } {
  let rejected: ReadonlySet<string> = new Set()
  const request = vi.fn(async (params: StreamOutputTopologyProbeParams) => softwareHost(params))
  return {
    captureConfig,
    streaming: captureConfig.streaming,
    suppressCaptionsForSession: false,
    performanceCheck: undefined,
    rejectedSplitKeys: () => rejected,
    noteRejectedSplit: (requestKey) => {
      rejected = new Set(rejected).add(requestKey)
    },
    isSavedRequest: () => false,
    probeSaved: async (params) => softwareHost(params),
    sessionResults: new Map(),
    request,
    ...overrides
  } as GoLiveSessionOutputDeps & { request: ReturnType<typeof vi.fn> }
}

describe('settleGoLiveSessionOutput (plan 090)', () => {
  it('shares one encode at the stream profile when the host rejects the split', async () => {
    const config = recordAndStreamConfig()
    const output = await settleGoLiveSessionOutput(deps(config))

    expect(output.reason).toBeNull()
    expect(output.video).toMatchObject({ width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 })
    expect(output.sharedFallbackVideo).toMatchObject({ bitrateKbps: 6000 })
    expect(output.steppedDown).toBeNull()
    expect(output.streaming).toBe(config.streaming)
  })

  it('materializes the shared effective profile before preparing mixed destinations', async () => {
    const config = recordAndStreamConfig({
      recordEnabled: false,
      video: videoPresets['record-4k30']
    })
    config.streaming = {
      ...config.streaming,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.id === 'youtube' || target.id === 'twitch'
      }))
    }
    const output = await settleGoLiveSessionOutput(deps(config))
    expect(output.reason).toBeNull()
    for (const target of output.streaming.targets.filter((target) => target.enabled)) {
      expect(target).toMatchObject({ outputPreset: 'stream-safe-1080p30', outputBitrateKbps: 6000 })
    }
    expect(
      config.streaming.targets.find((target) => target.id === 'youtube')?.outputPreset
    ).toBeUndefined()
  })

  it('refuses a third distinct output before preparing any provider', async () => {
    const config = recordAndStreamConfig({ video: videoPresets['record-4k30'] })
    config.streaming = {
      ...config.streaming,
      enabledTargetIds: ['youtube', 'youtube-vertical'],
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.id === 'youtube' || target.id === 'youtube-vertical'
      }))
    }
    const output = await settleGoLiveSessionOutput(
      deps(config, {
        request: vi.fn(
          async (params): Promise<StreamOutputTopologyProbeResult> => ({
            ...softwareHost(params),
            effectiveBridgeOutput: 'videotoolbox-h264-mpegts',
            effectiveEncodeBackend: 'hardware-videotoolbox',
            probeState: 'passed'
          })
        )
      })
    )
    expect(output.reason).toContain('matching quality')
    expect(output.video).toEqual(videoPresets['record-4k30'])
  })

  it('refuses to silently downgrade a 4K recording when the split encoder is unavailable', async () => {
    const config = recordAndStreamConfig({ video: videoPresets['record-4k30'] })
    const output = await settleGoLiveSessionOutput(deps(config))
    expect(output.reason).toBeTruthy()
    expect(output.video).toEqual(videoPresets['record-4k30'])
    expect(output.sharedFallbackVideo).toBeNull()
  })

  it('stays blocked, in plain words, for live captions burned into the stream only', async () => {
    const config = recordAndStreamConfig()
    const captioned = {
      ...config,
      captions: { ...config.captions, enabled: true, burnTarget: 'stream' as const }
    }
    const output = await settleGoLiveSessionOutput(deps(captioned))

    expect(output.reason).toBe(STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON)
    expect(output.reason).not.toMatch(/HRESULT|Media Foundation/)
    expect(output.video).toBe(captioned.video)
  })

  it('reports a failed check instead of starting without a verdict', async () => {
    const config = recordAndStreamConfig()
    const output = await settleGoLiveSessionOutput(
      deps(config, {
        request: vi.fn(async () => {
          throw new Error('Backend socket is not connected.')
        })
      })
    )
    expect(output.reason).toBe('Livestream output check failed: Backend socket is not connected.')
  })

  it('asks the backend once per profile across starts and leaves the saved check alone', async () => {
    const config = recordAndStreamConfig()
    const shared = deps(config)
    const probeSaved = vi.fn(shared.probeSaved)
    const wired = { ...shared, probeSaved }

    await settleGoLiveSessionOutput(wired)
    const afterFirst = shared.request.mock.calls.length
    await settleGoLiveSessionOutput(wired)

    // Split, then the shared re-plan; the second start reuses both verdicts.
    expect(afterFirst).toBe(2)
    expect(shared.request.mock.calls.length).toBe(afterFirst)
    expect(probeSaved).not.toHaveBeenCalled()
  })

  it('uses the idle check for the saved request so the panel and the start agree', async () => {
    const config = recordAndStreamConfig({ recordEnabled: false, video: stream })
    const wired = deps(config, { isSavedRequest: () => true })
    const probeSaved = vi.fn(wired.probeSaved)

    const output = await settleGoLiveSessionOutput({ ...wired, probeSaved })

    expect(output.reason).toBeNull()
    expect(probeSaved).toHaveBeenCalledTimes(1)
    expect(wired.request).not.toHaveBeenCalled()
  })
})

describe('goLiveSessionOutputNotice', () => {
  it('is silent when the saved settings go out as they are', () => {
    expect(goLiveSessionOutputNotice({ steppedDown: null, sharedFallbackVideo: null })).toBeNull()
  })

  it('names the stepped-down output, and the shared profile otherwise', () => {
    expect(
      goLiveSessionOutputNotice({
        steppedDown: {
          kind: 'step-down',
          requested: stream,
          video: videoPresets['tutorial-720p30']
        },
        sharedFallbackVideo: null
      })
    ).toMatchObject({ title: 'Streaming at 720p 30.' })

    const shared = goLiveSessionOutputNotice({ steppedDown: null, sharedFallbackVideo: stream })
    expect(shared?.title).toBe('Recording will match the stream.')
    expect(shared?.description).toContain('1920×1080, 30 fps, 6000 kbps')
  })
})
