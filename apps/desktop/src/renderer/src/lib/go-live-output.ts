import {
  STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON,
  buildStreamOutputTopologyProbeParams,
  sameTopologyVideoProfile,
  streamOutputTopologyProbeRequestKey,
  streamOutputTopologyResultMatchesRequest,
  streamOutputTopologySplitRejected
} from '@/hooks/use-studio'

import type {
  EncodeBackend,
  PerformanceCheckState,
  StreamOutputTopologyProbeParams,
  StreamOutputTopologyProbeResult,
  StreamingSettings,
  VideoSettings
} from '../../../shared/backend'
import {
  providerStreamOutputPlanOptions,
  resolveProviderStreamOutputPlan,
  simulcastArmed,
  simulcastStreamVideo,
  streamOutputVideoForTarget,
  videoPresets,
  type CaptureConfig,
  type ProviderStreamOutputPlanOptions
} from './capture'
import { isUntrustedPerformanceCheckResult, outputLabel, outputVerdict } from './performance-check'

// Everything a livestream start decides about its own output (plan 090):
// which topology the host can run, whether the recording shares the stream's
// encode, and whether a CPU-encoded stream steps down to what this computer
// measurably holds. Loaded on the first Go Live, never at startup.

/**
 * The one profile a record+stream session can share when the host cannot run
 * a separate encoded stream role: the recording takes the destinations'
 * profile. Null when the destinations disagree with each other (the backend
 * resolves each destination from its own settings, so a recording override
 * alone cannot make that session share one encode) or when simulcast owns the
 * auxiliary role.
 */
export function sharedEncodeFallbackVideo(
  recording: VideoSettings,
  streaming: StreamingSettings | undefined,
  options: ProviderStreamOutputPlanOptions = {}
): VideoSettings | null {
  if (!streaming?.enabled || !options.recordEnabled || options.simulcastArmed) {
    return null
  }
  const targetVideos = streaming.targets
    .filter((target) => target.enabled)
    .map((target) => streamOutputVideoForTarget(recording, streaming, target))
  const [first] = targetVideos
  if (!first || !targetVideos.every((video) => sameTopologyVideoProfile(video, first))) {
    return null
  }
  // A requested 4K recording must not silently become HD on a shared encoder.
  if (
    Math.min(recording.width, recording.height) >= 2160 &&
    Math.min(first.width, first.height) < Math.min(recording.width, recording.height)
  )
    return null
  const shared = resolveProviderStreamOutputPlan(recording, streaming, {
    ...options,
    separateEncodedOutputRoleAvailable: false
  }).streamVideo
  return sameTopologyVideoProfile(shared, first) ? { ...first } : null
}

export interface StreamOutputTopologyRequest {
  params: StreamOutputTopologyProbeParams
  /**
   * Set when the host rejected the separate stream role and sharing one
   * encode changes the recording: it takes this profile for the session. The
   * probe request and `session.start` must both use it.
   */
  sharedFallbackVideo: VideoSettings | null
}

/**
 * The topology a livestream start should probe and run. Starts from the
 * optimistic split request; once the host has rejected that exact split, it
 * re-plans as one shared encode at the destinations' profile instead of
 * leaving the user to match the bitrates by hand.
 */
export function resolveStreamOutputTopologyRequest(
  captureConfig: CaptureConfig,
  streaming: StreamingSettings,
  suppressCaptionsForSession: boolean,
  rejectedSplitRequestKeys: ReadonlySet<string>
): StreamOutputTopologyRequest {
  const params = buildStreamOutputTopologyProbeParams(
    captureConfig,
    streaming,
    suppressCaptionsForSession
  )
  if (
    params.outputRoles.includes('stream') &&
    rejectedSplitRequestKeys.has(streamOutputTopologyProbeRequestKey(params))
  ) {
    const video = sharedEncodeFallbackVideo(
      captureConfig.video,
      streaming,
      providerStreamOutputPlanOptions({ ...captureConfig, streaming })
    )
    // Captions burned into the stream only need a clean recording beside a
    // captioned stream, which one encode cannot give. Captions that are off
    // only pre-arm the split, and the backend never blocks a start for that.
    const needsCleanRecording =
      captureConfig.captions.enabled &&
      !suppressCaptionsForSession &&
      captureConfig.captions.burnTarget === 'stream'
    if (video && !needsCleanRecording) {
      return {
        params: {
          streamProfile: { ...video },
          recordingProfile: { ...video },
          outputRoles: ['shared']
        },
        sharedFallbackVideo: sameTopologyVideoProfile(video, captureConfig.video) ? null : video
      }
    }
  }
  return { params, sharedFallbackVideo: null }
}

const pixels = (video: Pick<VideoSettings, 'width' | 'height'>): number =>
  video.width * video.height

/** What the measured machine means for a livestream about to start. */
export type SoftwareStreamAdvice =
  | {
      /** The stream goes out at the largest output that held steady. */
      kind: 'step-down'
      requested: VideoSettings
      video: VideoSettings
    }
  | {
      /** Nothing held steady, not even the floor: warn, never pretend. */
      kind: 'below-floor'
      floor: VideoSettings
    }

const SOFTWARE_ENCODE_BACKENDS: readonly EncodeBackend[] = [
  'software-open-h264',
  'software-media-foundation',
  'software-x264'
]

/**
 * Plan 090 D2 / B3. Only a session that will encode on the CPU is advised:
 * a hardware encoder's stream profile is the user's call, and a stale or
 * untrusted measurement advises nothing. Portrait streams are left alone;
 * the ladder is landscape.
 */
export function softwareStreamAdvice({
  streamVideo,
  encodeBackend,
  state
}: {
  streamVideo: VideoSettings
  encodeBackend: EncodeBackend | undefined
  state: PerformanceCheckState | undefined
}): SoftwareStreamAdvice | null {
  const result = state?.result
  if (
    !result ||
    state.stale ||
    isUntrustedPerformanceCheckResult(result) ||
    !encodeBackend ||
    !SOFTWARE_ENCODE_BACKENDS.includes(encodeBackend) ||
    streamVideo.width < streamVideo.height
  ) {
    return null
  }
  if (result.belowFloor) {
    return { kind: 'below-floor', floor: result.recommended }
  }
  const recommended = videoPresets[result.recommended.preset]
  if (
    result.recommended.preset === 'custom' ||
    !recommended ||
    outputVerdict(streamVideo, result) !== 'too-heavy' ||
    pixels(streamVideo) < pixels(recommended) ||
    streamVideo.fps < recommended.fps ||
    (pixels(streamVideo) === pixels(recommended) && streamVideo.fps === recommended.fps)
  ) {
    return null
  }
  // A stream never goes out above the provider-safe rate, whatever the
  // recording preset of that size uses.
  return {
    kind: 'step-down',
    requested: streamVideo,
    video: { ...recommended, bitrateKbps: Math.min(recommended.bitrateKbps, 6000) }
  }
}

/**
 * The same destinations at the stepped-down profile, for one session. Every
 * enabled landscape destination gets the profile explicitly, so no
 * per-destination or provider default can pull one of them back up. Saved
 * settings are never written.
 */
export function streamingAtSteppedDownProfile(
  streaming: StreamingSettings,
  video: VideoSettings
): StreamingSettings {
  return {
    ...streaming,
    defaultOutputPreset: video.preset,
    defaultBitrateKbps: video.bitrateKbps,
    targets: streaming.targets.map((target) =>
      target.enabled && target.outputOrientation !== 'vertical'
        ? { ...target, outputPreset: video.preset, outputBitrateKbps: video.bitrateKbps }
        : target
    )
  }
}

/** What one Go Live session will actually record and stream at, and why. */
export interface GoLiveSessionOutput {
  /** Why the start cannot proceed; null when it can. */
  reason: string | null
  /** The recording profile for this session. */
  video: VideoSettings
  /** The destinations for this session, at their effective profile. */
  streaming: StreamingSettings
  /** The recording was moved to the stream's profile (no separate encoder). */
  sharedFallbackVideo: VideoSettings | null
  /** The stream was moved down to what this computer measurably holds. */
  steppedDown: Extract<SoftwareStreamAdvice, { kind: 'step-down' }> | null
  /** Software encoding on a computer where not even this floor held steady. */
  belowFloor: VideoSettings | null
}

export interface GoLiveSessionOutputDeps {
  captureConfig: CaptureConfig
  streaming: StreamingSettings
  suppressCaptionsForSession: boolean
  performanceCheck: PerformanceCheckState | undefined
  /** Split requests this backend has already rejected. */
  rejectedSplitKeys: () => ReadonlySet<string>
  noteRejectedSplit: (requestKey: string) => void
  /** The request the idle check owns: its verdict also feeds the Livestream panel. */
  isSavedRequest: (requestKey: string) => boolean
  /** The idle check's probe: joins a running check and updates the panel. */
  probeSaved: (params: StreamOutputTopologyProbeParams) => Promise<StreamOutputTopologyProbeResult>
  /**
   * Verdicts for profiles other than the saved one (the shared fallback, a
   * stepped-down stream). Asked for without touching the idle check, which
   * keeps describing the saved settings. A verdict depends only on the
   * request and this backend, so it is remembered until the next re-check.
   */
  sessionResults: Map<string, StreamOutputTopologyProbeResult>
  request: (params: StreamOutputTopologyProbeParams) => Promise<StreamOutputTopologyProbeResult>
}

async function probeForSession(
  deps: GoLiveSessionOutputDeps,
  params: StreamOutputTopologyProbeParams
): Promise<StreamOutputTopologyProbeResult> {
  const requestKey = streamOutputTopologyProbeRequestKey(params)
  if (deps.isSavedRequest(requestKey)) {
    return deps.probeSaved(params)
  }
  const cached = deps.sessionResults.get(requestKey)
  if (cached) {
    return cached
  }
  const result = await deps.request(params)
  if (!streamOutputTopologyResultMatchesRequest(result, params)) {
    throw new Error(
      'Backend returned a livestream output verdict for a different output configuration.'
    )
  }
  deps.sessionResults.set(requestKey, result)
  return result
}

/**
 * Waits for the output check instead of refusing while it runs, takes the
 * shared-encode fallback when the host rejects the split, and steps a
 * software-encoded stream down. Returns why the start cannot proceed, or
 * exactly what the session must record and stream at.
 */
export async function settleGoLiveSessionOutput(
  deps: GoLiveSessionOutputDeps
): Promise<GoLiveSessionOutput> {
  let config = deps.captureConfig
  let streaming = deps.streaming
  let steppedDown: Extract<SoftwareStreamAdvice, { kind: 'step-down' }> | null = null
  let interrupted = false
  const blocked = (reason: string): GoLiveSessionOutput => ({
    reason,
    video: deps.captureConfig.video,
    streaming: deps.streaming,
    sharedFallbackVideo: null,
    steppedDown: null,
    belowFloor: null
  })
  const resolve = (): ReturnType<typeof resolveStreamOutputTopologyRequest> =>
    resolveStreamOutputTopologyRequest(
      config,
      streaming,
      deps.suppressCaptionsForSession,
      deps.rejectedSplitKeys()
    )
  // Bounded: split → shared, at most one step-down, then the same pair again
  // at the stepped profile.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const request = resolve()
    let result: StreamOutputTopologyProbeResult
    try {
      result = await probeForSession(deps, request.params)
    } catch (error) {
      // A newer check for another profile superseded this one; ask once more.
      if (error instanceof Error && error.name === 'AbortError' && !interrupted) {
        interrupted = true
        continue
      }
      return blocked(
        `Livestream output check failed: ${
          error instanceof Error ? error.message : 'the output path could not be verified.'
        }`
      )
    }
    if (streamOutputTopologySplitRejected(result)) {
      deps.noteRejectedSplit(streamOutputTopologyProbeRequestKey(request.params))
      if (resolve().params.outputRoles.includes('stream')) {
        return blocked(STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON)
      }
      continue
    }
    const advice = simulcastArmed({ ...config, streaming })
      ? null
      : softwareStreamAdvice({
          streamVideo: request.params.streamProfile,
          encodeBackend: result.effectiveEncodeBackend,
          state: deps.performanceCheck
        })
    if (
      advice?.kind === 'step-down' &&
      deps.captureConfig.recordEnabled &&
      Math.min(deps.captureConfig.video.width, deps.captureConfig.video.height) >= 2160
    ) {
      return blocked(
        'This computer cannot preserve the selected 4K recording while streaming. Choose Full HD recording or turn off streaming.'
      )
    }
    if (advice?.kind === 'step-down' && !steppedDown) {
      // One encode on the CPU: the recording shares the stepped profile.
      steppedDown = advice
      streaming = streamingAtSteppedDownProfile(streaming, advice.video)
      config = { ...config, video: advice.video, streaming }
      continue
    }
    const video = request.sharedFallbackVideo ?? config.video
    const plan = resolveProviderStreamOutputPlan(video, streaming, {
      ...providerStreamOutputPlanOptions(config),
      separateEncodedOutputRoleAvailable: request.params.outputRoles.includes('stream')
    })
    const resolved = new Map(plan.targets.map((output) => [output.target?.id, output.video]))
    if (simulcastArmed({ ...config, streaming })) {
      const vertical = simulcastStreamVideo(video, streaming)
      for (const target of streaming.targets) {
        if (target.enabled && target.outputOrientation === 'vertical')
          resolved.set(target.id, vertical)
      }
      if (
        config.recordEnabled &&
        plan.targets.length &&
        !sameTopologyVideoProfile(video, plan.streamVideo)
      ) {
        return blocked(
          'The recording and horizontal stream must use matching quality when also streaming vertically. Use one stream orientation or match their quality.'
        )
      }
    }
    const needsOverrides = streaming.targets.some((target) => {
      const effective = resolved.get(target.id)
      return (
        effective &&
        !sameTopologyVideoProfile(streamOutputVideoForTarget(video, streaming, target), effective)
      )
    })
    const effectiveStreaming = needsOverrides
      ? {
          ...streaming,
          targets: streaming.targets.map((target) => {
            const effective = resolved.get(target.id)
            return effective
              ? {
                  ...target,
                  outputPreset: effective.preset,
                  outputBitrateKbps: effective.bitrateKbps
                }
              : target
          })
        }
      : streaming
    return {
      reason: null,
      video,
      streaming: effectiveStreaming,
      sharedFallbackVideo:
        !steppedDown && request.sharedFallbackVideo ? request.sharedFallbackVideo : null,
      steppedDown,
      belowFloor: advice?.kind === 'below-floor' ? advice.floor : null
    }
  }
  return blocked('Livestream output check did not settle. Try Go Live again.')
}

/** The one notice a session shows when its output differs from the saved settings. */
export function goLiveSessionOutputNotice(
  output: Pick<GoLiveSessionOutput, 'steppedDown' | 'sharedFallbackVideo'>
): { title: string; description: string } | null {
  if (output.steppedDown) {
    return {
      title: `Streaming at ${outputLabel(output.steppedDown.video)}.`,
      description: `This computer can't encode ${outputLabel(output.steppedDown.requested)} in real time, so this session uses the largest output that held steady in its performance check.`
    }
  }
  if (output.sharedFallbackVideo) {
    const shared = output.sharedFallbackVideo
    return {
      title: 'Recording will match the stream.',
      description: `This computer can't encode a separate recording while streaming, so both use ${shared.width}×${shared.height}, ${shared.fps} fps, ${shared.bitrateKbps} kbps.`
    }
  }
  return null
}
