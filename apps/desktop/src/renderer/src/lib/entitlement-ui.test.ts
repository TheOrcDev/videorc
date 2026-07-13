import { describe, expect, it } from 'vitest'

import type { EntitlementsSnapshot, VideoSettings } from './backend'
import {
  cloudAiUploadGate,
  goLiveEntitlementGate,
  noiseCleanupGate,
  streamingDestinationEnableGate,
  videoProfileEntitlementGate
} from './entitlement-ui'
import { DEFAULT_BASIC_ENTITLEMENTS } from './entitlements'
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
    streaming: {
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 30,
      maxBitrateKbps: 30000,
      maxDestinations: 3
    }
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

describe('entitlement UI gates', () => {
  it('allows Basic users to enable any first streaming destination', () => {
    for (const targetId of ['youtube', 'twitch', 'x', 'custom']) {
      expect(destinationGate([], targetId)).toEqual({ allowed: true })
    }
  })

  it('treats missing entitlement snapshots as Basic', () => {
    expect(destinationGate([], 'youtube', null)).toEqual({ allowed: true })
    expect(destinationGate(['youtube'], 'twitch', null)).toMatchObject({
      allowed: false,
      featureId: 'multistreaming',
      upgradeUrl: VIDEORC_PREMIUM_URL
    })
  })

  it('lets Basic users disable the active destination but blocks additional destinations', () => {
    expect(destinationGate(['youtube'], 'youtube')).toEqual({ allowed: true })

    for (const targetId of ['twitch', 'x', 'custom']) {
      expect(destinationGate(['youtube'], targetId)).toEqual({
        allowed: false,
        featureId: 'multistreaming',
        reason:
          'Multistreaming requires Videorc Premium. Basic can stream to one destination at HD.',
        upgradeUrl: VIDEORC_PREMIUM_URL
      })
    }
  })

  it('keeps stale over-limit Basic destinations fixable', () => {
    expect(destinationGate(['youtube', 'twitch'], 'youtube')).toEqual({ allowed: true })
    expect(destinationGate(['youtube', 'twitch'], 'twitch')).toEqual({ allowed: true })
    expect(destinationGate(['youtube', 'twitch'], 'x')).toMatchObject({
      allowed: false,
      featureId: 'multistreaming',
      upgradeUrl: VIDEORC_PREMIUM_URL
    })

    expect(
      goLiveEntitlementGate({
        entitlements: basicEntitlements,
        streaming: { enabledTargetIds: ['youtube', 'twitch'] }
      })
    ).toEqual({
      allowed: false,
      featureId: 'multistreaming',
      reason: 'Multistreaming requires Videorc Premium. Basic can stream to one destination at HD.',
      upgradeUrl: VIDEORC_PREMIUM_URL,
      allowFixAction: true
    })
  })

  it('uses Premium max destination limits instead of hardcoding one destination', () => {
    expect(destinationGate(['youtube', 'twitch'], 'x', premiumEntitlements)).toEqual({
      allowed: true
    })
    expect(destinationGate(['youtube', 'twitch', 'x'], 'custom', premiumEntitlements)).toEqual({
      allowed: false,
      featureId: 'multistreaming',
      reason: 'Your current plan allows up to 3 streaming destinations.'
    })
  })

  it('preserves developer entitlement behavior from env overrides', () => {
    expect(destinationGate(['youtube', 'twitch'], 'x', developerEntitlements)).toEqual({
      allowed: true
    })
    expect(cloudAiUploadGate(developerEntitlements)).toEqual({ allowed: true })
    expect(noiseCleanupGate(developerEntitlements)).toEqual({ allowed: true })
  })

  it('allows Basic Go Live with one destination and blocks over-limit configs before preflight', () => {
    expect(
      goLiveEntitlementGate({
        entitlements: basicEntitlements,
        streaming: { enabledTargetIds: ['youtube'] }
      })
    ).toEqual({ allowed: true })

    expect(
      goLiveEntitlementGate({
        entitlements: premiumEntitlements,
        streaming: { enabledTargetIds: ['youtube', 'twitch', 'x'] }
      })
    ).toEqual({ allowed: true })
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
      destinationGate(['youtube'], 'twitch'),
      goLiveEntitlementGate({
        entitlements: basicEntitlements,
        streaming: { enabledTargetIds: ['youtube', 'twitch'] }
      }),
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
