import { describe, expect, it } from 'vitest'

import type { AppPreview, Device } from './backend'
import { defaultCaptureConfig } from './capture'
import {
  addScenesLabel,
  appChoicesFromDevices,
  appChoicesFromPreviews,
  captureChoices,
  lookForAppScenes,
  newAppScenes,
  newCaptureScene,
  searchAppChoices,
  windowCountLabel
} from './scene-app-picker'
import { normalizeSceneVisual, type SavedScene, type SceneVisual } from './scene-presets'

const window = (
  id: string,
  bundleId: string,
  name: string,
  extra: Partial<Device> = {}
): Device => ({
  id,
  name: `${name} - ${id}`,
  windowTitle: id,
  kind: 'window',
  status: 'available',
  width: 1280,
  height: 800,
  app: { bundleId, name, pid: 4 },
  ...extra
})
const look = (layoutPreset: SceneVisual['layout']['layoutPreset'] = 'screen-camera'): SceneVisual =>
  normalizeSceneVisual({
    layout: { ...defaultCaptureConfig.layout, layoutPreset, cameraZoom: 140 },
    sources: { cameraId: 'camera', screenId: 'screen:1', screenName: 'Display 1' },
    background: { assetId: 'builtin-bg-01', fit: 'fill' }
  })
const ids = () => {
  let n = 0
  return { id: () => `scene-${++n}`, now: () => '2026-10-28' }
}

describe("New scene…'s apps without S4 (plan 210 S5)", () => {
  it('groups window sources by app, counts them, and takes the first as front', () => {
    const choices = appChoicesFromDevices([
      window('window:1', 'com.google.Chrome', 'Chrome'),
      window('window:2', 'com.figma.Desktop', 'Figma'),
      window('window:3', 'com.google.Chrome', 'Chrome'),
      window('window:4', 'com.google.Chrome', 'Chrome'),
      { id: 'screen:1', name: 'Display 1', kind: 'screen', status: 'available' }
    ])
    expect(choices).toEqual([
      {
        bundleId: 'com.google.Chrome',
        name: 'Chrome',
        windowCount: 3,
        frontWindowId: 'window:1',
        frontWindowTitle: 'window:1'
      },
      {
        bundleId: 'com.figma.Desktop',
        name: 'Figma',
        windowCount: 1,
        frontWindowId: 'window:2',
        frontWindowTitle: 'window:2'
      }
    ])
  })

  it('never offers Videorc, the Dock, palettes, unavailable windows, the login window or windowless apps', () => {
    const choices = appChoicesFromDevices(
      [
        window('window:1', 'dev.theorcdev.videorc', 'Videorc'),
        window('window:6', 'com.apple.dock', 'Dock'),
        window('window:2', 'com.figma.Desktop', 'Figma', { width: 320, height: 200 }),
        window('window:3', 'com.figma.Desktop', 'Figma', { status: 'unavailable' }),
        window('window:4', 'com.apple.loginwindow', 'loginwindow', { name: 'loginwindow' }),
        { id: 'window:5', name: 'Mystery', kind: 'window', status: 'available' }
      ],
      ['dev.theorcdev.videorc']
    )
    expect(choices).toEqual([])
  })

  it('takes S4 pictures when they come, without Videorc or windowless apps', () => {
    const previews: AppPreview[] = [
      {
        bundleId: 'com.t3.code',
        name: 'T3 Code',
        pid: 1,
        windowCount: 1,
        frontWindowId: 'window:1',
        picture: 'data:image/jpeg;base64,AA'
      },
      { bundleId: 'com.figma.Desktop', name: 'Figma', pid: 2, windowCount: 3 },
      { bundleId: 'dev.theorcdev.videorc', name: 'Videorc', pid: 3, windowCount: 2 },
      { bundleId: 'com.apple.finder', name: 'Finder', pid: 4, windowCount: 0 }
    ]
    expect(
      appChoicesFromPreviews(previews, ['DEV.theorcdev.videorc']).map((app) => [
        app.name,
        app.windowCount,
        Boolean(app.picture)
      ])
    ).toEqual([
      ['Figma', 3, false],
      ['T3 Code', 1, true]
    ])
  })

  it('drops a front window title that only repeats the app name', () => {
    const [choice] = appChoicesFromDevices([
      {
        ...window('window:1', 'com.apple.ActivityMonitor', 'Activity Monitor'),
        windowTitle: 'Activity Monitor'
      }
    ])
    expect(choice?.frontWindowTitle).toBeUndefined()
  })

  it('searches names and front window titles', () => {
    const choices = appChoicesFromDevices([
      window('Inbox', 'com.google.Chrome', 'Chrome'),
      window('Board', 'com.figma.Desktop', 'Figma')
    ])
    expect(searchAppChoices(choices, 'fig').map((app) => app.name)).toEqual(['Figma'])
    expect(searchAppChoices(choices, 'INBOX').map((app) => app.name)).toEqual(['Chrome'])
    expect(searchAppChoices(choices, '  ')).toHaveLength(2)
  })

  it('labels the primary and the window count', () => {
    expect(addScenesLabel(0)).toBe('Add scene')
    expect(addScenesLabel(1)).toBe('Add scene')
    expect(addScenesLabel(2)).toBe('Add 2 scenes')
    expect(windowCountLabel(1)).toBeNull()
    expect(windowCountLabel(3)).toBe('3 windows')
  })
})

describe('the scenes New scene… makes', () => {
  it('names them after their apps through S2, in the current look, following, with no audio', () => {
    const existing: SavedScene[] = newAppScenes(
      [{ bundleId: 'com.figma.Desktop', name: 'Figma', windowCount: 1 }],
      look(),
      [],
      ids()
    )
    const scenes = newAppScenes(
      [
        { bundleId: 'com.t3.code', name: 'T3 Code', windowCount: 1, frontWindowId: 'window:1' },
        {
          bundleId: 'com.figma.Desktop',
          name: 'Figma',
          windowCount: 2,
          frontWindowId: 'window:2',
          frontWindowTitle: 'Board'
        }
      ],
      look(),
      existing,
      ids()
    )
    expect(scenes.map((scene) => scene.name)).toEqual(['T3 Code', 'Figma 2'])
    for (const scene of scenes) {
      expect(scene).not.toHaveProperty('audio')
      expect(scene.visual.layout.cameraZoom).toBe(140)
      expect(scene.visual.layout.layoutPreset).toBe('screen-camera')
      expect(scene.visual.background?.assetId).toBe('builtin-bg-01')
      expect(scene.visual.sources.screenId).toBeUndefined()
      expect(scene.visual.sources.app?.follows).toBe(true)
    }
    expect(scenes[1]!.visual.sources).toMatchObject({ windowId: 'window:2', windowName: 'Board' })
  })

  it('shows the app even when the Studio is on Camera only, and keeps the orientation', () => {
    expect(lookForAppScenes(look('camera-only')).layout.layoutPreset).toBe('screen-camera')
    expect(lookForAppScenes(look('vertical-camera-only')).layout.layoutPreset).toBe(
      'vertical-screen-camera'
    )
    expect(lookForAppScenes(look('vertical-split')).layout.layoutPreset).toBe('vertical-split')
    // A camera layout with the camera off becomes its screen-only twin.
    const cameraOff = look()
    cameraOff.sources = { ...cameraOff.sources, cameraId: undefined, cameraOff: true }
    expect(lookForAppScenes(cameraOff).layout.layoutPreset).toBe('screen-only')
    expect(
      lookForAppScenes({ ...cameraOff, layout: look('camera-only').layout }).layout.layoutPreset
    ).toBe('screen-only')
    const hidden = look()
    hidden.layout.sourceVisibility = { camera: true, capture: false }
    expect(lookForAppScenes(hidden).layout.sourceVisibility?.capture).toBe(true)
  })

  it('makes a display scene on Windows and Linux (D12)', () => {
    const devices: Device[] = [
      { id: 'screen:dxgi:1', name: 'Display 1', kind: 'screen', status: 'available' },
      { id: 'screen:dxgi:2', name: 'Display 2', kind: 'screen', status: 'unavailable' }
    ]
    expect(captureChoices(devices).map((device) => device.id)).toEqual(['screen:dxgi:1'])
    const scene = newCaptureScene(devices[0]!, look(), [], { id: 'd', now: 'now' })
    expect(scene).toMatchObject({ id: 'd', name: 'Display 1' })
    expect(scene).not.toHaveProperty('audio')
    expect(scene.visual.sources).toMatchObject({
      screenId: 'screen:dxgi:1',
      screenName: 'Display 1'
    })
    expect(scene.visual.sources.app).toBeUndefined()
  })
})
