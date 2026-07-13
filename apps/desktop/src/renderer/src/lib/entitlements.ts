import type { EntitlementCapability, EntitlementsSnapshot, FeatureId } from './backend'

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
      featureId: 'multistreaming',
      state: 'disabled',
      reason: 'Multistreaming requires Videorc Premium. Basic can stream to one destination at HD.'
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
    streaming: {
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 30,
      maxBitrateKbps: 6000,
      maxDestinations: 1
    }
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
