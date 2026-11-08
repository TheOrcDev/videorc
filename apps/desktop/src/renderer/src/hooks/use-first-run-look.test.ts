import { describe, expect, it, vi } from 'vitest'

import type { Device, MediaAccessSnapshot } from '@/lib/backend'
import { applyLiveBackground, createDefaultRegistry } from '@/lib/background-assets'
import { defaultCaptureConfig, type CaptureConfig } from '@/lib/capture'
import type { FirstRunLook } from '@/lib/first-run-look'

import { firstRunLookController, firstRunLookFromState } from './use-first-run-look'

const SCREEN: Device = { id: 'screen:1', name: 'Display', kind: 'screen', status: 'available' }
const CAMERA: Device = { id: 'cam-1', name: 'Camera', kind: 'camera', status: 'available' }
const GRANTED: MediaAccessSnapshot = { camera: 'granted', microphone: 'granted', screen: 'granted' }

function controller(
  overrides: {
    config?: Partial<CaptureConfig>
    hold?: FirstRunLook | null
    devices?: Device[]
    mediaAccess?: MediaAccessSnapshot | null
    registry?: ReturnType<typeof createDefaultRegistry>
  } = {}
) {
  const apply = vi.fn<(look: FirstRunLook) => void>()
  const value = firstRunLookController({
    config: {
      ...defaultCaptureConfig,
      sources: { screenId: SCREEN.id, cameraId: CAMERA.id },
      ...overrides.config
    },
    registry: overrides.registry ?? createDefaultRegistry(),
    hold: overrides.hold ?? null,
    mediaAccess: overrides.mediaAccess === undefined ? GRANTED : overrides.mediaAccess,
    devices: overrides.devices ?? [SCREEN, CAMERA],
    apply
  })
  return { value, apply }
}

describe('firstRunLookFromState', () => {
  it('reads the Studio’s layout, shape and live background', () => {
    expect(
      firstRunLookFromState(
        defaultCaptureConfig,
        applyLiveBackground(createDefaultRegistry(), 'silk')
      )
    ).toEqual({
      orientation: 'horizontal',
      layoutPreset: 'screen-camera',
      cameraShape: 'rectangle',
      liveBackgroundId: 'silk'
    })
    expect(
      firstRunLookFromState(defaultCaptureConfig, {
        ...createDefaultRegistry(),
        activeSlotId: 'slot-1'
      }).liveBackgroundId
    ).toBeNull()
  })
})

describe('firstRunLookController', () => {
  it('shows the fresh Studio: horizontal Screen + camera, rectangle, None, shape applies, not held', () => {
    const { value } = controller()
    expect(value.orientation).toBe('horizontal')
    expect(value.layoutPreset).toBe('screen-camera')
    expect(value.cameraShape).toBe('rectangle')
    expect(value.liveBackgroundId).toBeNull()
    expect(value.shapeApplies).toBe(true)
    expect(value.held).toBe(false)
    expect(value.preselected).toBe('screen-camera')
    expect(value.options).toHaveLength(4)
  })

  it('setLayout applies the preset with its orientation and keeps shape and background', () => {
    const { value, apply } = controller({
      registry: applyLiveBackground(createDefaultRegistry(), 'beams')
    })
    value.setLayout('camera-only')
    expect(apply).toHaveBeenCalledWith({
      orientation: 'horizontal',
      layoutPreset: 'camera-only',
      cameraShape: 'rectangle',
      liveBackgroundId: 'beams'
    })
    value.setLayout('screen-camera')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('setOrientation lands on the scene remembered for that orientation when it works', () => {
    const { value, apply } = controller({ config: { lastVerticalPreset: 'vertical-split' } })
    value.setOrientation('vertical')
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ orientation: 'vertical', layoutPreset: 'vertical-split' })
    )
    value.setOrientation('horizontal')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('setOrientation without a screen lands on vertical Camera only', () => {
    const { value, apply } = controller({
      config: { sources: { cameraId: CAMERA.id } },
      devices: [CAMERA],
      mediaAccess: { ...GRANTED, screen: 'not-determined' }
    })
    expect(value.preselected).toBe('camera-only')
    value.setOrientation('vertical')
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ orientation: 'vertical', layoutPreset: 'vertical-camera-only' })
    )
  })

  it('setShape and setBackground change one field each and skip no-ops', () => {
    const { value, apply } = controller()
    value.setShape('rounded')
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ cameraShape: 'rounded' }))
    value.setShape('rectangle')
    value.setBackground('liquid-chrome')
    expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ liveBackgroundId: 'liquid-chrome', cameraShape: 'rectangle' })
    )
    value.setBackground(null)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('a held look wins over the Studio’s state and reads as held', () => {
    const hold: FirstRunLook = {
      orientation: 'vertical',
      layoutPreset: 'vertical-screen-camera',
      cameraShape: 'circle',
      liveBackgroundId: 'dither'
    }
    const { value, apply } = controller({ hold })
    expect(value.held).toBe(true)
    expect(value.orientation).toBe('vertical')
    expect(value.layoutPreset).toBe('vertical-screen-camera')
    expect(value.cameraShape).toBe('circle')
    expect(value.liveBackgroundId).toBe('dither')
    expect(value.shapeApplies).toBe(true)
    value.setBackground(null)
    expect(apply).toHaveBeenCalledWith({ ...hold, liveBackgroundId: null })
  })

  it('shape does not apply on Camera only', () => {
    const { value } = controller({
      config: { layout: { ...defaultCaptureConfig.layout, layoutPreset: 'camera-only' } }
    })
    expect(value.shapeApplies).toBe(false)
  })
})
