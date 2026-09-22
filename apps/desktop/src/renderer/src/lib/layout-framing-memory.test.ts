import { describe, expect, it } from 'vitest'
import { defaultCaptureConfig } from './capture'
import { LAYOUT_PRESET_VALUES } from './backend'
import {
  BUILTIN_LAYOUTS,
  normalizeLayoutFramingMemory,
  recalledLayoutFraming,
  rememberLayoutFraming
} from './layout-framing-memory'

describe('layout framing memory', () => {
  it('migrates only the current layout and defaults every other canonical layout', () => {
    const current = {
      ...defaultCaptureConfig.layout,
      cameraZoom: 150,
      cameraOffsetX: -25,
      cameraOffsetY: 30
    }
    const memory = normalizeLayoutFramingMemory(null, current)
    expect(BUILTIN_LAYOUTS.map(({ id }) => id)).toEqual(LAYOUT_PRESET_VALUES)
    expect(memory.layouts['screen-camera']).toEqual({
      cameraZoom: 150,
      cameraOffsetX: -25,
      cameraOffsetY: 30
    })
    for (const id of LAYOUT_PRESET_VALUES.filter((id) => id !== 'screen-camera'))
      expect(memory.layouts[id]).toEqual({ cameraZoom: 100, cameraOffsetX: 0, cameraOffsetY: 0 })
    expect(normalizeLayoutFramingMemory(JSON.parse(JSON.stringify(memory)), current)).toEqual(
      memory
    )
  })
  it('remembers committed camera framing independently and does not replace same-layout edits', () => {
    let memory = normalizeLayoutFramingMemory(null)
    memory = rememberLayoutFraming(memory, { ...defaultCaptureConfig.layout, cameraZoom: 150 })
    expect(recalledLayoutFraming(memory, 'screen-camera', 'camera-only')).toEqual({
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0
    })
    expect(recalledLayoutFraming(memory, 'camera-only', 'screen-camera').cameraZoom).toBe(150)
    expect(recalledLayoutFraming(memory, 'screen-camera', 'screen-camera')).toEqual({})
  })
  it('clamps malformed storage without sharing framing objects between layouts', () => {
    const memory = normalizeLayoutFramingMemory({
      version: 1,
      layouts: { 'camera-only': { cameraZoom: 400, cameraOffsetX: NaN, cameraOffsetY: -500 } }
    })
    expect(memory.layouts['camera-only']).toEqual({
      cameraZoom: 200,
      cameraOffsetX: 0,
      cameraOffsetY: -100
    })
    memory.layouts['screen-only'].cameraZoom = 155
    expect(memory.layouts['vertical-screen-only'].cameraZoom).toBe(100)
  })
})
