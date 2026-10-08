import type {
  EntitlementCapability,
  EntitlementsSnapshot,
  FeatureId,
  StreamingEntitlementLimits
} from './backend'

/**
 * Multistreaming is free for every plan (mirror of the backend's
 * STREAMING_MAX_DESTINATIONS): one shared destination cap for Basic, Premium
 * and Developer.
 */
export const STREAMING_MAX_DESTINATIONS = 5

/**
 * Streaming quality is free for every plan too (Plan 075, 2026-09-28): one
 * shared ceiling for Basic, Premium and Developer, mirroring the backend's
 * STREAMING_MAX_* constants. The rectangular 4K×60 ceiling does not make 4K60
 * a supported stream profile — profile validation still rejects it, and true
 * 4K remains the exact YouTube 4K30 profile.
 */
export const STREAMING_LIMITS: StreamingEntitlementLimits = {
  maxWidth: 3840,
  maxHeight: 2160,
  maxFps: 60,
  maxBitrateKbps: 30000,
  maxDestinations: STREAMING_MAX_DESTINATIONS
}

export const DEFAULT_BASIC_ENTITLEMENTS: EntitlementsSnapshot = {
  schemaVersion: 1,
  tier: 'basic',
  source: 'local-default',
  capabilities: [
    {
      featureId: 'local-recording',
      state: 'enabled'
    },
    {
      featureId: 'livestreaming',
      state: 'enabled'
    },
    {
      // Free for every plan; the capability stays on the wire (strict enum on
      // both sides) and a missing snapshot must never lock it.
      featureId: 'multistreaming',
      state: 'enabled'
    },
    {
      featureId: 'cloud-ai',
      state: 'disabled',
      reason: 'Cloud AI is a Videorc Premium feature.'
    },
    {
      featureId: 'noise-cleanup',
      state: 'disabled',
      reason: 'Noise Cleanup requires Videorc Premium.'
    },
    {
      featureId: 'live-cohost',
      state: 'disabled',
      reason: 'Golem requires Videorc Premium.'
    }
  ],
  limits: {
    // Recording is free at full quality on every tier (mirror of the backend's
    // recording_limits — the website promises free 4K local recording).
    recording: {
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 60
    },
    streaming: STREAMING_LIMITS
  }
}

export function entitlementCapability(
  snapshot: EntitlementsSnapshot | null,
  featureId: FeatureId
): EntitlementCapability {
  const capability = snapshot?.capabilities.find((item) => item.featureId === featureId)
  if (capability) {
    return capability
  }

  const fallback = DEFAULT_BASIC_ENTITLEMENTS.capabilities.find(
    (item) => item.featureId === featureId
  )
  if (fallback) {
    return fallback
  }

  return {
    featureId,
    state: 'disabled',
    reason: 'This Videorc feature is not enabled.'
  }
}

export function isFeatureEntitled(
  snapshot: EntitlementsSnapshot | null,
  featureId: FeatureId
): boolean {
  return entitlementCapability(snapshot, featureId).state !== 'disabled'
}

export function entitlementDisabledReason(
  snapshot: EntitlementsSnapshot | null,
  featureId: FeatureId
): string | null {
  const capability = entitlementCapability(snapshot, featureId)
  if (capability.state !== 'disabled') {
    return null
  }

  return capability.reason ?? 'This Videorc feature is not enabled.'
}
