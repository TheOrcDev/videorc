import type {
  EntitlementsSnapshot,
  FeatureId,
  StreamOutputOrientation,
  StreamTargetSettings,
  VideoSettings
} from './backend'
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

/** The slice of streaming settings the destination gates read: enabled ids
 *  plus each target's leg binding (absent = horizontal). */
export interface StreamingGateSettings {
  enabledTargetIds: string[]
  targets: ReadonlyArray<Pick<StreamTargetSettings, 'id' | 'outputOrientation'>>
}

export interface StreamingDestinationEnableGateInput {
  entitlements: EntitlementsSnapshot | null
  streaming: StreamingGateSettings
  targetId: string
}

export interface GoLiveEntitlementGateInput {
  entitlements: EntitlementsSnapshot | null
  streaming: StreamingGateSettings
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
  if (streaming.enabledTargetIds.length >= maxDestinations) {
    return destinationsLimitGate(entitlements, maxDestinations)
  }

  // Per-orientation cap: each composed leg fans out ONE encode; 3 targets per
  // leg is the tested shape, so enabling counts against the target's leg.
  const orientation = targetOrientation(streaming, targetId)
  const perOrientationCap = streamingMaxDestinationsPerOrientation(entitlements)
  if (enabledCountForOrientation(streaming, orientation) >= perOrientationCap) {
    return destinationsLimitGate(entitlements, perOrientationCap, orientation)
  }

  return { allowed: true }
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
  const perOrientationCap = streamingMaxDestinationsPerOrientation(entitlements)
  const overOrientation = (['horizontal', 'vertical'] as const).find(
    (orientation) => enabledCountForOrientation(streaming, orientation) > perOrientationCap
  )
  if (streaming.enabledTargetIds.length <= maxDestinations && !overOrientation) {
    return { allowed: true }
  }

  const limitGate = overOrientation
    ? destinationsLimitGate(entitlements, perOrientationCap, overOrientation)
    : destinationsLimitGate(entitlements, maxDestinations)
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
  maxDestinations: number,
  orientation?: StreamOutputOrientation
): EntitlementUiGate {
  const scope = orientation ? `${orientation} streaming destinations` : 'streaming destinations'
  const reason = !isFeatureEntitled(entitlements, 'multistreaming')
    ? (entitlementDisabledReason(entitlements, 'multistreaming') ??
      'Multistreaming requires Videorc Premium.')
    : `Your current plan allows up to ${maxDestinations} ${scope}.`

  return lockedGate('multistreaming', reason)
}

function targetOrientation(
  streaming: Pick<StreamingGateSettings, 'targets'>,
  targetId: string
): StreamOutputOrientation {
  return (
    streaming.targets.find((target) => target.id === targetId)?.outputOrientation ?? 'horizontal'
  )
}

function enabledCountForOrientation(
  streaming: StreamingGateSettings,
  orientation: StreamOutputOrientation
): number {
  return streaming.enabledTargetIds.filter(
    (id) => targetOrientation(streaming, id) === orientation
  ).length
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

function streamingMaxDestinationsPerOrientation(
  entitlements: EntitlementsSnapshot | null
): number {
  return (
    entitlements?.limits.streaming.maxDestinationsPerOrientation ??
    DEFAULT_BASIC_ENTITLEMENTS.limits.streaming.maxDestinationsPerOrientation
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
