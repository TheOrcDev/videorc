import { describe, expect, it } from 'vitest'

import type { EntitlementsSnapshot } from './backend'
import {
  BASIC_STREAMING_LIMITS,
  DEFAULT_BASIC_ENTITLEMENTS,
  PREMIUM_STREAMING_LIMITS,
  STREAMING_MAX_DESTINATIONS,
  entitlementCapability,
  entitlementDisabledReason,
  isFeatureEntitled
} from './entitlements'

const developerEntitlements: EntitlementsSnapshot = {
  schemaVersion: 1,
  tier: 'developer',
  source: 'env-override',
  capabilities: [
    {
      featureId: 'local-recording',
      state: 'enabled'
    },
    {
      featureId: 'livestreaming',
      state: 'developer-override',
      reason: 'Enabled by Videorc debug/dev backend build.'
    },
    {
      featureId: 'multistreaming',
      state: 'developer-override',
      reason: 'Enabled by Videorc debug/dev backend build.'
    },
    {
      featureId: 'cloud-ai',
      state: 'developer-override',
      reason: 'Enabled by Videorc debug/dev backend build.'
    },
    {
      featureId: 'noise-cleanup',
      state: 'developer-override',
      reason: 'Enabled by Videorc debug/dev backend build.'
    },
    {
      featureId: 'live-cohost',
      state: 'developer-override',
      reason: 'Enabled by Videorc debug/dev backend build.'
    }
  ],
  limits: {
    recording: {
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 30
    },
    streaming: {
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 60,
      maxBitrateKbps: 30000,
      maxDestinations: 3
    }
  }
}

describe('entitlements', () => {
  it('keeps local recording enabled when the backend snapshot has not loaded yet', () => {
    expect(isFeatureEntitled(null, 'local-recording')).toBe(true)
    expect(entitlementDisabledReason(null, 'local-recording')).toBeNull()
  })

  it('treats Basic fallback as full-quality 4K recording plus free HD multistreaming', () => {
    expect(isFeatureEntitled(null, 'livestreaming')).toBe(true)
    expect(entitlementDisabledReason(null, 'livestreaming')).toBeNull()
    // Multistreaming is free for every plan; a missing snapshot must never
    // lock it (the fallback stays fail-closed only for Premium features).
    expect(isFeatureEntitled(null, 'multistreaming')).toBe(true)
    expect(entitlementDisabledReason(null, 'multistreaming')).toBeNull()
    expect(isFeatureEntitled(null, 'cloud-ai')).toBe(false)
    expect(entitlementDisabledReason(null, 'cloud-ai')).toContain('Premium')
    expect(isFeatureEntitled(null, 'live-cohost')).toBe(false)
    expect(entitlementDisabledReason(null, 'live-cohost')).toContain('Premium')
    expect(isFeatureEntitled(null, 'noise-cleanup')).toBe(false)
    expect(entitlementDisabledReason(null, 'noise-cleanup')).toBe(
      'Noise Cleanup requires Videorc Premium.'
    )
    // Recording is free at full quality — the website promises free 4K
    // local recording; only streaming quality is tiered.
    expect(DEFAULT_BASIC_ENTITLEMENTS.limits.recording).toMatchObject({
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 60
    })
    expect(STREAMING_MAX_DESTINATIONS).toBe(5)
    expect(DEFAULT_BASIC_ENTITLEMENTS.limits.streaming).toMatchObject({
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 30,
      maxBitrateKbps: 6000,
      maxDestinations: STREAMING_MAX_DESTINATIONS
    })
    expect(DEFAULT_BASIC_ENTITLEMENTS.limits.streaming).toEqual(BASIC_STREAMING_LIMITS)
    expect(PREMIUM_STREAMING_LIMITS).toEqual({
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 60,
      maxBitrateKbps: 30000,
      maxDestinations: STREAMING_MAX_DESTINATIONS
    })
    // One shared cap: the destination count is not a Premium boundary.
    expect(PREMIUM_STREAMING_LIMITS.maxDestinations).toBe(BASIC_STREAMING_LIMITS.maxDestinations)
  })

  it('treats developer override state as entitled', () => {
    expect(isFeatureEntitled(developerEntitlements, 'livestreaming')).toBe(true)
    expect(isFeatureEntitled(developerEntitlements, 'multistreaming')).toBe(true)
    expect(isFeatureEntitled(developerEntitlements, 'cloud-ai')).toBe(true)
    expect(isFeatureEntitled(developerEntitlements, 'noise-cleanup')).toBe(true)
    expect(entitlementDisabledReason(developerEntitlements, 'cloud-ai')).toBeNull()
    expect(developerEntitlements.limits.streaming.maxFps).toBe(60)
  })

  it('returns a disabled fallback for a missing capability', () => {
    const snapshot: EntitlementsSnapshot = {
      schemaVersion: 1,
      tier: 'basic',
      source: 'local-default',
      capabilities: [],
      limits: {
        recording: {
          maxWidth: 1920,
          maxHeight: 1080,
          maxFps: 30
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

    // Premium features fall back closed; free ones (multistreaming) fall
    // back open, so a thin snapshot can never lock a free feature.
    expect(entitlementCapability(snapshot, 'cloud-ai')).toMatchObject({
      featureId: 'cloud-ai',
      state: 'disabled'
    })
    expect(entitlementCapability(snapshot, 'multistreaming')).toMatchObject({
      featureId: 'multistreaming',
      state: 'enabled'
    })
  })
})
