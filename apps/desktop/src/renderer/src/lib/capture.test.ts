import { describe, expect, it } from 'vitest'

import type { SourceSelection } from '../../../shared/backend'
import type { CaptureConfig } from './capture'
import {
  applyStoredManualStreamKeyResult,
  defaultCaptureConfig,
  legacyStreamKeyMigrationCandidates,
  normalizeAudioSettings,
  normalizeMicrophoneSyncOffsetMs,
  normalizeVideoSettings,
  parseMicrophoneSyncOffsetInput,
  persistableCaptureConfig,
  reconcileSourceSelection,
  smokePreviewCompositorCaptureConfig,
  sourceSelectionChangeMessages,
  videoProfileCompatibility,
  videoPresets
} from './capture'

function captureConfigFixture(): CaptureConfig {
  return {
    ...defaultCaptureConfig,
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) => ({ ...target }))
    }
  }
}

describe('reconcileSourceSelection', () => {
  // The renderer mounts with an empty deviceList placeholder and the
  // reconcile effect fires before the backend's first devices.list answer.
  // Remembered selections must survive that pre-snapshot tick: clearing them
  // toasts 'Capture source "…" is unavailable, so it was cleared.' for
  // devices that are actually present (startup-toast bug, 2026-06-13).
  it('leaves remembered selections untouched before the first device snapshot', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:1',
      screenName: 'Display 1',
      cameraId: 'camera:1',
      cameraName: 'FaceTime HD Camera',
      microphoneId: 'microphone:1',
      microphoneName: 'MacBook Pro Microphone'
    }

    const next = reconcileSourceSelection(remembered, [])

    expect(next).toEqual(remembered)
    expect(sourceSelectionChangeMessages(remembered, next)).toEqual([])
  })
})

describe('smokePreviewCompositorCaptureConfig', () => {
  it('uses a renderable test-pattern source instead of stopped real preview sources', () => {
    const config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'> = {
      sources: {
        screenId: 'screen:1',
        screenName: 'Display',
        windowId: 'window:1',
        windowName: 'App',
        cameraId: 'camera:1',
        cameraName: 'Camera',
        microphoneId: 'microphone:1',
        microphoneName: 'Microphone'
      },
      layout: {
        layoutPreset: 'screen-camera',
        cameraTransformMode: 'preset',
        cameraTransform: null,
        cameraCorner: 'bottom-right',
        cameraSize: 'medium',
        cameraShape: 'rectangle',
        cameraMargin: 32,
        cameraFit: 'fill',
        cameraMirror: false,
        cameraZoom: 100,
        cameraOffsetX: 0,
        cameraOffsetY: 0,
        sideBySideSplit: '70-30',
        sideBySideCameraSide: 'right'
      },
      video: {
        preset: 'tutorial-1440p30',
        width: 2560,
        height: 1440,
        fps: 30,
        bitrateKbps: 8000
      }
    }

    expect(smokePreviewCompositorCaptureConfig(config)).toEqual({
      ...config,
      sources: {
        microphoneId: 'microphone:1',
        microphoneName: 'Microphone',
        testPattern: true
      }
    })
  })
})

describe('normalizeMicrophoneSyncOffsetMs', () => {
  it('preserves exact measured millisecond offsets when the user has set one', () => {
    expect(normalizeMicrophoneSyncOffsetMs(-166)).toBe(-166)
    expect(
      normalizeAudioSettings({ microphoneSyncOffsetMs: -166, microphoneSyncOffsetUserSet: true })
        .microphoneSyncOffsetMs
    ).toBe(-166)
  })

  it('applies the structural default (0) until the user sets an offset', () => {
    // Alignment happens in the backend via the video epoch; this offset is a pure
    // manual trim. Stored non-user-set values (e.g. the old -750 calibration)
    // migrate back to 0 on load.
    expect(normalizeAudioSettings({ microphoneSyncOffsetMs: -750 }).microphoneSyncOffsetMs).toBe(0)
    expect(normalizeAudioSettings({}).microphoneSyncOffsetMs).toBe(0)
  })

  it('clamps to the backend-supported range', () => {
    expect(normalizeMicrophoneSyncOffsetMs(-1200)).toBe(-1000)
    expect(normalizeMicrophoneSyncOffsetMs(1200)).toBe(1000)
  })

  it('uses the provided fallback when the value is not numeric', () => {
    expect(normalizeMicrophoneSyncOffsetMs('nope', -120)).toBe(-120)
  })
})

describe('parseMicrophoneSyncOffsetInput', () => {
  it('keeps transient number-input drafts out of committed state', () => {
    expect(parseMicrophoneSyncOffsetInput('', -750)).toBeNull()
    expect(parseMicrophoneSyncOffsetInput('-', -750)).toBeNull()
    expect(parseMicrophoneSyncOffsetInput('+', -750)).toBeNull()
    expect(parseMicrophoneSyncOffsetInput('nope', -750)).toBeNull()
  })

  it('parses and clamps valid millisecond drafts', () => {
    expect(parseMicrophoneSyncOffsetInput('-735', -750)).toBe(-735)
    expect(parseMicrophoneSyncOffsetInput('1200', -750)).toBe(1000)
    expect(parseMicrophoneSyncOffsetInput('-1200', -750)).toBe(-1000)
  })
})

describe('videoPresets', () => {
  it('includes first-class 4K recording and platform-safe streaming presets', () => {
    expect(videoPresets['record-4k30']).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 30,
      bitrateKbps: 30000
    })
    expect(videoPresets['record-4k60-experimental']).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 60,
      bitrateKbps: 50000
    })
    expect(videoPresets['stream-safe-1080p30']).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6000
    })
    expect(videoPresets['stream-safe-1080p60']).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 60,
      bitrateKbps: 6000
    })
  })

  it('normalizes persisted first-class presets through the shared map', () => {
    expect(normalizeVideoSettings({ preset: 'record-4k30' })).toEqual(videoPresets['record-4k30'])
    expect(normalizeVideoSettings({ preset: 'stream-safe-1080p30' })).toEqual(
      videoPresets['stream-safe-1080p30']
    )
  })
})

describe('videoProfileCompatibility', () => {
  it('blocks 4K livestreaming in the v1 shared-output UI path', () => {
    const result = videoProfileCompatibility({
      recordEnabled: true,
      streamEnabled: true,
      video: videoPresets['record-4k30']
    })

    expect(result.blockingReason).toContain('4K livestreaming is not available')
  })

  it('blocks livestream bitrates above the platform-safe budget', () => {
    const result = videoProfileCompatibility({
      recordEnabled: false,
      streamEnabled: true,
      video: videoPresets['stream-1080p60']
    })

    expect(result.blockingReason).toContain('6000 kbps or lower')
  })

  it('allows stream-safe profiles and warns for experimental 4K60 recording', () => {
    expect(
      videoProfileCompatibility({
        recordEnabled: false,
        streamEnabled: true,
        video: videoPresets['stream-safe-1080p30']
      }).blockingReason
    ).toBeNull()

    expect(
      videoProfileCompatibility({
        recordEnabled: true,
        streamEnabled: false,
        video: videoPresets['record-4k60-experimental']
      }).warning
    ).toContain('experimental')
  })
})

describe('legacy stream key migration', () => {
  it('detects legacy top-level stream keys that need backend storage', () => {
    const config = captureConfigFixture()
    config.rtmpPreset = 'twitch'
    config.streamKey = ' fixture-top-level-key '

    expect(legacyStreamKeyMigrationCandidates(config)).toEqual([
      { targetId: 'twitch', streamKey: 'fixture-top-level-key' }
    ])
  })

  it('detects per-target plaintext keys that do not already have secret refs', () => {
    const config = captureConfigFixture()
    config.streaming.targets = config.streaming.targets.map((target) =>
      target.id === 'youtube'
        ? { ...target, streamKey: ' fixture-youtube-key ', streamKeyPresent: true }
        : target
    )

    expect(legacyStreamKeyMigrationCandidates(config)).toEqual([
      { targetId: 'youtube', streamKey: 'fixture-youtube-key' }
    ])
  })

  it('clears plaintext keys from persisted config after backend store succeeds', () => {
    const config = captureConfigFixture()
    config.rtmpPreset = 'youtube'
    config.streamKey = 'fixture-legacy-key'
    config.streaming.enabled = true
    config.streaming.targets = config.streaming.targets.map((target) =>
      target.id === 'youtube'
        ? {
            ...target,
            enabled: true,
            streamKey: 'fixture-legacy-key',
            streamKeyPresent: true
          }
        : target
    )

    const migrated = applyStoredManualStreamKeyResult(config, 'youtube', {
      streamKeySecretRef: 'stream-target:youtube:manual-stream-key',
      streamKeyPresent: true,
      streamKeyHint: '****-key',
      previousStreamKeyPresent: false
    })
    const persisted = persistableCaptureConfig(migrated)
    const youtube = persisted.streaming.targets.find((target) => target.id === 'youtube')

    expect(migrated.streamKey).toBe('')
    expect(youtube?.streamKey).toBe('')
    expect(persisted.streamKey).toBe('')
    expect(JSON.stringify(persisted)).not.toContain('fixture-legacy-key')
  })
})
