import { describe, expect, it, vi } from 'vitest'
import type { Device } from './backend'
import { defaultCaptureConfig } from './capture'
import { judgeSceneSources, runSavedScenePreflight } from './scene-apply-preflight'
import type { SceneVisual } from './scene-presets'

const camera: Device = { id: 'camera:c1', name: 'FaceTime', kind: 'camera', status: 'available' }
const windowDevice: Device = {
  id: 'window:screencapturekit:41',
  name: 'Figma - Design',
  kind: 'window',
  status: 'available'
}
const app = { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }

const screenOnly = (windowId = windowDevice.id): SceneVisual => ({
  layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
  sources: { windowId },
  background: null
})
const screenCamera = (): SceneVisual => ({
  layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-camera' },
  sources: { windowId: windowDevice.id, cameraId: camera.id },
  background: null
})

describe('saved scene preflight against the held device list (plan 210 S3)', () => {
  it('proves a scene whose sources are in the held list without any list call', () => {
    expect(judgeSceneSources(screenCamera(), [camera, windowDevice])).toEqual({ kind: 'proven' })
  })

  it('refuses a source turned off on purpose at once, with the strict copy', () => {
    const visual: SceneVisual = {
      ...screenCamera(),
      sources: { windowId: windowDevice.id, cameraOff: true }
    }
    expect(judgeSceneSources(visual, [camera, windowDevice])).toEqual({
      kind: 'refused',
      issues: ['Camera is off. Turn it on in Sources to use this scene.']
    })
  })

  it('asks for one fresh list only when a chosen source is missing from the held list', () => {
    expect(
      judgeSceneSources(screenOnly('window:screencapturekit:99'), [camera, windowDevice])
    ).toEqual({
      kind: 'refetch',
      missing: ['screen']
    })
  })

  it("takes the resolver's word for an app scene's window instead of the held list", () => {
    // The resolver found a window the held list predates: proven, no refetch.
    expect(judgeSceneSources(screenOnly('window:screencapturekit:99'), [camera], app)).toEqual({
      kind: 'proven'
    })
  })
})

describe('runSavedScenePreflight', () => {
  it('runs the background check beside the device judgement and never lists devices when proven', async () => {
    const listDevices = vi.fn(async () => [] as Device[])
    const backgroundExists = vi.fn(async () => true)
    const result = await runSavedScenePreflight({
      visual: screenCamera(),
      devices: [camera, windowDevice],
      listDevices,
      backgroundExists
    })
    expect(result).toEqual({ issues: [], refetched: false })
    expect(listDevices).not.toHaveBeenCalled()
    expect(backgroundExists).toHaveBeenCalledTimes(1)
  })

  it('refetches once for a source missing from the held list and accepts it when the fresh list has it', async () => {
    const listDevices = vi.fn(async () => [camera, windowDevice])
    const result = await runSavedScenePreflight({
      visual: screenCamera(),
      devices: [camera],
      listDevices,
      backgroundExists: null
    })
    expect(result).toEqual({ issues: [], refetched: true })
    expect(listDevices).toHaveBeenCalledTimes(1)
  })

  it('refuses with the strict copy when the fresh list still lacks the source', async () => {
    const result = await runSavedScenePreflight({
      visual: screenCamera(),
      devices: [camera],
      listDevices: async () => [camera],
      backgroundExists: null
    })
    expect(result).toEqual({
      issues: ['Screen or window unavailable. Choose a replacement in Sources.'],
      refetched: true
    })
  })

  it('refuses a missing background without waiting for a refetch and keeps both reasons', async () => {
    const result = await runSavedScenePreflight({
      visual: screenCamera(),
      devices: [camera],
      listDevices: async () => [camera],
      backgroundExists: async () => false
    })
    expect(result.issues).toEqual([
      'Screen or window unavailable. Choose a replacement in Sources.',
      'Saved background unavailable. Resolve it or apply without background.'
    ])
  })

  it('treats a failed background IPC as an unavailable background', async () => {
    const result = await runSavedScenePreflight({
      visual: screenCamera(),
      devices: [camera, windowDevice],
      listDevices: async () => [],
      backgroundExists: async () => {
        throw new Error('ipc down')
      }
    })
    expect(result.issues).toEqual([
      'Saved background unavailable. Resolve it or apply without background.'
    ])
  })
})
