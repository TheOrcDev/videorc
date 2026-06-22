import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Device, SourceSelection } from '../../../shared/backend'
import type { CaptureConfig } from './capture'
import {
  applyAudioSyncRecommendation,
  audioSyncCalibrationState,
  applyStoredManualStreamKeyResult,
  capturePickerDevices,
  defaultCaptureConfig,
  formatMeasuredAudioLag,
  legacyStreamKeyMigrationCandidates,
  hasSelectedCameraSource,
  hasSelectedScreenSource,
  isCapturePickerDevice,
  isNativeCaptureDevice,
  isScreenCaptureKitCaptureDevice,
  isSelectableCaptureDevice,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  loadCaptureConfig,
  normalizeAudioSettings,
  normalizeMicrophoneSyncOffsetMs,
  normalizeVideoSettings,
  parseAudioSyncRecommendationJson,
  parseMicrophoneSyncOffsetInput,
  persistableCaptureConfig,
  reconcileSourceSelection,
  resetAudioSyncCalibration,
  smokePreviewCompositorCaptureConfig,
  streamOutputVideoForTarget,
  sourceSelectionChangeMessages,
  streamOutputVideoSettings,
  streamOutputVideosForTargets,
  videoProfileCompatibility,
  videoPresets
} from './capture'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('migrates remembered avfoundation screen sources to native screen sources', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:screencapturekit:222',
        name: 'Display 2',
        kind: 'screen',
        status: 'available'
      },
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBe('screen:screencapturekit:222')
    expect(next.screenName).toBe('Display 2')
    expect(next.windowId).toBeUndefined()
  })

  it('keeps a legacy avfoundation screen source as a recording fallback when no native capture source is available', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBe('screen:avfoundation:7')
    expect(next.screenName).toBe('Capture screen 1')
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
    expect(sourceSelectionChangeMessages(remembered, next)).toEqual([])
  })

  it('does not select the avfoundation screen fallback while ScreenCaptureKit reports status rows', () => {
    const next = reconcileSourceSelection({}, [
      {
        id: 'screen:screencapturekit-timeout',
        name: 'Primary Display',
        kind: 'screen',
        status: 'unavailable'
      },
      {
        id: 'window:screencapturekit-missing',
        name: 'Window Capture',
        kind: 'window',
        status: 'unavailable'
      },
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'available'
      }
    ])

    expect(next.screenId).toBeUndefined()
    expect(next.screenName).toBeUndefined()
  })

  it('does not select permission placeholders as renderable capture sources', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:screencapturekit-permission',
        name: 'Primary Display',
        kind: 'screen',
        status: 'permission-required'
      },
      {
        id: 'window:screencapturekit-permission',
        name: 'Window Capture',
        kind: 'window',
        status: 'permission-required'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBeUndefined()
    expect(next.screenName).toBeUndefined()
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
  })

  it('does not select avfoundation screen fallback while screen capture permission is blocked', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:screencapturekit-permission',
        name: 'Primary Display',
        kind: 'screen',
        status: 'permission-required'
      },
      {
        id: 'window:screencapturekit-permission',
        name: 'Window Capture',
        kind: 'window',
        status: 'permission-required'
      },
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'permission-required'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBeUndefined()
    expect(next.screenName).toBeUndefined()
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
  })
})

describe('ScreenCaptureKit capture device filtering', () => {
  it('shows native status rows in the source picker but does not treat them as selectable native sources', () => {
    const permissionDisplay: Device = {
      id: 'screen:screencapturekit-permission',
      name: 'Primary Display',
      kind: 'screen',
      status: 'permission-required'
    }
    const permissionWindow: Device = {
      id: 'window:screencapturekit-permission',
      name: 'Window Capture',
      kind: 'window',
      status: 'permission-required'
    }
    const legacyDisplay: Device = {
      id: 'screen:avfoundation:7',
      name: 'Capture screen 1',
      kind: 'screen',
      status: 'available'
    }
    const blockedLegacyDisplay: Device = {
      id: 'screen:avfoundation:8',
      name: 'Capture screen 2',
      kind: 'screen',
      status: 'permission-required'
    }
    const nativeDisplay: Device = {
      id: 'screen:screencapturekit:222',
      name: 'Display 2',
      kind: 'screen',
      status: 'available'
    }

    expect(isScreenCaptureKitCaptureDevice(permissionDisplay)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(permissionWindow)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(nativeDisplay)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(legacyDisplay)).toBe(false)

    expect(isCapturePickerDevice(permissionDisplay)).toBe(true)
    expect(isCapturePickerDevice(permissionWindow)).toBe(true)
    expect(isCapturePickerDevice(nativeDisplay)).toBe(true)
    expect(isCapturePickerDevice(legacyDisplay)).toBe(true)

    expect(isNativeCaptureDevice(permissionDisplay)).toBe(false)
    expect(isNativeCaptureDevice(permissionWindow)).toBe(false)
    expect(isNativeCaptureDevice(nativeDisplay)).toBe(true)
    expect(isNativeCaptureDevice(legacyDisplay)).toBe(false)

    expect(isSelectableCaptureDevice(permissionDisplay)).toBe(false)
    expect(isSelectableCaptureDevice(permissionWindow)).toBe(false)
    expect(isSelectableCaptureDevice(nativeDisplay)).toBe(true)
    expect(isSelectableCaptureDevice(legacyDisplay)).toBe(true)
    expect(isSelectableCaptureDevice(blockedLegacyDisplay)).toBe(false)
  })

  it('hides legacy avfoundation screen rows when ScreenCaptureKit rows exist', () => {
    const permissionDisplay: Device = {
      id: 'screen:screencapturekit-permission',
      name: 'Primary Display',
      kind: 'screen',
      status: 'permission-required'
    }
    const permissionWindow: Device = {
      id: 'window:screencapturekit-permission',
      name: 'Window Capture',
      kind: 'window',
      status: 'permission-required'
    }
    const legacyDisplay: Device = {
      id: 'screen:avfoundation:7',
      name: 'Capture screen 1',
      kind: 'screen',
      status: 'available'
    }

    expect(capturePickerDevices([permissionDisplay, permissionWindow, legacyDisplay])).toEqual([
      permissionDisplay,
      permissionWindow
    ])
  })

  it('uses avfoundation screen rows only when ScreenCaptureKit does not report any capture rows', () => {
    const legacyDisplay: Device = {
      id: 'screen:avfoundation:7',
      name: 'Capture screen 1',
      kind: 'screen',
      status: 'available'
    }
    const camera: Device = {
      id: 'camera:avfoundation-native:abc',
      name: 'FaceTime HD Camera',
      kind: 'camera',
      status: 'available'
    }

    expect(capturePickerDevices([camera, legacyDisplay])).toEqual([legacyDisplay])
  })
})

describe('smokePreviewCompositorCaptureConfig', () => {
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

  it('uses renderable synthetic sources instead of stopped real preview sources', () => {
    expect(smokePreviewCompositorCaptureConfig(config)).toEqual({
      ...config,
      sources: {
        cameraId: 'camera:synthetic-preview-smoke',
        cameraName: 'Synthetic preview camera',
        microphoneId: 'microphone:1',
        microphoneName: 'Microphone',
        testPattern: true
      }
    })
  })

  it('does not add a synthetic camera to screen-only smoke layouts', () => {
    expect(
      smokePreviewCompositorCaptureConfig({
        ...config,
        layout: { ...config.layout, layoutPreset: 'screen-only' }
      }).sources
    ).toEqual({
      cameraId: undefined,
      cameraName: undefined,
      microphoneId: 'microphone:1',
      microphoneName: 'Microphone',
      testPattern: true
    })
  })

  it('adds a synthetic camera to camera-required smoke layouts', () => {
    expect(
      smokePreviewCompositorCaptureConfig({
        ...config,
        layout: { ...config.layout, layoutPreset: 'camera-only' }
      }).sources.cameraId
    ).toBe('camera:synthetic-preview-smoke')
    expect(
      smokePreviewCompositorCaptureConfig({
        ...config,
        layout: { ...config.layout, layoutPreset: 'side-by-side' }
      }).sources.cameraId
    ).toBe('camera:synthetic-preview-smoke')
  })

  it('allows screen-camera smoke layouts to omit the camera when none is selected', () => {
    const config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'> = {
      sources: {
        screenId: 'screen:1',
        screenName: 'Display',
        windowId: 'window:1',
        windowName: 'App',
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
        cameraId: undefined,
        cameraName: undefined,
        microphoneId: 'microphone:1',
        microphoneName: 'Microphone',
        testPattern: true
      }
    })
  })
})

describe('layout preset source requirements', () => {
  it('matches the backend blockers for screen-backed presets', () => {
    expect(layoutPresetNeedsScreen('screen-camera')).toBe(true)
    expect(layoutPresetNeedsScreen('screen-only')).toBe(true)
    expect(layoutPresetNeedsScreen('side-by-side')).toBe(true)
    expect(layoutPresetNeedsScreen('camera-only')).toBe(false)
  })

  it('matches the backend blockers for camera-required presets', () => {
    expect(layoutPresetNeedsCamera('camera-only')).toBe(true)
    expect(layoutPresetNeedsCamera('side-by-side')).toBe(true)
    expect(layoutPresetNeedsCamera('screen-camera')).toBe(false)
    expect(layoutPresetNeedsCamera('screen-only')).toBe(false)
  })

  it('treats only native screen/window sources and test pattern as screen-capable for layouts', () => {
    expect(hasSelectedScreenSource({ screenId: 'screen:screencapturekit:1' })).toBe(true)
    expect(hasSelectedScreenSource({ windowId: 'window:screencapturekit:1' })).toBe(true)
    expect(hasSelectedScreenSource({ testPattern: true })).toBe(true)
    expect(hasSelectedScreenSource({ screenId: 'screen:avfoundation:7' })).toBe(false)
    expect(hasSelectedScreenSource({ cameraId: 'camera:1' })).toBe(false)
  })

  it('requires a concrete camera id for camera layouts', () => {
    expect(hasSelectedCameraSource({ cameraId: 'camera:1' })).toBe(true)
    expect(hasSelectedCameraSource({ screenId: 'screen:1' })).toBe(false)
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

describe('audio sync calibration helpers', () => {
  it('parses stable measure-av-sync JSON reports', () => {
    const parsed = parseAudioSyncRecommendationJson(
      JSON.stringify({
        schemaVersion: 1,
        pass: true,
        medianOffsetMs: 46,
        currentMicrophoneSyncOffsetMs: -120,
        recommendedMicrophoneSyncOffsetMs: -166,
        targetMs: 100,
        pairCount: 31,
        failures: [],
        warnings: ['within target']
      })
    )

    expect(parsed).toEqual({
      ok: true,
      recommendation: {
        pass: true,
        medianOffsetMs: 46,
        currentMicrophoneSyncOffsetMs: -120,
        recommendedMicrophoneSyncOffsetMs: -166,
        targetMs: 100,
        pairCount: 31,
        failures: [],
        warnings: ['within target']
      }
    })
  })

  it('rejects unsupported or malformed measurement JSON', () => {
    expect(parseAudioSyncRecommendationJson('nope')).toMatchObject({ ok: false })
    expect(parseAudioSyncRecommendationJson('{}')).toEqual({
      ok: false,
      error: 'Measurement JSON must use schemaVersion 1.'
    })
  })

  it('formats measured lag direction for operators', () => {
    expect(formatMeasuredAudioLag(121.4)).toBe('Audio lags video by 121 ms')
    expect(formatMeasuredAudioLag(-80.2)).toBe('Audio leads video by 80 ms')
    expect(formatMeasuredAudioLag(0)).toBe('Audio is aligned at 0 ms')
    expect(formatMeasuredAudioLag(null)).toBe('No paired flash/click measurement')
  })

  it('explains unavailable recommendations without changing audio settings', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneGainDb: 3,
      microphoneMuted: true
    }
    const recommendation = {
      medianOffsetMs: null,
      recommendedMicrophoneSyncOffsetMs: null,
      pairCount: 0,
      pass: false
    }

    expect(audioSyncCalibrationState(recommendation, audio)).toMatchObject({
      status: 'unavailable',
      canApply: false,
      recommendedOffsetMs: null
    })
    expect(applyAudioSyncRecommendation(audio, recommendation)).toBe(audio)
  })

  it('applies measured recommendations while preserving other audio controls', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneGainDb: 4,
      microphoneMuted: true,
      microphoneSyncOffsetMs: -120,
      microphoneSyncOffsetUserSet: true
    }
    const recommendation = {
      medianOffsetMs: 46,
      currentMicrophoneSyncOffsetMs: -120,
      recommendedMicrophoneSyncOffsetMs: -166,
      targetMs: 100,
      pairCount: 31,
      pass: true
    }

    expect(audioSyncCalibrationState(recommendation, audio)).toMatchObject({
      status: 'optional',
      canApply: true,
      recommendedOffsetMs: -166
    })
    expect(applyAudioSyncRecommendation(audio, recommendation)).toEqual({
      ...audio,
      microphoneSyncOffsetMs: -166,
      microphoneSyncOffsetUserSet: true
    })
  })

  it('recommends target misses and clamps imported recommendations', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneSyncOffsetMs: -900,
      microphoneSyncOffsetUserSet: true
    }
    const recommendation = {
      medianOffsetMs: 300,
      currentMicrophoneSyncOffsetMs: -900,
      recommendedMicrophoneSyncOffsetMs: -1200,
      targetMs: 100,
      pairCount: 4,
      pass: false
    }

    expect(audioSyncCalibrationState(recommendation, audio)).toMatchObject({
      status: 'recommended',
      canApply: true,
      recommendedOffsetMs: -1000
    })
  })

  it('resets calibration back to the structural default', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneGainDb: -2,
      microphoneSyncOffsetMs: -166,
      microphoneSyncOffsetUserSet: true
    }

    expect(resetAudioSyncCalibration(audio)).toEqual({
      ...audio,
      microphoneSyncOffsetMs: 0,
      microphoneSyncOffsetUserSet: false
    })
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
    expect(videoPresets['stream-youtube-4k30']).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 30,
      bitrateKbps: 30000
    })
  })

  it('normalizes persisted first-class presets through the shared map', () => {
    expect(normalizeVideoSettings({ preset: 'record-4k30' })).toEqual(videoPresets['record-4k30'])
    expect(normalizeVideoSettings({ preset: 'stream-safe-1080p30' })).toEqual(
      videoPresets['stream-safe-1080p30']
    )
    expect(normalizeVideoSettings({ preset: 'stream-youtube-4k30' })).toEqual(
      videoPresets['stream-youtube-4k30']
    )
  })
})

describe('videoProfileCompatibility', () => {
  it('resolves the stream output video from enabled streaming defaults', () => {
    const config = captureConfigFixture()
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-safe-1080p30',
      defaultBitrateKbps: 4500
    }

    expect(streamOutputVideoSettings(config.video, config.streaming)).toEqual({
      ...videoPresets['stream-safe-1080p30'],
      bitrateKbps: 4500
    })
  })

  it('resolves mixed destination outputs from a YouTube 4K default profile', () => {
    const config = captureConfigFixture()
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.platform === 'youtube' || target.platform === 'twitch'
      }))
    }

    const outputs = streamOutputVideosForTargets(config.video, config.streaming)
    const youtube = outputs.find((output) => output.target?.platform === 'youtube')
    const twitch = outputs.find((output) => output.target?.platform === 'twitch')

    expect(youtube?.video).toEqual(videoPresets['stream-youtube-4k30'])
    expect(twitch?.video).toEqual(videoPresets['stream-safe-1080p30'])
  })

  it('lets an explicit target output override the platform default', () => {
    const config = captureConfigFixture()
    config.streaming = {
      ...config.streaming,
      enabled: true
    }
    const twitch = {
      ...config.streaming.targets.find((target) => target.platform === 'twitch')!,
      enabled: true,
      outputPreset: 'stream-safe-1080p60' as const,
      outputBitrateKbps: 5500
    }

    expect(streamOutputVideoForTarget(config.video, config.streaming, twitch)).toEqual({
      ...videoPresets['stream-safe-1080p60'],
      bitrateKbps: 5500
    })
  })

  it('allows 4K local recording with a stream-safe split output profile', () => {
    const config = captureConfigFixture()
    config.recordEnabled = true
    config.streamEnabled = true
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-safe-1080p30',
      defaultBitrateKbps: 6000
    }

    expect(videoProfileCompatibility(config)).toEqual({
      blockingReason: null,
      warning: null
    })
  })

  it('blocks 4K livestreaming in the v1 shared-output UI path without a split profile', () => {
    const result = videoProfileCompatibility({
      recordEnabled: true,
      streamEnabled: true,
      video: videoPresets['record-4k30']
    })

    expect(result.blockingReason).toContain('4K livestreaming is not available')
  })

  it('allows YouTube-only 4K30 streaming with local 4K recording enabled', () => {
    const config = captureConfigFixture()
    config.recordEnabled = true
    config.streamEnabled = true
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.platform === 'youtube'
      }))
    }

    const result = videoProfileCompatibility(config)

    expect(result.blockingReason).toBeNull()
    expect(result.warning).toContain('normal latency')
  })

  it('allows YouTube 4K30 streaming with a Twitch stream-safe companion output', () => {
    const config = captureConfigFixture()
    config.recordEnabled = true
    config.streamEnabled = true
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.platform === 'youtube' || target.platform === 'twitch'
      }))
    }

    const result = videoProfileCompatibility(config)

    expect(result.blockingReason).toBeNull()
    expect(result.warning).toContain('non-YouTube destinations use stream-safe 1080p')
  })

  it('blocks YouTube 4K30 streaming without local 4K recording during acceptance', () => {
    const config = captureConfigFixture()
    config.recordEnabled = false
    config.streamEnabled = true
    config.video = videoPresets['stream-safe-1080p30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.platform === 'youtube'
      }))
    }

    expect(videoProfileCompatibility(config).blockingReason).toContain(
      'requires local 4K recording'
    )
  })

  it('blocks livestream bitrates above the platform-safe budget', () => {
    const result = videoProfileCompatibility({
      recordEnabled: false,
      streamEnabled: true,
      video: videoPresets['stream-1080p60']
    })

    expect(result.blockingReason).toContain('6000 kbps or lower')
  })

  it('blocks 4K record plus stream when the stream FPS is higher than the recording FPS', () => {
    const config = captureConfigFixture()
    config.recordEnabled = true
    config.streamEnabled = true
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-safe-1080p60',
      defaultBitrateKbps: 6000
    }

    expect(videoProfileCompatibility(config).blockingReason).toContain('stream FPS no higher')
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

  it('does not persist the dev synthetic diagnostic source', () => {
    const config = captureConfigFixture()
    config.sources = {
      ...config.sources,
      screenId: 'screen:screencapturekit:1',
      screenName: 'Display 1',
      testPattern: true
    }

    expect(persistableCaptureConfig(config).sources).toMatchObject({
      screenId: 'screen:screencapturekit:1',
      screenName: 'Display 1'
    })
    expect(persistableCaptureConfig(config).sources.testPattern).toBeUndefined()
  })

  it('heals old persisted configs that still contain the synthetic diagnostic source', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          sources: {
            screenId: 'screen:screencapturekit:1',
            screenName: 'Display 1',
            testPattern: true
          }
        }),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })

    expect(loadCaptureConfig().sources).toMatchObject({
      screenId: 'screen:screencapturekit:1',
      screenName: 'Display 1',
      testPattern: false
    })
  })
})
