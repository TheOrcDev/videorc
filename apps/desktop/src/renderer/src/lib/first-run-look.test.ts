import { describe, expect, it } from 'vitest'

import type { Device, MediaAccessSnapshot } from './backend'
import { applyLiveBackground, createDefaultRegistry } from './background-assets'
import { defaultCaptureConfig, videoPresets, type CaptureConfig } from './capture'
import { backgroundLibrarySyncDecision, firstRunLookWritesHeld } from './first-run'
import {
  FIRST_RUN_LOOK_REASONS,
  cameraShapeLayoutPatch,
  firstRunBackgroundChoice,
  firstRunLayoutOptions,
  firstRunLookPatch,
  firstRunLookPreset,
  registryLiveBackgroundId,
  shapeApplies
} from './first-run-look'

const SCREEN: Device = {
  id: 'screen:1',
  name: 'Built-in Display',
  kind: 'screen',
  status: 'available'
}
const CAMERA: Device = { id: 'cam-1', name: 'FaceTime HD', kind: 'camera', status: 'available' }
const MIC: Device = {
  id: 'mic-1',
  name: 'MacBook Microphone',
  kind: 'microphone',
  status: 'available'
}

const GRANTED: MediaAccessSnapshot = { camera: 'granted', microphone: 'granted', screen: 'granted' }

function fresh(sources: CaptureConfig['sources'] = { screenId: SCREEN.id, cameraId: CAMERA.id }) {
  return { ...defaultCaptureConfig, sources }
}

describe('firstRunLookPatch', () => {
  it('a horizontal layout: the preset lands in Preset mode with the camera transform cleared', () => {
    const next = firstRunLookPatch(fresh(), {
      orientation: 'horizontal',
      layoutPreset: 'camera-only',
      cameraShape: 'rectangle'
    })
    expect(next.layout.layoutPreset).toBe('camera-only')
    expect(next.layout.arrangementMode).toBe('preset')
    expect(next.layout.sourceTransformOverrides).toEqual({})
    expect(next.layout.cameraTransformMode).toBe('preset')
    expect(next.layout.cameraTransform).toBeNull()
    // The canvas does not move inside an orientation.
    expect(next.video).toBe(defaultCaptureConfig.video)
    expect(next.verticalRestoreVideo).toBeNull()
    // The commit point remembers the preset as its mode's last scene.
    expect(next.lastHorizontalPreset).toBe('camera-only')
    expect(next.lastVerticalPreset).toBe(defaultCaptureConfig.lastVerticalPreset)
    expect(next.sources).toEqual(fresh().sources)
  })

  it('entering vertical takes the 1080×1920 canvas and remembers the landscape one (requestCameraPresetTransaction)', () => {
    const next = firstRunLookPatch(fresh(), {
      orientation: 'vertical',
      layoutPreset: 'vertical-camera-top',
      cameraShape: 'rectangle'
    })
    expect(next.layout.layoutPreset).toBe('vertical-camera-top')
    expect(next.video).toEqual(videoPresets['vertical-1080x1920'])
    expect(next.verticalRestoreVideo).toEqual(defaultCaptureConfig.video)
    expect(next.lastVerticalPreset).toBe('vertical-camera-top')
    expect(next.lastHorizontalPreset).toBe('screen-camera')
  })

  it('leaving vertical restores the remembered landscape canvas', () => {
    const vertical = firstRunLookPatch(fresh(), {
      orientation: 'vertical',
      layoutPreset: 'vertical-split',
      cameraShape: 'rectangle'
    })
    const back = firstRunLookPatch(vertical, {
      orientation: 'horizontal',
      layoutPreset: 'screen-camera',
      cameraShape: 'rectangle'
    })
    expect(back.video).toEqual(defaultCaptureConfig.video)
    expect(back.verticalRestoreVideo).toBeNull()
    expect(back.lastVerticalPreset).toBe('vertical-split')
    expect(back.lastHorizontalPreset).toBe('screen-camera')
  })

  it('a preset of the other orientation lands on the scene remembered for the chosen orientation', () => {
    const config = { ...fresh(), lastVerticalPreset: 'vertical-screen-only' as const }
    expect(
      firstRunLookPreset(config, { orientation: 'vertical', layoutPreset: 'screen-only' })
    ).toBe('vertical-screen-only')
    const next = firstRunLookPatch(config, {
      orientation: 'vertical',
      layoutPreset: 'screen-only',
      cameraShape: 'rectangle'
    })
    expect(next.layout.layoutPreset).toBe('vertical-screen-only')
    expect(next.video).toEqual(videoPresets['vertical-1080x1920'])
  })

  it('Rounded snaps the aspect to square as the Scene page does; Circle and Rectangle leave it', () => {
    expect(cameraShapeLayoutPatch('rounded')).toEqual({
      cameraShape: 'rounded',
      cameraAspect: 'square'
    })
    expect(cameraShapeLayoutPatch('circle')).toEqual({ cameraShape: 'circle' })
    expect(cameraShapeLayoutPatch('rectangle')).toEqual({ cameraShape: 'rectangle' })

    const choice = { orientation: 'horizontal' as const, layoutPreset: 'screen-camera' as const }
    const rounded = firstRunLookPatch(fresh(), { ...choice, cameraShape: 'rounded' })
    expect(rounded.layout.cameraShape).toBe('rounded')
    expect(rounded.layout.cameraAspect).toBe('square')
    expect(rounded.layout.cameraCornerRadiusPct).toBe(
      defaultCaptureConfig.layout.cameraCornerRadiusPct
    )

    const circle = firstRunLookPatch(fresh(), { ...choice, cameraShape: 'circle' })
    expect(circle.layout.cameraShape).toBe('circle')
    expect(circle.layout.cameraAspect).toBe('source')

    // Rectangle after Rounded keeps the square aspect, exactly as the Scene page.
    const rectangle = firstRunLookPatch(rounded, { ...choice, cameraShape: 'rectangle' })
    expect(rectangle.layout.cameraShape).toBe('rectangle')
    expect(rectangle.layout.cameraAspect).toBe('square')
  })

  it('recalls the target preset’s framing and remembers the committed one, as the commit point does', () => {
    const config: CaptureConfig = {
      ...fresh(),
      layout: { ...defaultCaptureConfig.layout, cameraZoom: 120, cameraOffsetX: 10 },
      layoutFramingMemory: {
        ...defaultCaptureConfig.layoutFramingMemory,
        layouts: {
          ...defaultCaptureConfig.layoutFramingMemory.layouts,
          'camera-only': { cameraZoom: 150, cameraOffsetX: -20, cameraOffsetY: 5 }
        }
      }
    }
    const next = firstRunLookPatch(config, {
      orientation: 'horizontal',
      layoutPreset: 'camera-only',
      cameraShape: 'rectangle'
    })
    expect(next.layout.cameraZoom).toBe(150)
    expect(next.layout.cameraOffsetX).toBe(-20)
    expect(next.layout.cameraOffsetY).toBe(5)
    expect(next.layoutFramingMemory.layouts['camera-only']).toEqual({
      cameraZoom: 150,
      cameraOffsetX: -20,
      cameraOffsetY: 5
    })
    // The same preset keeps its own framing.
    const same = firstRunLookPatch(config, {
      orientation: 'horizontal',
      layoutPreset: 'screen-camera',
      cameraShape: 'rectangle'
    })
    expect(same.layout.cameraZoom).toBe(120)
    expect(same.layoutFramingMemory.layouts['screen-camera'].cameraZoom).toBe(120)
  })

  it('leaves Freeform for the preset and drops its overrides', () => {
    const config: CaptureConfig = {
      ...fresh(),
      layout: {
        ...defaultCaptureConfig.layout,
        arrangementMode: 'freeform',
        sourceTransformOverrides: {
          'source:camera': { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }
        } as CaptureConfig['layout']['sourceTransformOverrides']
      }
    }
    const next = firstRunLookPatch(config, {
      orientation: 'horizontal',
      layoutPreset: 'side-by-side',
      cameraShape: 'rectangle'
    })
    expect(next.layout.arrangementMode).toBe('preset')
    expect(next.layout.sourceTransformOverrides).toEqual({})
  })
})

describe('firstRunBackgroundChoice', () => {
  it('None on a fresh registry is the same registry', () => {
    const registry = createDefaultRegistry()
    expect(firstRunBackgroundChoice(registry, null)).toBe(registry)
    expect(registryLiveBackgroundId(registry)).toBeNull()
  })

  it('a live background on a fresh registry is what Assets’ tile applies: active, first look, no stored choices', () => {
    const registry = createDefaultRegistry()
    const next = firstRunBackgroundChoice(registry, 'liquid-chrome')
    expect(next).toEqual(applyLiveBackground(registry, 'liquid-chrome'))
    expect(next.live.activeId).toBe('liquid-chrome')
    expect(next.activeSlotId).toBeNull()
    expect(next.live.settings).toEqual({})
    expect(registryLiveBackgroundId(next)).toBe('liquid-chrome')
  })

  it('picking the one already on is the same registry', () => {
    const registry = applyLiveBackground(createDefaultRegistry(), 'silk')
    expect(firstRunBackgroundChoice(registry, 'silk')).toBe(registry)
  })

  it('None takes a live background or a picture off (the committed-None registry)', () => {
    const live = applyLiveBackground(createDefaultRegistry(), 'beams')
    expect(firstRunBackgroundChoice(live, null)).toEqual({
      ...live,
      activeSlotId: null,
      live: { ...live.live, activeId: null }
    })
    const picture = { ...createDefaultRegistry(), activeSlotId: 'slot-1' }
    const next = firstRunBackgroundChoice(picture, null)
    expect(next.activeSlotId).toBeNull()
    expect(next.live.activeId).toBeNull()
    expect(registryLiveBackgroundId(picture)).toBeNull()
  })

  it('a remembered other look goes back to the first look; motion, dim and visibility stay', () => {
    const registry = {
      ...createDefaultRegistry(),
      activeSlotId: 'slot-2',
      live: {
        activeId: null,
        settings: {
          dither: {
            look: 'retro',
            motion: 'normal' as const,
            dimPercent: 30,
            visibilityPercent: 35
          }
        }
      }
    }
    const next = firstRunBackgroundChoice(registry, 'dither')
    expect(next.activeSlotId).toBeNull()
    expect(next.live.activeId).toBe('dither')
    expect(next.live.settings.dither).toEqual({
      look: 'classic',
      motion: 'normal',
      dimPercent: 30,
      visibilityPercent: 35
    })
  })
})

describe('shapeApplies', () => {
  it('only the inset presets draw the camera shape (scene_geometry camera_mask)', () => {
    expect(shapeApplies('screen-camera')).toBe(true)
    expect(shapeApplies('vertical-screen-camera')).toBe(true)
    for (const preset of [
      'screen-only',
      'camera-only',
      'side-by-side',
      'vertical-camera-top',
      'vertical-camera-bottom',
      'vertical-split',
      'vertical-screen-only',
      'vertical-camera-only'
    ] as const) {
      expect(shapeApplies(preset)).toBe(false)
    }
  })
})

describe('firstRunLayoutOptions', () => {
  const base = (overrides: Partial<Parameters<typeof firstRunLayoutOptions>[0]> = {}) =>
    firstRunLayoutOptions({
      orientation: 'horizontal',
      current: 'screen-camera',
      layout: defaultCaptureConfig.layout,
      sources: { screenId: SCREEN.id, cameraId: CAMERA.id, microphoneId: MIC.id },
      mediaAccess: GRANTED,
      devices: [SCREEN, CAMERA, MIC],
      ...overrides
    })

  it('everything granted and found: every layout available, the current one preselected, labels from layout-labels', () => {
    const { options, preselected } = base()
    expect(options.map((option) => option.preset)).toEqual([
      'screen-camera',
      'screen-only',
      'camera-only',
      'side-by-side'
    ])
    expect(options.map((option) => option.label)).toEqual([
      'Screen + camera',
      'Screen only',
      'Camera only',
      'Side by side'
    ])
    expect(options.every((option) => option.available && option.reason === null)).toBe(true)
    expect(options.map((option) => option.shapeApplies)).toEqual([true, false, false, false])
    expect(preselected).toBe('screen-camera')
  })

  it('vertical lists the six vertical layouts in gallery order', () => {
    const { options, preselected } = base({
      orientation: 'vertical',
      current: 'vertical-camera-top'
    })
    expect(options.map((option) => option.preset)).toEqual([
      'vertical-camera-top',
      'vertical-camera-bottom',
      'vertical-split',
      'vertical-screen-camera',
      'vertical-screen-only',
      'vertical-camera-only'
    ])
    expect(options.map((option) => option.label)).toEqual([
      'Camera top',
      'Camera bottom',
      'Split',
      'Screen + camera',
      'Screen only',
      'Camera only'
    ])
    expect(options.map((option) => option.shapeApplies)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false
    ])
    expect(preselected).toBe('vertical-camera-top')
  })

  it('no Screen Recording grant: screen layouts say to allow it; Camera only is preselected', () => {
    const { options, preselected } = base({
      sources: { cameraId: CAMERA.id, microphoneId: MIC.id },
      mediaAccess: { ...GRANTED, screen: 'not-determined' },
      devices: [CAMERA, MIC]
    })
    expect(options.map((option) => [option.preset, option.reason])).toEqual([
      ['screen-camera', FIRST_RUN_LOOK_REASONS.screenGrant],
      ['screen-only', FIRST_RUN_LOOK_REASONS.screenGrant],
      ['camera-only', null],
      ['side-by-side', FIRST_RUN_LOOK_REASONS.screenGrant]
    ])
    expect(preselected).toBe('camera-only')
    expect(
      base({
        orientation: 'vertical',
        current: 'vertical-camera-top',
        sources: { cameraId: CAMERA.id },
        mediaAccess: { ...GRANTED, screen: 'denied' },
        devices: [CAMERA, MIC]
      }).preselected
    ).toBe('vertical-camera-only')
  })

  it('no camera found: camera layouts say so; Screen only is preselected', () => {
    const { options, preselected } = base({
      sources: { screenId: SCREEN.id, microphoneId: MIC.id },
      devices: [SCREEN, MIC]
    })
    expect(options.map((option) => [option.preset, option.reason])).toEqual([
      ['screen-camera', FIRST_RUN_LOOK_REASONS.noCamera],
      ['screen-only', null],
      ['camera-only', FIRST_RUN_LOOK_REASONS.noCamera],
      ['side-by-side', FIRST_RUN_LOOK_REASONS.noCamera]
    ])
    expect(preselected).toBe('screen-only')
    expect(
      base({
        orientation: 'vertical',
        current: 'vertical-split',
        sources: { screenId: SCREEN.id },
        devices: [SCREEN, MIC]
      }).preselected
    ).toBe('vertical-screen-only')
  })

  it('a camera found but never asked: camera layouts say to allow it first', () => {
    const { options } = base({
      sources: { screenId: SCREEN.id },
      mediaAccess: { ...GRANTED, camera: 'not-determined' },
      devices: [SCREEN, CAMERA, MIC]
    })
    expect(options.find((option) => option.preset === 'camera-only')?.reason).toBe(
      FIRST_RUN_LOOK_REASONS.cameraGrant
    )
    expect(options.find((option) => option.preset === 'screen-only')?.available).toBe(true)
  })

  it('a camera that is present but turned Off says so (a replay)', () => {
    const { options } = base({
      sources: { screenId: SCREEN.id, cameraOff: true },
      devices: [SCREEN, CAMERA, MIC]
    })
    expect(options.find((option) => option.preset === 'camera-only')?.reason).toBe(
      FIRST_RUN_LOOK_REASONS.cameraOff
    )
    const screenOff = base({ sources: { cameraId: CAMERA.id }, devices: [SCREEN, CAMERA, MIC] })
    expect(screenOff.options.find((option) => option.preset === 'screen-only')?.reason).toBe(
      FIRST_RUN_LOOK_REASONS.screenOff
    )
  })

  it('neither source: every layout disabled, the camera reason first, the current layout kept', () => {
    const { options, preselected } = base({
      sources: {},
      mediaAccess: { camera: 'not-determined', microphone: 'granted', screen: 'not-determined' },
      devices: [MIC]
    })
    expect(options.every((option) => !option.available)).toBe(true)
    expect(options.map((option) => option.reason)).toEqual([
      FIRST_RUN_LOOK_REASONS.cameraGrant,
      FIRST_RUN_LOOK_REASONS.screenGrant,
      FIRST_RUN_LOOK_REASONS.cameraGrant,
      FIRST_RUN_LOOK_REASONS.cameraGrant
    ])
    expect(preselected).toBe('screen-camera')
  })

  it('a chosen device that is gone reads as missing', () => {
    const { options } = base({ devices: [SCREEN, MIC] })
    expect(options.find((option) => option.preset === 'screen-camera')?.reason).toBe(
      FIRST_RUN_LOOK_REASONS.noCamera
    )
  })

  it('a current layout of the other orientation falls back to the orientation’s first layout', () => {
    expect(base({ orientation: 'vertical', current: 'screen-camera' }).preselected).toBe(
      'vertical-camera-top'
    )
  })

  it('before the first device snapshot, nothing is disabled for a missing device (the Studio reconciles later)', () => {
    // sceneSourceGaps reads the devices it is given; an empty snapshot marks
    // chosen sources unavailable, so the step must pass the real list.
    const { options } = base({ devices: [] })
    expect(options.find((option) => option.preset === 'screen-camera')?.available).toBe(false)
  })
})

describe('firstRunLookWritesHeld', () => {
  it('holds only while a backend session runs (the Clips ring in a replay)', () => {
    expect(firstRunLookWritesHeld({ state: 'idle' })).toBe(false)
    expect(firstRunLookWritesHeld({ state: 'failed' })).toBe(false)
    for (const state of ['starting', 'recording', 'streaming', 'stopping']) {
      expect(firstRunLookWritesHeld({ state })).toBe(true)
    }
  })
})

describe('backgroundLibrarySyncDecision', () => {
  it('skips an applied background, holds a new one while setup is open, applies it once the workspace shows', () => {
    expect(backgroundLibrarySyncDecision({ setupOpen: true, fingerprint: 'a', applied: 'a' })).toBe(
      'skip'
    )
    expect(
      backgroundLibrarySyncDecision({ setupOpen: false, fingerprint: 'a', applied: 'a' })
    ).toBe('skip')
    expect(backgroundLibrarySyncDecision({ setupOpen: true, fingerprint: 'b', applied: 'a' })).toBe(
      'hold'
    )
    expect(
      backgroundLibrarySyncDecision({ setupOpen: false, fingerprint: 'b', applied: 'a' })
    ).toBe('apply')
  })
})
