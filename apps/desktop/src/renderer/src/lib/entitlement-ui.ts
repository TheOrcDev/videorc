import type { EntitlementsSnapshot, FeatureId, StreamingSettings, VideoSettings } from './backend'
import {
  DEFAULT_BASIC_ENTITLEMENTS,
  entitlementDisabledReason,
  isFeatureEntitled
} from './entitlements'
import { isPremiumUpgradeMessage, VIDEORC_PREMIUM_URL } from './premium-upgrade'

export type EntitlementUiGate =
  | { allowed: true }
  | {
      allowed: false
      featureId: FeatureId
      reason: string
      upgradeUrl?: string
      allowFixAction?: boolean
    }

export interface StreamingDestinationEnableGateInput {
  entitlements: EntitlementsSnapshot | null
  streaming: Pick<StreamingSettings, 'enabledTargetIds'>
  targetId: string
}

export interface GoLiveEntitlementGateInput {
  entitlements: EntitlementsSnapshot | null
  streaming: Pick<StreamingSettings, 'enabledTargetIds'>
}

export interface VideoProfileEntitlementGateInput {
  entitlements: EntitlementsSnapshot | null
  kind: 'recording' | 'streaming'
  video: VideoSettings
}

export function streamingDestinationEnableGate({
  entitlements,
  streaming,
  targetId
}: StreamingDestinationEnableGateInput): EntitlementUiGate {
  if (streaming.enabledTargetIds.includes(targetId)) {
    return { allowed: true }
  }

  const livestreamingGate = featureGate(entitlements, 'livestreaming')
  if (!livestreamingGate.allowed) {
    return livestreamingGate
  }

  const maxDestinations = streamingMaxDestinations(entitlements)
  if (streaming.enabledTargetIds.length < maxDestinations) {
    return { allowed: true }
  }

  return destinationsLimitGate(entitlements, maxDestinations)
}

export function goLiveEntitlementGate({
  entitlements,
  streaming
}: GoLiveEntitlementGateInput): EntitlementUiGate {
  const livestreamingGate = featureGate(entitlements, 'livestreaming')
  if (!livestreamingGate.allowed) {
    return livestreamingGate
  }

  const maxDestinations = streamingMaxDestinations(entitlements)
  if (streaming.enabledTargetIds.length <= maxDestinations) {
    return { allowed: true }
  }

  const limitGate = destinationsLimitGate(entitlements, maxDestinations)
  if (limitGate.allowed) {
    return limitGate
  }

  return {
    ...limitGate,
    allowFixAction: true
  }
}

export function cloudAiUploadGate(entitlements: EntitlementsSnapshot | null): EntitlementUiGate {
  return featureGate(entitlements, 'cloud-ai')
}

export function noiseCleanupGate(entitlements: EntitlementsSnapshot | null): EntitlementUiGate {
  return featureGate(entitlements, 'noise-cleanup')
}

export function videoProfileEntitlementGate({
  entitlements,
  kind,
  video
}: VideoProfileEntitlementGateInput): EntitlementUiGate {
  const featureId: FeatureId = kind === 'recording' ? 'local-recording' : 'livestreaming'
  const featureAllowed = featureGate(entitlements, featureId)
  if (!featureAllowed.allowed) {
    return featureAllowed
  }

  const limits =
    kind === 'recording'
      ? (entitlements?.limits.recording ?? DEFAULT_BASIC_ENTITLEMENTS.limits.recording)
      : (entitlements?.limits.streaming ?? DEFAULT_BASIC_ENTITLEMENTS.limits.streaming)
  const bitrateLimit =
    'maxBitrateKbps' in limits && typeof limits.maxBitrateKbps === 'number'
      ? limits.maxBitrateKbps
      : undefined
  const overLimit =
    video.width > limits.maxWidth ||
    video.height > limits.maxHeight ||
    video.fps > limits.maxFps ||
    (bitrateLimit !== undefined && video.bitrateKbps > bitrateLimit)

  if (!overLimit) {
    return { allowed: true }
  }

  const reason = shouldOfferPremiumForProfileLimit(entitlements)
    ? `${formatVideoProfile(video)} requires Videorc Premium. ${formatLimit(kind, limits)}`
    : `${formatVideoProfile(video)} exceeds your ${kind} plan. ${formatLimit(kind, limits)}`
  return lockedGate(featureId, reason, true)
}

function featureGate(
  entitlements: EntitlementsSnapshot | null,
  featureId: FeatureId
): EntitlementUiGate {
  if (isFeatureEntitled(entitlements, featureId)) {
    return { allowed: true }
  }

  return lockedGate(
    featureId,
    entitlementDisabledReason(entitlements, featureId) ?? 'This Videorc feature is not enabled.'
  )
}

function destinationsLimitGate(
  entitlements: EntitlementsSnapshot | null,
  maxDestinations: number
): EntitlementUiGate {
  const reason = !isFeatureEntitled(entitlements, 'multistreaming')
    ? (entitlementDisabledReason(entitlements, 'multistreaming') ??
      'Multistreaming requires Videorc Premium.')
    : `Your current plan allows up to ${maxDestinations} streaming destinations.`

  return lockedGate('multistreaming', reason)
}

function lockedGate(
  featureId: FeatureId,
  reason: string,
  allowFixAction = false
): Exclude<EntitlementUiGate, { allowed: true }> {
  return {
    allowed: false,
    featureId,
    reason,
    ...(isPremiumUpgradeMessage(reason) ? { upgradeUrl: VIDEORC_PREMIUM_URL } : {}),
    ...(allowFixAction ? { allowFixAction: true } : {})
  }
}

function streamingMaxDestinations(entitlements: EntitlementsSnapshot | null): number {
  return (
    entitlements?.limits.streaming.maxDestinations ??
    DEFAULT_BASIC_ENTITLEMENTS.limits.streaming.maxDestinations
  )
}

function shouldOfferPremiumForProfileLimit(entitlements: EntitlementsSnapshot | null): boolean {
  return !entitlements || entitlements.tier === 'basic'
}

function formatVideoProfile(video: VideoSettings): string {
  return `${video.width}x${video.height} @ ${video.fps} FPS`
}

function formatLimit(
  kind: 'recording' | 'streaming',
  limits: EntitlementsSnapshot['limits']['recording'] | EntitlementsSnapshot['limits']['streaming']
): string {
  const bitrate =
    'maxBitrateKbps' in limits && typeof limits.maxBitrateKbps === 'number'
      ? ` and ${limits.maxBitrateKbps} kbps`
      : ''
  return `Your ${kind} limit is ${limits.maxWidth}x${limits.maxHeight} @ ${limits.maxFps} FPS${bitrate}.`
}
