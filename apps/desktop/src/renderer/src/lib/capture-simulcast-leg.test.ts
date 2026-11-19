import { describe, expect, it } from 'vitest'

import type { LayoutSettings } from './backend'
import type { CaptureConfig, SimulcastScene } from './capture'
import {
  buildSimulcastParams,
  defaultCaptureConfig,
  normalizeLayoutSettings,
  simulcastLegLayout,
  simulcastLegLiveRequest,
  videoPresets
} from './capture'

/** A horizontal program with the built-in YouTube Vertical destination armed. */
function dualOrientationConfig(patch: Partial<CaptureConfig> = {}): CaptureConfig {
  const streaming = {
    ...defaultCaptureConfig.streaming,
    enabled: true,
    enabledTargetIds: ['youtube', 'youtube-vertical'],
    targets: defaultCaptureConfig.streaming.targets.map((target) =>
      target.id === 'youtube' || target.id === 'youtube-vertical'
        ? { ...target, enabled: true }
        : target
    )
  }
  return {
    ...defaultCaptureConfig,
    streamEnabled: true,
    streaming,
    ...patch
  }
}

/** A scene with this 9:16 layout (plan 231 D4): what the vertical stream shows for it. */
function sceneWithVertical(patch: Partial<LayoutSettings> = {}): SimulcastScene {
  return {
    layouts: {
      vertical: {
        ...defaultCaptureConfig.layout,
        layoutPreset: 'vertical-camera-bottom',
        verticalScreenFraming: 'fit',
        ...patch
      }
    }
  }
}

describe('vertical simulcast leg (plan 231 D4: the scene on stream, in its 9:16 layout)', () => {
  it('keeps the old vertical stream settings, with O1 defaults, as migration inputs', () => {
    // Owner decision O1 (2026-09-21): the leg mirrors a live program where
    // the shared screen is the content (Fit); short-form recording stays
    // filled. A scene made in a 16:9 studio takes the first (scenes-migration).
    expect(defaultCaptureConfig.simulcastScreenFraming).toBe('fit')
    expect(defaultCaptureConfig.layout.verticalScreenFraming).toBe('fill')
    expect(defaultCaptureConfig.simulcastFollowsProgram).toBe(true)
  })

  it("goes live with the scene's 9:16 layout: camera bottom + fit, on the portrait canvas", () => {
    const params = buildSimulcastParams(dualOrientationConfig(), sceneWithVertical())
    expect(params?.layout.layoutPreset).toBe('vertical-camera-bottom')
    expect(params?.layout.verticalScreenFraming).toBe('fit')
    expect(params?.layout.cameraTransformMode).toBe('preset')
    expect(params?.layout.cameraTransform).toBeNull()
    expect(params?.video).toMatchObject({ width: 1080, height: 1920 })
  })

  it('uses HD vertical stream settings independently of 4K local recording', () => {
    const config = dualOrientationConfig({ video: videoPresets['record-4k30'] })
    expect(buildSimulcastParams(config, sceneWithVertical())?.video).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      bitrateKbps: 6000
    })
    expect(config.video).toEqual(videoPresets['record-4k30'])
  })

  it("takes the scene's Fill or Fit, never the program's or the old leg setting", () => {
    const config = dualOrientationConfig({ simulcastScreenFraming: 'fit' })
    config.layout = { ...config.layout, verticalScreenFraming: 'fit' }
    expect(
      buildSimulcastParams(config, sceneWithVertical({ verticalScreenFraming: 'fill' }))?.layout
        .verticalScreenFraming
    ).toBe('fill')
  })

  it('is not armed without a vertical destination or in a 9:16 studio', () => {
    expect(buildSimulcastParams(defaultCaptureConfig, sceneWithVertical())).toBeUndefined()
    const vertical = dualOrientationConfig()
    vertical.layout = { ...vertical.layout, layoutPreset: 'vertical-split' }
    expect(buildSimulcastParams(vertical, sceneWithVertical())).toBeUndefined()
  })

  it("follows the scene, never the program's layout, the remembered layout or Follow", () => {
    // Before plan 231 a Camera only program streamed vertical Camera only
    // (Follow) and anything else the remembered vertical layout. Now each
    // scene says, and those settings steer nothing.
    const config = dualOrientationConfig({
      lastVerticalPreset: 'vertical-split',
      simulcastFollowsProgram: true
    })
    for (const program of ['camera-only', 'screen-only', 'screen-camera'] as const) {
      const legLayout = buildSimulcastParams(
        { ...config, layout: { ...config.layout, layoutPreset: program } },
        sceneWithVertical({ layoutPreset: 'vertical-screen-camera' })
      )?.layout
      expect(legLayout?.layoutPreset).toBe('vertical-screen-camera')
    }
  })

  it('session start and live edits build the leg from one function', () => {
    const config = dualOrientationConfig()
    const scene = sceneWithVertical({ layoutPreset: 'vertical-split' })
    expect(buildSimulcastParams(config, scene)?.layout).toEqual(
      simulcastLegLayout(scene, config.layout)
    )
  })

  it("takes the scene's arrangement and the program's sources: look, mirror, key, visibility", () => {
    const program: LayoutSettings = {
      ...defaultCaptureConfig.layout,
      layoutPreset: 'screen-camera',
      cameraShape: 'circle',
      cameraMirror: true,
      cameraLook: { brightness: 0.05, contrast: 1.1, saturation: 0.8 },
      cameraChromaKeyEnabled: true,
      cameraChromaKeyColor: '#0000FF',
      cameraChromaKeySimilarityPct: 31,
      cameraChromaKeySmoothnessPct: 12,
      cameraChromaKeySpillPct: 44,
      cameraChromaKeyEdges: { leftPct: 3, topPct: 0, rightPct: 0, bottomPct: 2 },
      sourceVisibility: { camera: true, capture: false }
    }
    const leg = simulcastLegLayout(
      sceneWithVertical({
        layoutPreset: 'vertical-screen-camera',
        cameraShape: 'rounded',
        cameraSize: 'large',
        cameraMirror: false,
        cameraChromaKeyEnabled: false,
        sourceVisibility: { camera: true, capture: true }
      }),
      program
    )
    // Where and in what shape: the scene's 9:16 layout.
    expect(leg).toMatchObject({
      layoutPreset: 'vertical-screen-camera',
      cameraShape: 'rounded',
      cameraSize: 'large',
      verticalScreenFraming: 'fit'
    })
    // What the camera looks like and which sources show: the program's.
    expect(leg).toMatchObject({
      cameraMirror: true,
      cameraLook: program.cameraLook,
      cameraChromaKeyEnabled: true,
      cameraChromaKeyColor: '#0000FF',
      cameraChromaKeySimilarityPct: 31,
      cameraChromaKeySmoothnessPct: 12,
      cameraChromaKeySpillPct: 44,
      cameraChromaKeyEdges: program.cameraChromaKeyEdges,
      sourceVisibility: { camera: true, capture: false }
    })
    // A neutral look and no key edges stay out of the request.
    const plain = simulcastLegLayout(
      sceneWithVertical({ cameraLook: { brightness: 0.2, contrast: 1, saturation: 1 } }),
      defaultCaptureConfig.layout
    )
    expect(plain).not.toHaveProperty('cameraLook')
    expect(plain).not.toHaveProperty('cameraChromaKeyEdges')
  })
})

describe('verticalScreenFraming normalisation', () => {
  it('fills for configs saved before the field existed and rejects garbage', () => {
    expect(normalizeLayoutSettings({}).verticalScreenFraming).toBe('fill')
    expect(normalizeLayoutSettings({ verticalScreenFraming: 'fit' }).verticalScreenFraming).toBe(
      'fit'
    )
    expect(
      normalizeLayoutSettings({ verticalScreenFraming: 'stretch' }).verticalScreenFraming
    ).toBe('fill')
    expect(normalizeLayoutSettings({ verticalScreenFraming: null }).verticalScreenFraming).toBe(
      'fill'
    )
  })
})

describe('simulcastLegLiveRequest (the leg of a running session)', () => {
  it('is built exactly like the session-start leg, as an explicit leg request', () => {
    const config = dualOrientationConfig()
    const scene = sceneWithVertical()
    const request = simulcastLegLiveRequest(config, scene)
    const start = buildSimulcastParams(config, scene)
    expect(request).toEqual({
      simulcastLeg: true,
      sources: config.sources,
      layout: start?.layout,
      video: start?.video
    })
    // The session-start leg carries no background or overlay ids: a live
    // edit must not make the vertical stream look different from how it
    // went live.
    expect(request).not.toHaveProperty('background')
    expect(request).not.toHaveProperty('protectedOverlayWindowIds')
  })

  it('sends nothing when no vertical leg is armed', () => {
    expect(simulcastLegLiveRequest(defaultCaptureConfig, sceneWithVertical())).toBeNull()
  })

  it('a scene switch cuts the leg to the new scene, each leg in its own layout', () => {
    // After a committed switch the hook passes the committed program and the
    // scene now on stream: the leg is that scene's 9:16 layout.
    const config = dualOrientationConfig()
    const figma = sceneWithVertical({ layoutPreset: 'vertical-split' })
    const brb = sceneWithVertical({ layoutPreset: 'vertical-camera-only' })
    const program = (layoutPreset: LayoutSettings['layoutPreset']) => ({
      ...config,
      layout: { ...config.layout, layoutPreset, cameraMirror: true }
    })
    const onBrb = simulcastLegLiveRequest(program('camera-only'), brb)
    expect(onBrb?.layout.layoutPreset).toBe('vertical-camera-only')
    expect(onBrb?.layout.cameraMirror).toBe(true)
    const backOnFigma = simulcastLegLiveRequest(program('screen-camera'), figma)
    expect(backOnFigma?.layout.layoutPreset).toBe('vertical-split')
  })
})
