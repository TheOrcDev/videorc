import { describe, expect, it } from 'vitest'

import type { EntitlementsSnapshot, VideoSettings } from './backend'
import {
  cloudAiUploadGate,
  goLiveEntitlementGate,
  noiseCleanupGate,
  streamingDestinationEnableGate,
  videoProfileEntitlementGate
} from './entitlement-ui'
import {
  DEFAULT_BASIC_ENTITLEMENTS,
  PREMIUM_STREAMING_LIMITS,
  STREAMING_MAX_DESTINATIONS
} from './entitlements'
import { VIDEORC_PREMIUM_URL } from './premium-upgrade'

const basicEntitlements = DEFAULT_BASIC_ENTITLEMENTS

const premiumEntitlements: EntitlementsSnapshot = {
  schemaVersion: 1,
  tier: 'premium',
  source: 'creem',
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
      state: 'enabled'
    },
    {
      featureId: 'cloud-ai',
      state: 'enabled'
    },
    {
      featureId: 'noise-cleanup',
      state: 'enabled'
    }
  ],
  limits: {
    recording: {
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 60,
      maxBitrateKbps: 50000
    },
    streaming: PREMIUM_STREAMING_LIMITS
  }
}

const developerEntitlements: EntitlementsSnapshot = {
  ...premiumEntitlements,
  tier: 'developer',
  source: 'env-override',
  capabilities: premiumEntitlements.capabilities.map((capability) => ({
    ...capability,
    state: 'developer-override' as const,
    reason: 'Enabled by Videorc debug/dev backend build.'
  }))
}

function destinationGate(
  enabledTargetIds: string[],
  targetId: string,
  entitlements: EntitlementsSnapshot | null = basicEntitlements
) {
  return streamingDestinationEnableGate({
    entitlements,
    streaming: { enabledTargetIds },
    targetId
  })
}

// Multistreaming is free for every plan: the destination cap is a shared
// pipeline limit, so the over-cap reason is neutral (no "Premium", hence no
// upgrade URL) and identical across tiers.
const CAP = STREAMING_MAX_DESTINATIONS
const capReason = `You can stream to up to ${CAP} destinations at once.`
const fiveTargets = ['youtube', 'twitch', 'x', 'custom-a', 'custom-b']

describe('entitlement UI gates', () => {
  it('allows Basic users to enable any first streaming destination', () => {
    for (const targetId of ['youtube', 'twitch', 'x', 'custom']) {
      expect(destinationGate([], targetId)).toEqual({ allowed: true })
    }
  })

  it('treats missing entitlement snapshots as Basic, which still multistreams', () => {
    expect(destinationGate([], 'youtube', null)).toEqual({ allowed: true })
    expect(destinationGate(['youtube'], 'twitch', null)).toEqual({ allowed: true })
    expect(destinationGate(fiveTargets, 'custom-c', null)).toEqual({
      allowed: false,
      featureId: 'multistreaming',
      reason: capReason
    })
  })

  it(`allows anyone to enable up to ${CAP} destinations`, () => {
    expect(CAP).toBe(5)
    for (const entitlements of [basicEntitlements, premiumEntitlements, developerEntitlements]) {
      for (let enabled = 0; enabled < CAP; enabled += 1) {
        expect(
          destinationGate(fiveTargets.slice(0, enabled), fiveTargets[enabled], entitlements)
        ).toEqual({ allowed: true })
      }
    }
  })

  it(`blocks the sixth destination for every tier with a neutral reason and no upgradeUrl`, () => {
    for (const entitlements of [basicEntitlements, premiumEntitlements, developerEntitlements]) {
      const gate = destinationGate(fiveTargets, 'custom-c', entitlements)
      expect(gate).toEqual({
        allowed: false,
        featureId: 'multistreaming',
        reason: capReason
      })
      expect(gate).not.toHaveProperty('upgradeUrl')
      expect(capReason).not.toMatch(/premium/i)
    }
  })

  it('keeps stale over-limit destinations fixable', () => {
    const sixTargets = [...fiveTargets, 'custom-c']
    for (const targetId of sixTargets) {
      expect(destinationGate(sixTargets, targetId)).toEqual({ allowed: true })
    }
    expect(destinationGate(sixTargets, 'custom-d')).toEqual({
      allowed: false,
      featureId: 'multistreaming',
      reason: capReason
    })

    for (const entitlements of [basicEntitlements, premiumEntitlements]) {
      expect(
        goLiveEntitlementGate({
          entitlements,
          streaming: { enabledTargetIds: sixTargets }
        })
      ).toEqual({
        allowed: false,
        featureId: 'multistreaming',
        reason: capReason,
        allowFixAction: true
      })
    }
  })

  it('gives Premium snapshots the same destination cap as Basic', () => {
    expect(premiumEntitlements.limits.streaming.maxDestinations).toBe(
      basicEntitlements.limits.streaming.maxDestinations
    )
    expect(destinationGate(['youtube', 'twitch'], 'x', premiumEntitlements)).toEqual({
      allowed: true
    })
    expect(destinationGate(['youtube', 'twitch'], 'x', basicEntitlements)).toEqual({
      allowed: true
    })
  })

  it('preserves developer entitlement behavior from env overrides', () => {
    expect(destinationGate(['youtube', 'twitch'], 'x', developerEntitlements)).toEqual({
      allowed: true
    })
    expect(cloudAiUploadGate(developerEntitlements)).toEqual({ allowed: true })
    expect(noiseCleanupGate(developerEntitlements)).toEqual({ allowed: true })
  })

  it('allows Go Live up to the shared cap for every tier and blocks over-limit configs before preflight', () => {
    for (const entitlements of [basicEntitlements, premiumEntitlements, developerEntitlements]) {
      expect(
        goLiveEntitlementGate({
          entitlements,
          streaming: { enabledTargetIds: ['youtube'] }
        })
      ).toEqual({ allowed: true })
      expect(
        goLiveEntitlementGate({
          entitlements,
          streaming: { enabledTargetIds: fiveTargets }
        })
      ).toEqual({ allowed: true })
      expect(
        goLiveEntitlementGate({
          entitlements,
          streaming: { enabledTargetIds: [...fiveTargets, 'custom-c'] }
        })
      ).toMatchObject({ allowed: false, featureId: 'multistreaming', allowFixAction: true })
    }
  })

  it('adds Premium upgrade metadata for Cloud AI and Basic media caps', () => {
    expect(cloudAiUploadGate(basicEntitlements)).toEqual({
      allowed: false,
      featureId: 'cloud-ai',
      reason: 'Cloud AI is a Videorc Premium feature.',
      upgradeUrl: VIDEORC_PREMIUM_URL
    })

    const youtube4k: VideoSettings = {
      preset: 'stream-youtube-4k30',
      width: 3840,
      height: 2160,
      fps: 30,
      bitrateKbps: 30000
    }

    expect(
      videoProfileEntitlementGate({
        entitlements: basicEntitlements,
        kind: 'streaming',
        video: youtube4k
      })
    ).toMatchObject({
      allowed: false,
      featureId: 'livestreaming',
      upgradeUrl: VIDEORC_PREMIUM_URL,
      allowFixAction: true
    })

    expect(
      videoProfileEntitlementGate({
        entitlements: premiumEntitlements,
        kind: 'streaming',
        video: youtube4k
      })
    ).toEqual({ allowed: true })
  })

  it('gates exact higher-rate YouTube 1080p profiles by tier', () => {
    const youtubeProfiles: VideoSettings[] = [
      {
        preset: 'stream-youtube-1080p30',
        width: 1920,
        height: 1080,
        fps: 30,
        bitrateKbps: 10000
      },
      {
        preset: 'stream-youtube-1080p60',
        width: 1920,
        height: 1080,
        fps: 60,
        bitrateKbps: 12000
      }
    ]

    for (const video of youtubeProfiles) {
      expect(
        videoProfileEntitlementGate({
          entitlements: basicEntitlements,
          kind: 'streaming',
          video
        })
      ).toMatchObject({
        allowed: false,
        featureId: 'livestreaming',
        upgradeUrl: VIDEORC_PREMIUM_URL
      })
      expect(
        videoProfileEntitlementGate({
          entitlements: premiumEntitlements,
          kind: 'streaming',
          video
        })
      ).toEqual({ allowed: true })
      expect(
        videoProfileEntitlementGate({
          entitlements: developerEntitlements,
          kind: 'streaming',
          video
        })
      ).toEqual({ allowed: true })
    }
  })

  it('rejects unsupported 4K60 streaming even when the tier ceiling allows it', () => {
    const unsupported4k60: VideoSettings = {
      preset: 'custom',
      width: 3840,
      height: 2160,
      fps: 60,
      bitrateKbps: 30000
    }

    for (const entitlements of [premiumEntitlements, developerEntitlements]) {
      expect(
        videoProfileEntitlementGate({
          entitlements,
          kind: 'streaming',
          video: unsupported4k60
        })
      ).toMatchObject({
        allowed: false,
        featureId: 'livestreaming',
        reason: expect.stringContaining('exact YouTube 4K30 profile')
      })
    }
  })

  it('fails closed for Noise Cleanup and links Basic users to Premium', () => {
    expect(noiseCleanupGate(null)).toEqual({
      allowed: false,
      featureId: 'noise-cleanup',
      reason: 'Noise Cleanup requires Videorc Premium.',
      upgradeUrl: VIDEORC_PREMIUM_URL
    })
    expect(noiseCleanupGate(basicEntitlements)).toEqual(noiseCleanupGate(null))
    expect(noiseCleanupGate(premiumEntitlements)).toEqual({ allowed: true })
  })

  it('allows every recording preset on Basic — recording is not premium-gated', () => {
    // Regression (2026-07-06): the website promises free 4K local recording;
    // Basic used to cap recording at 1080p, contradicting it.
    const recordingPresets: VideoSettings[] = [
      { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
      { preset: 'record-4k30', width: 3840, height: 2160, fps: 30, bitrateKbps: 30000 },
      {
        preset: 'record-4k60-experimental',
        width: 3840,
        height: 2160,
        fps: 60,
        bitrateKbps: 50000
      }
    ]

    for (const video of recordingPresets) {
      expect(
        videoProfileEntitlementGate({ entitlements: basicEntitlements, kind: 'recording', video })
      ).toEqual({ allowed: true })
    }
  })

  it('still locks recording profiles beyond the shared cap', () => {
    const eightK: VideoSettings = {
      preset: 'custom',
      width: 7680,
      height: 4320,
      fps: 30,
      bitrateKbps: 80000
    }

    expect(
      videoProfileEntitlementGate({
        entitlements: basicEntitlements,
        kind: 'recording',
        video: eightK
      })
    ).toMatchObject({
      allowed: false,
      featureId: 'local-recording'
    })
  })

  it('keeps premium toasts as fallbacks by linking normal locked controls', () => {
    const premiumStreamingProfile: VideoSettings = {
      preset: 'stream-youtube-4k30',
      width: 3840,
      height: 2160,
      fps: 30,
      bitrateKbps: 30000
    }
    const normalLockedGates = [
      cloudAiUploadGate(basicEntitlements),
      noiseCleanupGate(basicEntitlements),
      videoProfileEntitlementGate({
        entitlements: basicEntitlements,
        kind: 'streaming',
        video: premiumStreamingProfile
      })
    ]

    for (const gate of normalLockedGates) {
      expect(gate).toMatchObject({
        allowed: false,
        upgradeUrl: VIDEORC_PREMIUM_URL
      })
    }
  })
})
