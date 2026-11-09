import { describe, expect, it, vi } from 'vitest'
import { cameraLookLayout, normalizeCameraLook, createCameraLookThrottle } from './camera-look'
import { defaultCaptureConfig, normalizeLayoutSettings, persistableCaptureConfig } from './capture'
import { normalizeSceneVisual } from './scene-presets'
import { buildStartSessionParams } from './session-params'

const look = { brightness: 0.05, contrast: 1.1, saturation: 0.8 }

describe('per-camera look', () => {
  it('injects settings at session start and never saves the look into a scene or capture preferences', () => {
    const config = {
      ...defaultCaptureConfig,
      sources: { ...defaultCaptureConfig.sources, cameraId: 'camera-a' }
    }
    const params = buildStartSessionParams({
      captureConfig: config,
      scene: null,
      settings: {
        outputDirectory: '',
        keepOriginalRecording: false,
        cameraLooks: { 'camera-a': look }
      }
    })
    expect(params.layout.cameraLook).toEqual(look)
    const effective = { ...config, layout: params.layout }
    expect(persistableCaptureConfig(effective).layout).not.toHaveProperty('cameraLook')
    expect(
      normalizeSceneVisual({ layout: params.layout, sources: config.sources, background: null })
        .layout
    ).not.toHaveProperty('cameraLook')
    expect(normalizeLayoutSettings(params.layout).cameraLook).toEqual(look)
    expect(normalizeLayoutSettings({ cameraLook: null })).not.toHaveProperty('cameraLook')
    expect(normalizeLayoutSettings({})).not.toHaveProperty('cameraLook')
  })

  it('uses the selected camera settings across scenes and drops a previous camera look', () => {
    const layout = { ...defaultCaptureConfig.layout, cameraLook: look }
    expect(cameraLookLayout(layout, 'camera-a', { 'camera-a': look }).cameraLook).toEqual(look)
    expect(cameraLookLayout(layout, 'camera-b', { 'camera-a': look })).not.toHaveProperty(
      'cameraLook'
    )
    expect(cameraLookLayout(layout, undefined, { 'camera-a': look })).not.toHaveProperty(
      'cameraLook'
    )
    expect(
      cameraLookLayout(layout, 'camera-a', {
        'camera-a': { brightness: 0, contrast: 1, saturation: 1 }
      })
    ).not.toHaveProperty('cameraLook')
  })

  it('loads older settings as neutral and bounds stored values', () => {
    expect(normalizeCameraLook(undefined)).toBeUndefined()
    expect(normalizeCameraLook({})).toBeUndefined()
    expect(normalizeCameraLook({ brightness: Infinity, contrast: 0, saturation: 3 })).toEqual({
      brightness: 0,
      contrast: 0.5,
      saturation: 2
    })
  })
})

describe('live camera look cadence', () => {
  it('sends the latest value while dragging at about 30 Hz and includes the trailing value', () => {
    vi.useFakeTimers()
    let latest = 0
    const applied: number[] = []
    const throttle = createCameraLookThrottle(() => applied.push(latest))
    try {
      for (let step = 1; step <= 10; step++) {
        latest = step
        throttle.schedule()
        vi.advanceTimersByTime(10)
      }
      expect(applied).toEqual([4, 8])
      vi.advanceTimersByTime(33)
      expect(applied).toEqual([4, 8, 10])
      latest = 11
      throttle.schedule()
      throttle.dispose()
      vi.advanceTimersByTime(33)
      expect(applied).toEqual([4, 8, 10])
    } finally {
      throttle.dispose()
      vi.useRealTimers()
    }
  })
})
