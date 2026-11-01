import { describe, expect, it } from 'vitest'
import { cameraLookLayout, normalizeCameraLook } from './camera-look'
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
