import type { AiCapabilities, CaptionTransport } from '@/lib/backend'
import type { CaptionBurnTarget } from '@/lib/capture'

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
}

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
      description:
        'Livestream caption burn-in currently supports up to 30 fps. Choose a 30 fps output, select Recording only, or continue this session without captions.'
    }
  }

  if (input.recordEnabled && uniqueProfiles(streamVideos).length > 1) {
    return {
      ready: false,
      description:
        'Captioned record + multistream currently requires one shared stream output profile. Match the enabled destination profiles, or continue this session without captions.'
    }
  }

  return { ready: true }
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
        ? 'Realtime microphone transcription is ready.'
        : 'Caption transcription is ready with a slightly higher delay.',
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
