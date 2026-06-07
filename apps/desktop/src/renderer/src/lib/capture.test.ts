import { describe, expect, it } from 'vitest'

import type { CaptureConfig } from './capture'
import { normalizeAudioSettings, normalizeMicrophoneSyncOffsetMs, smokePreviewCompositorCaptureConfig } from './capture'

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

  it('applies the calibrated default until the user sets an offset', () => {
    expect(normalizeAudioSettings({ microphoneSyncOffsetMs: 0 }).microphoneSyncOffsetMs).toBe(-166)
    expect(normalizeAudioSettings({}).microphoneSyncOffsetMs).toBe(-166)
  })

  it('clamps to the backend-supported range', () => {
    expect(normalizeMicrophoneSyncOffsetMs(-1200)).toBe(-1000)
    expect(normalizeMicrophoneSyncOffsetMs(1200)).toBe(1000)
  })

  it('uses the provided fallback when the value is not numeric', () => {
    expect(normalizeMicrophoneSyncOffsetMs('nope', -120)).toBe(-120)
  })
})
