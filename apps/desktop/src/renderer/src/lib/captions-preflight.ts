import type { AiCapabilities, CaptionTransport } from '@/lib/backend'
import {
  providerStreamOutputPlanOptions,
  streamOutputVideosForTargets,
  type CaptionBurnTarget,
  type CaptureConfig
} from '@/lib/capture'

export type GoLiveCaptionsReadiness = {
  kind: 'disabled' | 'ready' | 'blocked' | 'skipped'
  blocksStart: boolean
  title: string
  description: string
  transport: CaptionTransport | null
}

export type CaptionSessionOutputReadiness = {
  ready: boolean
  description?: string
  /** Which rule the output breaks, for a short label (the Livestream checklist). */
  reason?: CaptionOutputRule
}

/** The two output rules livestream captions have (plan 174 S3.4, D-9). */
export type CaptionOutputRule = 'frame-rate' | 'one-stream-quality'

type CaptionOutputProfile = {
  width: number
  height: number
  fps: number
  bitrateKbps: number
}

/**
 * Live caption pixels require the maintained compositor path and one
 * captioned stream profile beside a clean recording. Fail before Go Live
 * instead of promising captions to only some viewers.
 */
export function captionSessionOutputReadiness(input: {
  burnTarget: CaptionBurnTarget
  recordEnabled: boolean
  streamEnabled: boolean
  recordingVideo: CaptionOutputProfile
  streamVideos: CaptionOutputProfile[]
}): CaptionSessionOutputReadiness {
  const burnsStream = input.burnTarget === 'stream' || input.burnTarget === 'both'
  if (!burnsStream || !input.streamEnabled) return { ready: true }

  const streamVideos = input.streamVideos.length > 0 ? input.streamVideos : [input.recordingVideo]
  if (input.recordingVideo.fps > 30 || streamVideos.some((video) => video.fps > 30)) {
    return {
      ready: false,
      reason: 'frame-rate',
      description:
        'Captions on a livestream work up to 30 fps. Choose a 30 fps quality in Output, or go live without captions this time.'
    }
  }

  if (input.recordEnabled && uniqueProfiles(streamVideos).length > 1) {
    return {
      ready: false,
      reason: 'one-stream-quality',
      description:
        'Captions on a livestream you also record need one stream quality for every destination. Give your destinations the same quality in Livestream, or go live without captions this time.'
    }
  }

  return { ready: true }
}

/** The short words for a broken rule, where a sentence doesn't fit (a checklist row). */
export const CAPTION_OUTPUT_RULE_LABELS: Readonly<Record<CaptionOutputRule, string>> = {
  'frame-rate': 'Need 30 fps or less',
  'one-stream-quality': 'Need one stream quality'
}

/**
 * The caption rule a livestream would break with today's setup, asked before
 * Go Live (plan 174 S3.4, D-9): the Livestream checklist and the Captions
 * page say it, so the Go Live dialog is never the first place it shows. The
 * same check the dialog runs, as if going live now whatever the last start
 * was. Null when captions are off or the output fits.
 */
export function livestreamCaptionsBlocker(input: {
  captionsEnabled: boolean
  burnTarget: CaptionBurnTarget
  recordEnabled: boolean
  recordingVideo: CaptionOutputProfile
  streamVideos: CaptionOutputProfile[]
}): { rule: CaptionOutputRule; description: string } | null {
  if (!input.captionsEnabled) return null
  const readiness = captionSessionOutputReadiness({ ...input, streamEnabled: true })
  if (readiness.ready || !readiness.reason || !readiness.description) return null
  return { rule: readiness.reason, description: readiness.description }
}

/**
 * `livestreamCaptionsBlocker` for a whole capture config: the stream outputs
 * the destinations would get if the streamer went live now.
 */
export function livestreamCaptionsBlockerFor(
  config: Pick<
    CaptureConfig,
    'captions' | 'recordEnabled' | 'streamEnabled' | 'video' | 'streaming' | 'layout'
  >
): { rule: CaptionOutputRule; description: string } | null {
  return livestreamCaptionsBlocker({
    captionsEnabled: config.captions.enabled,
    burnTarget: config.captions.burnTarget,
    recordEnabled: config.recordEnabled,
    recordingVideo: config.video,
    streamVideos: streamOutputVideosForTargets(
      config.video,
      config.streaming,
      providerStreamOutputPlanOptions(config)
    ).map(({ video }) => video)
  })
}

export function captionRuntimeStartBlocked(input: {
  captureActive: boolean
  outputReadiness: CaptionSessionOutputReadiness
}): boolean {
  return input.captureActive && !input.outputReadiness.ready
}

export function decideGoLiveCaptionsReadiness(input: {
  persistedEnabled: boolean
  suppressForSession: boolean
  capabilities: AiCapabilities | null
  outputReadiness?: CaptionSessionOutputReadiness
}): GoLiveCaptionsReadiness {
  if (!input.persistedEnabled) {
    return {
      kind: 'disabled',
      blocksStart: false,
      title: 'Captions off',
      description: 'Live captions are not enabled for this session.',
      transport: null
    }
  }
  if (input.suppressForSession) {
    return {
      kind: 'skipped',
      blocksStart: false,
      title: 'Captions skipped',
      description: 'This livestream will start without captions. Your saved setting is unchanged.',
      transport: null
    }
  }
  if (input.outputReadiness && !input.outputReadiness.ready) {
    return blocked(
      input.outputReadiness.description ??
        'Live captions are not compatible with the selected output configuration.'
    )
  }

  const captions = input.capabilities?.captions
  if (!captions) {
    return blocked(
      'Videorc could not verify live-caption readiness for this deployment. Try again, or continue this session without captions.'
    )
  }
  if (!captions.available || !captions.preferredTransport) {
    return blocked(unavailableReason(captions.reasonCode))
  }

  return {
    kind: 'ready',
    blocksStart: false,
    title: 'Captions ready',
    description:
      captions.preferredTransport === 'realtime'
        ? 'Live microphone transcription is ready.'
        : 'Caption transcription is ready in 3-second chunks, a few seconds behind.',
    transport: captions.preferredTransport
  }
}

function uniqueProfiles(profiles: CaptionOutputProfile[]): CaptionOutputProfile[] {
  return profiles.filter(
    (profile, index) =>
      profiles.findIndex(
        (candidate) =>
          candidate.width === profile.width &&
          candidate.height === profile.height &&
          candidate.fps === profile.fps &&
          candidate.bitrateKbps === profile.bitrateKbps
      ) === index
  )
}

export function captionsEnabledForSession(input: {
  persistedEnabled: boolean
  suppressForSession: boolean
}): boolean {
  return input.persistedEnabled && !input.suppressForSession
}

/**
 * Distinguish saved captions-off from an explicit/required session skip.
 * Eligible captions-off sessions pre-arm their output leg for a later
 * mid-session opt-in; unsupported output shapes cannot make that promise.
 */
export function captionsSuppressedForSession(input: {
  persistedEnabled: boolean
  explicitSuppression: boolean
  outputReadiness: CaptionSessionOutputReadiness
}): boolean {
  return input.explicitSuppression || (!input.persistedEnabled && !input.outputReadiness.ready)
}

function blocked(description: string): GoLiveCaptionsReadiness {
  return {
    kind: 'blocked',
    blocksStart: true,
    title: 'Captions unavailable',
    description,
    transport: null
  }
}

function unavailableReason(
  reasonCode: NonNullable<AiCapabilities['captions']>['reasonCode']
): string {
  switch (reasonCode) {
    case 'cloud-ai-premium-required':
      return 'Live captions are not available for this account. Continue without captions or review your plan.'
    case 'ai-user-disabled':
      return 'Live captions are disabled for this account. Continue without captions or contact support.'
    case 'captions-monthly-quota-exhausted':
      return 'Your monthly live-caption allowance is exhausted. Continue this session without captions.'
    case 'ai-disabled':
    case 'captions-disabled':
      return 'Live captions are temporarily disabled on this Videorc deployment.'
    case 'captions-invalid-config':
    case 'captions-not-configured':
      return 'Live captions are not configured correctly on this Videorc deployment.'
    default:
      return 'Live captions are not ready on this Videorc deployment.'
  }
}
