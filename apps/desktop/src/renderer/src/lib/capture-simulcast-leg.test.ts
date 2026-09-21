import { describe, expect, it } from 'vitest'

import type { CaptureConfig } from './capture'
import {
  buildSimulcastParams,
  defaultCaptureConfig,
  normalizeLayoutSettings,
  simulcastLegLayout,
  simulcastLegPreset
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
    lastVerticalPreset: 'vertical-camera-bottom',
    ...patch
  }
}

describe('vertical simulcast leg', () => {
  it('defaults the leg to Fit while vertical Studio mode keeps the Fill law', () => {
    // Owner decision O1 (2026-09-21): the leg mirrors a live program where
    // the shared screen is the content; short-form recording stays filled.
    expect(defaultCaptureConfig.simulcastScreenFraming).toBe('fit')
    expect(defaultCaptureConfig.layout.verticalScreenFraming).toBe('fill')
    expect(defaultCaptureConfig.simulcastFollowsProgram).toBe(true)
  })

  it('goes live with the whole screen: camera bottom + fit, on the portrait canvas', () => {
    const params = buildSimulcastParams(dualOrientationConfig())
    expect(params?.layout.layoutPreset).toBe('vertical-camera-bottom')
    expect(params?.layout.verticalScreenFraming).toBe('fit')
    expect(params?.layout.cameraTransformMode).toBe('preset')
    expect(params?.layout.cameraTransform).toBeNull()
    expect(params?.video).toMatchObject({ width: 1080, height: 1920 })
  })

  it('the leg framing is its own setting, never the recording layout framing', () => {
    const config = dualOrientationConfig({ simulcastScreenFraming: 'fill' })
    config.layout = { ...config.layout, verticalScreenFraming: 'fit' }
    expect(buildSimulcastParams(config)?.layout.verticalScreenFraming).toBe('fill')
  })

  it('is not armed without a vertical destination or in vertical Studio mode', () => {
    expect(buildSimulcastParams(defaultCaptureConfig)).toBeUndefined()
    const vertical = dualOrientationConfig()
    vertical.layout = { ...vertical.layout, layoutPreset: 'vertical-split' }
    expect(buildSimulcastParams(vertical)).toBeUndefined()
  })

  it('follows the program only where a vertical twin exists', () => {
    const config = dualOrientationConfig()
    expect(simulcastLegPreset(config, 'camera-only')).toBe('vertical-camera-only')
    expect(simulcastLegPreset(config, 'screen-only')).toBe('vertical-screen-only')
    expect(simulcastLegPreset(config, 'screen-camera')).toBe('vertical-camera-bottom')
    expect(simulcastLegPreset(config, 'side-by-side')).toBe('vertical-camera-bottom')

    const pinned = dualOrientationConfig({ simulcastFollowsProgram: false })
    expect(simulcastLegPreset(pinned, 'camera-only')).toBe('vertical-camera-bottom')
  })

  it('session start and live edits build the leg from one function', () => {
    const config = dualOrientationConfig()
    config.layout = { ...config.layout, layoutPreset: 'camera-only' }
    // The 2026-09-21 live session: a camera-only program must not leave the
    // vertical leg asking for a screen scene the program is not showing.
    expect(buildSimulcastParams(config)?.layout).toEqual(simulcastLegLayout(config))
    expect(simulcastLegLayout(config).layoutPreset).toBe('vertical-camera-only')
    expect(simulcastLegLayout(config, 'screen-camera').layoutPreset).toBe('vertical-camera-bottom')
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

describe('simulcastLegLiveRequest (mid-stream vertical leg edits)', () => {
  const base = {
    intentId: 41,
    background: undefined,
    protectedOverlayWindowIds: [7]
  }

  it('sends the whole leg scene on the portrait canvas, echoing the intent', async () => {
    const { simulcastLegLiveRequest } = await import('./simulcast-leg-live')
    const request = simulcastLegLiveRequest({ ...base, config: dualOrientationConfig() })
    expect(request).toMatchObject({
      intentId: 41,
      layout: { layoutPreset: 'vertical-camera-bottom', verticalScreenFraming: 'fit' },
      video: { width: 1080, height: 1920 },
      protectedOverlayWindowIds: [7]
    })
    // The echoed intent is never below the schema floor.
    expect(
      simulcastLegLiveRequest({ ...base, intentId: 0, config: dualOrientationConfig() })?.intentId
    ).toBe(1)
  })

  it('sends nothing when no vertical leg is armed', async () => {
    const { simulcastLegLiveRequest } = await import('./simulcast-leg-live')
    expect(simulcastLegLiveRequest({ ...base, config: defaultCaptureConfig })).toBeNull()
  })

  it('follows a program switch only when the paired vertical scene changes', async () => {
    const { simulcastLegLiveRequest } = await import('./simulcast-leg-live')
    const config = dualOrientationConfig() // program: screen-camera
    // screen-camera -> side-by-side keeps the remembered vertical scene.
    expect(
      simulcastLegLiveRequest({ ...base, config, afterProgramSwitchTo: 'side-by-side' })
    ).toBeNull()
    // screen-camera -> camera-only moves the leg to its vertical twin.
    expect(
      simulcastLegLiveRequest({ ...base, config, afterProgramSwitchTo: 'camera-only' })?.layout
        .layoutPreset
    ).toBe('vertical-camera-only')
    // Follow off: a program switch never moves the leg.
    expect(
      simulcastLegLiveRequest({
        ...base,
        config: dualOrientationConfig({ simulcastFollowsProgram: false }),
        afterProgramSwitchTo: 'camera-only'
      })
    ).toBeNull()
  })
})
