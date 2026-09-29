import { describe, expect, it } from 'vitest'

import { defaultCaptureConfig, legacyStreamKeyMigrationCandidates } from '@/lib/capture'
import { mergeObsImportIntoConfig } from './obs-import-apply'
import type { ObsImportPlanResult } from './obs-import-map'

// O3 (OBS import plan): the merge is atomic and additive — untouched config
// survives, the plan's fields land, and the raw stream key follows the exact
// user-typed-key path (raw in memory, secret ref on persist).
function plan(overrides: Partial<ObsImportPlanResult> = {}): ObsImportPlanResult {
  return {
    sources: { cameraId: 'camera:mbp', cameraName: 'MacBook Pro Camera' },
    layout: {
      layoutPreset: 'screen-camera',
      cameraTransformMode: 'custom',
      cameraTransform: { x: 0.75, y: 0.75, width: 0.25, height: 0.25 },
      cameraAspect: 'portrait'
    },
    video: { width: 3840, height: 2160, fps: 24 },
    audio: { microphoneGainDb: -6, microphoneMuted: true },
    report: [],
    ...overrides
  }
}

describe('mergeObsImportIntoConfig', () => {
  it('applies sources, layout, video, and audio without touching the rest', () => {
    const base = defaultCaptureConfig
    const next = mergeObsImportIntoConfig(base, plan(), null, '2026-07-07T00:00:00Z')
    expect(next.sources.cameraId).toBe('camera:mbp')
    expect(next.sources.testPattern).toBe(false)
    expect(next.layout.layoutPreset).toBe('screen-camera')
    expect(next.layout.cameraTransform).toMatchObject({ x: 0.75 })
    expect(next.layout.cameraAspect).toBe('portrait')
    expect(next.video).toMatchObject({ width: 3840, height: 2160, fps: 24 })
    expect(next.audio.microphoneGainDb).toBe(-6)
    expect(next.audio.microphoneMuted).toBe(true)
    // untouched settings survive
    expect(next.captions).toEqual(base.captions)
    expect(next.recordEnabled).toBe(base.recordEnabled)
  })

  it('lands an imported System audio switch in captureConfig.audio (plan 069)', () => {
    const on = mergeObsImportIntoConfig(
      defaultCaptureConfig,
      plan({ audio: { systemAudioEnabled: true } }),
      null
    )
    expect(on.audio.systemAudioEnabled).toBe(true)
    expect(on.audio.systemAudioGainDb).toBe(defaultCaptureConfig.audio.systemAudioGainDb)
    // A plan without desktop audio leaves the user's own choice alone.
    const kept = mergeObsImportIntoConfig(
      {
        ...defaultCaptureConfig,
        audio: { ...defaultCaptureConfig.audio, systemAudioEnabled: true }
      },
      plan(),
      null
    )
    expect(kept.audio.systemAudioEnabled).toBe(true)
  })

  it('keeps preset camera mode when the plan carries no custom transform', () => {
    const next = mergeObsImportIntoConfig(
      defaultCaptureConfig,
      plan({ layout: { layoutPreset: 'screen-only' } }),
      null
    )
    expect(next.layout.layoutPreset).toBe('screen-only')
    expect(next.layout.cameraTransformMode).toBe(defaultCaptureConfig.layout.cameraTransformMode)
  })

  it('imports an rtmp_custom target the same way a typed key lands', () => {
    const next = mergeObsImportIntoConfig(
      defaultCaptureConfig,
      plan({ stream: { kind: 'rtmp-custom', serverUrl: 'rtmp://my.server/live', hasKey: true } }),
      'raw-key-from-obs',
      '2026-07-07T00:00:00Z'
    )
    const custom = next.streaming.targets.find((target) => target.platform === 'custom')
    expect(custom).toMatchObject({
      enabled: true,
      serverUrl: 'rtmp://my.server/live',
      streamKey: 'raw-key-from-obs',
      streamKeyPresent: true,
      authMode: 'manual-rtmp'
    })
    expect(next.streaming.enabledTargetIds).toContain('custom')
    // The raw key lands in the exact shape the legacy-key migration converts
    // to a backend secret ref on the next connected tick — the same journey a
    // user-typed key takes (streaming-secrets law).
    const candidates = legacyStreamKeyMigrationCandidates(next)
    expect(candidates).toContainEqual({ targetId: 'custom', streamKey: 'raw-key-from-obs' })
  })

  it('oauth-suggest plans change no stream targets', () => {
    const next = mergeObsImportIntoConfig(
      defaultCaptureConfig,
      plan({ stream: { kind: 'oauth-suggest', platform: 'twitch', serviceLabel: 'Twitch' } }),
      null
    )
    expect(next.streaming).toEqual(defaultCaptureConfig.streaming)
  })

  it('imports YouTube common RTMP services into the YouTube Manual RTMP target', () => {
    const next = mergeObsImportIntoConfig(
      defaultCaptureConfig,
      plan({
        stream: {
          kind: 'rtmp-platform',
          platform: 'youtube',
          serviceLabel: 'YouTube - RTMPS',
          serverUrl: 'rtmps://a.rtmp.youtube.com/live2',
          hasKey: true
        }
      }),
      'youtube-key-from-obs',
      '2026-07-08T00:00:00.000Z'
    )
    const youtube = next.streaming.targets.find((target) => target.platform === 'youtube')
    expect(youtube).toMatchObject({
      enabled: true,
      serverUrl: 'rtmps://a.rtmp.youtube.com/live2',
      streamKey: 'youtube-key-from-obs',
      streamKeyPresent: true,
      authMode: 'manual-rtmp',
      updatedAt: '2026-07-08T00:00:00.000Z'
    })
    expect(next.streaming.enabledTargetIds).toContain('youtube')
  })
})

it('merges an imported Facebook key into its own card and secret migration', () => {
  const next = mergeObsImportIntoConfig(
    defaultCaptureConfig,
    plan({
      stream: {
        kind: 'rtmp-platform',
        platform: 'facebook',
        serviceLabel: 'Facebook Live',
        serverUrl: 'rtmps://rtmp-api.facebook.com:443/rtmp/',
        hasKey: true
      }
    }),
    'facebook-import-key'
  )
  expect(next.streaming.targets.find((target) => target.id === 'facebook')).toMatchObject({
    platform: 'facebook',
    enabled: true,
    authMode: 'manual-rtmp',
    outputOrientation: 'horizontal',
    streamKey: 'facebook-import-key'
  })
  expect(legacyStreamKeyMigrationCandidates(next)).toContainEqual({
    targetId: 'facebook',
    streamKey: 'facebook-import-key'
  })
})
