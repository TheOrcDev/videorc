import { describe, expect, it } from 'vitest'

import { sceneSlotAccelerator, type SceneSlotPosition } from '../../../shared/global-shortcuts'
import type { AppPreview, Device, LayoutSettings } from './backend'
import { defaultCaptureConfig } from './capture'
import {
  addScenesLabel,
  appChoicesFromDevices,
  appChoicesFromPreviews,
  displayChoices,
  layoutShowingNoScreen,
  layoutShowingScreen,
  newScenes,
  pickShows,
  sceneShowingPick,
  searchAppChoices,
  showsPick,
  windowChoices,
  windowCountLabel,
  type ScreenPick
} from './scene-app-picker'
import { duplicatedScene } from './scene-list'
import { scenePosition, type Scene } from './scenes'

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
const layout = (
  layoutPreset: LayoutSettings['layoutPreset'],
  extra: Partial<LayoutSettings> = {}
): LayoutSettings => ({
  ...defaultCaptureConfig.layout,
  layoutPreset,
  cameraZoom: 140,
  cameraShape: 'circle',
  ...extra
})
/** The scene on stream: Figma in Screen + camera, Camera top on the vertical leg. */
const onStream = (
  horizontal = layout('screen-camera'),
  vertical = layout('vertical-camera-top')
): Scene => ({
  id: 'figma',
  name: 'Figma',
  createdAt: '2026-11-01',
  updatedAt: '2026-11-01',
  shows: { kind: 'app', bundleId: 'com.figma.Desktop', name: 'Figma', follows: true },
  layouts: { horizontal, vertical },
  background: {
    assetId: 'builtin-bg-01',
    fit: 'fill',
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    blurPx: 0,
    dimPercent: 0,
    saturationPercent: 100,
    vignettePercent: 0,
    visibilityPercent: 20
  }
})
const ids = () => {
  let n = 0
  return { id: () => `scene-${++n}`, now: () => '2026-11-15' }
}
const app = (bundleId: string, name: string, frontWindowId?: string): ScreenPick => ({
  kind: 'app',
  app: { bundleId, name, windowCount: 1, frontWindowId }
})
const display1: Device = {
  id: 'screen:screencapturekit:1',
  name: 'Display 1',
  kind: 'screen',
  status: 'available',
  displayUuid: 'uuid-1'
}
const defaults = ['Screen + camera', 'Screen only', 'Camera only', 'Side by side']

describe('the apps Add scene… offers (plan 210 S5, plan 231 D6)', () => {
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
    expect(addScenesLabel(3)).toBe('Add 3 scenes')
    expect(windowCountLabel(1)).toBeNull()
    expect(windowCountLabel(3)).toBe('3 windows')
  })
})

describe('the scenes Add scene… makes (plan 231 D6)', () => {
  it('names each after what it shows: Figma 2, then Figma 3', () => {
    const existing = [onStream(), ...defaults.map((name) => ({ id: name, name }))]
    const { scenes } = newScenes(
      [
        app('com.figma.Desktop', 'Figma'),
        app('com.figma.Desktop', 'Figma'),
        app('com.t3tools.t3code', 'T3 Code'),
        { kind: 'display', device: display1 },
        { kind: 'none' }
      ],
      onStream(),
      existing,
      { cameraOn: true, ...ids() }
    )
    expect(scenes.map((scene) => scene.name)).toEqual([
      'Figma 2',
      'Figma 3',
      'T3 Code',
      'Display 1',
      'Camera only 2'
    ])
    expect(new Set(scenes.map((scene) => scene.id)).size).toBe(5)
  })

  it('takes the look of the scene on stream, both layouts and the background, with no audio', () => {
    const template = { ...onStream(), audio: { microphoneOff: true, systemAudioEnabled: false } }
    const { scenes, windowHints } = newScenes(
      [app('com.t3tools.t3code', 'T3 Code', 'window:9')],
      template,
      [],
      { cameraOn: true, ...ids() }
    )
    const [scene] = scenes
    expect(scene).toMatchObject({
      id: 'scene-1',
      createdAt: '2026-11-15',
      shows: { kind: 'app', bundleId: 'com.t3tools.t3code', name: 'T3 Code', follows: true },
      background: { assetId: 'builtin-bg-01' }
    })
    expect(scene).not.toHaveProperty('audio')
    expect(scene!.layouts.horizontal).toMatchObject({
      layoutPreset: 'screen-camera',
      cameraZoom: 140,
      cameraShape: 'circle'
    })
    expect(scene!.layouts.vertical).toMatchObject({
      layoutPreset: 'vertical-camera-top',
      cameraShape: 'circle'
    })
    // The picker's front window is where the app's scene looks first.
    expect(windowHints).toEqual({ 'scene-1': 'window:9' })
    // A copy: the scene on stream isn't edited through it.
    scene!.layouts.horizontal.cameraZoom = 99
    expect(template.layouts.horizontal.cameraZoom).toBe(140)
  })

  it('shows the screen even when the scene on stream is Camera only', () => {
    const cameraOnly = onStream(layout('camera-only'), layout('vertical-camera-only'))
    const { scenes } = newScenes([{ kind: 'display', device: display1 }], cameraOnly, [], {
      cameraOn: true,
      ...ids()
    })
    expect(scenes[0]!.shows).toEqual({
      kind: 'display',
      screenId: display1.id,
      screenName: 'Display 1',
      screenUuid: 'uuid-1'
    })
    expect(scenes[0]!.layouts.horizontal.layoutPreset).toBe('screen-camera')
    expect(scenes[0]!.layouts.vertical.layoutPreset).toBe('vertical-screen-camera')
    // With the camera off, a camera layout becomes its screen-only twin.
    expect(layoutShowingScreen(layout('screen-camera'), false).layoutPreset).toBe('screen-only')
    expect(layoutShowingScreen(layout('vertical-split'), true).layoutPreset).toBe('vertical-split')
    const hidden = layoutShowingScreen(
      layout('screen-only', { sourceVisibility: { camera: true, capture: false } }),
      true
    )
    expect(hidden.sourceVisibility).toEqual({ camera: true, capture: true })
  })

  it('makes Camera only show no screen in both orientations (D18)', () => {
    const { scenes } = newScenes([{ kind: 'none' }], onStream(), [], {
      cameraOn: true,
      ...ids()
    })
    expect(scenes[0]).toMatchObject({ name: 'Camera only', shows: { kind: 'none' } })
    expect(scenes[0]!.layouts.horizontal).toMatchObject({
      layoutPreset: 'camera-only',
      arrangementMode: 'preset',
      cameraShape: 'circle'
    })
    expect(scenes[0]!.layouts.vertical.layoutPreset).toBe('vertical-camera-only')
    expect(layoutShowingNoScreen(layout('camera-only')).layoutPreset).toBe('camera-only')
  })

  it('lands at the end, each with the next position key; the tenth has none (D5)', () => {
    const library = [onStream(), ...defaults.map((name) => ({ ...onStream(), id: name, name }))]
    const { scenes } = newScenes(
      [
        app('com.t3tools.t3code', 'T3 Code'),
        app('com.google.Chrome', 'Chrome'),
        { kind: 'display', device: display1 },
        { kind: 'none' },
        app('com.apple.Safari', 'Safari')
      ],
      onStream(),
      library,
      { cameraOn: true, ...ids() }
    )
    // The library hook appends them (use-scenes `insert`, at the end).
    const after = [...library, ...scenes]
    expect(after.slice(0, library.length)).toEqual(library)
    expect(scenes.map((scene) => scenePosition(after, scene.id))).toEqual([6, 7, 8, 9, 10])
    expect(
      scenes.map((scene) => {
        const position = scenePosition(after, scene.id)!
        return position <= 9
          ? sceneSlotAccelerator({}, position as SceneSlotPosition, 'darwin')
          : null
      })
    ).toEqual(['Control+Alt+6', 'Control+Alt+7', 'Control+Alt+8', 'Control+Alt+9', null])
  })

  it('offers displays by platform, and windows by app for A specific window', () => {
    const devices: Device[] = [
      display1,
      { id: 'screen:screencapturekit:2', name: 'Display 2', kind: 'screen', status: 'unavailable' },
      window('window:2', 'com.google.Chrome', 'Chrome', { windowTitle: 'Inbox' }),
      window('window:1', 'com.figma.Desktop', 'Figma', { windowTitle: 'Board' }),
      window('window:3', 'dev.theorcdev.videorc', 'Videorc', { windowTitle: 'Notes' }),
      window('window:4', 'com.figma.Desktop', 'Figma', { width: 200, height: 120 })
    ]
    expect(displayChoices(devices, 'darwin').map(({ device }) => device.id)).toEqual([
      'screen:screencapturekit:1'
    ])
    expect(
      windowChoices(devices, ['dev.theorcdev.videorc']).map((device) => device.windowTitle)
    ).toEqual(['Inbox', 'Board'])
    const windows: Device[] = [
      { id: 'screen:dxgi:1', name: 'Display 1', kind: 'screen', status: 'available' },
      { id: 'screen:dxgi:2', name: 'Display 2', kind: 'screen', status: 'unavailable' }
    ]
    expect(displayChoices(windows, 'win32').map(({ device }) => device.id)).toEqual([
      'screen:dxgi:1'
    ])
  })
})

describe('Change screen… (plan 231 D6)', () => {
  it('changes only what the scene shows, and an app-named scene takes the new name', () => {
    const scene = onStream()
    const scenes = [scene, { id: 'chrome', name: 'Chrome' }]
    const next = sceneShowingPick(scene, app('com.google.Chrome', 'Chrome'), scenes, 'now')
    expect(next).toMatchObject({
      id: 'figma',
      name: 'Chrome 2',
      updatedAt: 'now',
      shows: { kind: 'app', bundleId: 'com.google.Chrome', name: 'Chrome', follows: true }
    })
    expect(next.layouts).toEqual(scene.layouts)
    expect(next.background).toEqual(scene.background)
    // A name the streamer typed stays.
    expect(
      sceneShowingPick(
        { ...scene, name: 'Design' },
        { kind: 'display', device: display1 },
        [],
        'now'
      ).name
    ).toBe('Design')
  })

  it('keeps one window with A specific window, and the app scene’s following', () => {
    const scene = {
      ...onStream(),
      shows: { ...onStream().shows, follows: false } as Scene['shows']
    }
    const board = window('window:1', 'com.figma.Desktop', 'Figma', { windowTitle: 'Board' })
    const fixed = sceneShowingPick(scene, { kind: 'window', device: board }, [scene], 'now')
    expect(fixed.shows).toEqual({ kind: 'window', windowId: 'window:1', windowName: board.name })
    expect(fixed.name).toBe('Figma')
    const back = sceneShowingPick(fixed, app('com.figma.Desktop', 'Figma'), [fixed], 'now')
    expect(back.shows).toMatchObject({ kind: 'app', follows: true })
    expect(
      sceneShowingPick(scene, app('com.google.Chrome', 'Chrome'), [scene], 'now').shows
    ).toMatchObject({ follows: false })
  })

  it('No screen puts the scene on Camera only in both orientations (D19)', () => {
    const scene = onStream()
    const none = sceneShowingPick(scene, { kind: 'none' }, [scene], 'now')
    expect(none.shows).toEqual({ kind: 'none' })
    expect(none.name).toBe('Camera only')
    expect(none.layouts.horizontal).toMatchObject({
      layoutPreset: 'camera-only',
      cameraShape: 'circle'
    })
    expect(none.layouts.vertical.layoutPreset).toBe('vertical-camera-only')
  })

  it('keeps a default scene’s layout name when it takes a screen (D3, D19)', () => {
    const cameraOnly = {
      ...onStream(layout('camera-only'), layout('vertical-camera-only')),
      id: 'default-camera-only',
      name: 'Camera only',
      shows: { kind: 'none' } as const
    }
    const withScreen = sceneShowingPick(
      cameraOnly,
      { kind: 'display', device: display1 },
      [cameraOnly],
      'now'
    )
    expect(withScreen.name).toBe('Camera only')
    expect(withScreen.shows).toMatchObject({ kind: 'display', screenName: 'Display 1' })
    // Its layouts stay: the Layout field (or D19) puts a screen layout on.
    expect(withScreen.layouts).toEqual(cameraOnly.layouts)
  })

  it('knows what the scene shows already', () => {
    const scene = onStream()
    expect(showsPick(scene.shows, app('com.figma.Desktop', 'Figma'))).toBe(true)
    expect(showsPick(scene.shows, app('com.google.Chrome', 'Chrome'))).toBe(false)
    expect(showsPick({ kind: 'none' }, { kind: 'none' })).toBe(true)
    expect(pickShows({ kind: 'display', device: display1 })).toMatchObject({
      screenUuid: 'uuid-1'
    })
  })
})

describe('Duplicate (plan 231 D6)', () => {
  it('copies both layouts, the screen and the audio under a new name, for the end', () => {
    const scene = { ...onStream(), audio: { microphoneOff: true, systemAudioEnabled: true } }
    const copy = duplicatedScene(scene, [scene], { id: 'copy', now: 'now' })
    expect(copy).toEqual({
      ...scene,
      id: 'copy',
      name: 'Figma 2',
      createdAt: 'now',
      updatedAt: 'now'
    })
    copy.layouts.horizontal.cameraZoom = 1
    expect(scene.layouts.horizontal.cameraZoom).toBe(140)
  })
})
