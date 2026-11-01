import { describe, expect, it } from 'vitest'

import type { Device } from './backend'
import { defaultCaptureConfig } from './capture'
import {
  duplicatedScene,
  movedScenes,
  saveSceneBlockedReason,
  savedSceneBlockedReason,
  sceneGlyph,
  sceneListActive,
  sceneMoveKeyStep,
  sceneShows,
  sceneWithApp,
  sceneWithAudio,
  sceneWithFollow,
  suggestedSceneName,
  uniqueSceneName
} from './scene-list'
import { normalizeSceneVisual, type SavedScene, type VisualSources } from './scene-presets'

const scene = (
  id: string,
  name: string,
  sources: VisualSources = { screenId: 'screen:1', screenName: 'Display 1' },
  layoutPreset: SavedScene['visual']['layout']['layoutPreset'] = 'screen-camera'
): SavedScene => ({
  id,
  name,
  createdAt: '2026-10-28',
  updatedAt: '2026-10-28',
  visual: normalizeSceneVisual({
    layout: { ...defaultCaptureConfig.layout, layoutPreset },
    sources: { cameraId: 'camera', ...sources },
    background: null
  })
})
const figmaApp = { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
const figma = () => scene('figma', 'Figma', { windowId: 'window:7', app: figmaApp })
const camera: Device = { id: 'camera', name: 'FaceTime', kind: 'camera', status: 'available' }
const window = (id: string, bundleId: string, name: string): Device => ({
  id,
  name: `${name} - Untitled`,
  kind: 'window',
  status: 'available',
  app: { bundleId, name, pid: 4 }
})

describe('the scene list (plan 210 D6)', () => {
  it('marks a saved scene, a plain layout, or the unsaved scene as on stream', () => {
    const layout = { layoutPreset: 'screen-only' as const, arrangementMode: 'preset' as const }
    expect(sceneListActive({ activeSavedSceneId: 'figma', origin: 'saved', layout })).toEqual({
      kind: 'saved',
      id: 'figma'
    })
    expect(sceneListActive({ activeSavedSceneId: null, origin: 'builtin', layout })).toEqual({
      kind: 'layout',
      preset: 'screen-only'
    })
    // A saved scene left by choosing another window (D3) is unsaved.
    expect(sceneListActive({ activeSavedSceneId: null, origin: 'saved', layout })).toEqual({
      kind: 'unsaved'
    })
    expect(
      sceneListActive({
        activeSavedSceneId: null,
        origin: 'builtin',
        layout: { ...layout, arrangementMode: 'freeform' }
      })
    ).toEqual({ kind: 'unsaved' })
  })

  it('moves one scene, and refuses a move that goes nowhere', () => {
    const scenes = [scene('a', 'A'), scene('b', 'B'), scene('c', 'C')]
    expect(movedScenes(scenes, 'c', 0)?.map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
    expect(movedScenes(scenes, 'a', 2)?.map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
    expect(movedScenes(scenes, 'a', 0)).toBeNull()
    expect(movedScenes(scenes, 'a', 3)).toBeNull()
    expect(movedScenes(scenes, 'a', -1)).toBeNull()
    expect(movedScenes(scenes, 'missing', 1)).toBeNull()
  })

  it('moves a focused row with ⌥↑ and ⌥↓ alone', () => {
    const key = (key: string, extra = {}) =>
      sceneMoveKeyStep({
        key,
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...extra
      })
    expect(key('ArrowUp')).toBe(-1)
    expect(key('ArrowDown')).toBe(1)
    expect(key('ArrowLeft')).toBeNull()
    expect(key('ArrowUp', { altKey: false })).toBeNull()
    expect(key('ArrowUp', { shiftKey: true })).toBeNull()
    expect(key('ArrowDown', { metaKey: true })).toBeNull()
  })

  it('says what each scene shows', () => {
    expect(sceneShows(figma())).toBe('Figma · front window')
    expect(sceneShows(scene('w', 'W', { windowId: 'window:1', windowName: 'Notes - Ideas' }))).toBe(
      'Window · Notes - Ideas'
    )
    expect(sceneShows(scene('d', 'D'))).toBe('Display 1')
    expect(sceneShows(scene('c', 'C', {}, 'camera-only'))).toBe('Camera only')
    expect(sceneShows(scene('n', 'N', { captureOff: true }))).toBe('No screen')
  })

  it('draws the app icon for app scenes and fixed windows the device list knows', () => {
    const devices = [window('window:1', 'com.apple.Notes', 'Notes')]
    expect(sceneGlyph(figma(), [])).toEqual({ kind: 'app', bundleId: 'com.figma.Desktop' })
    expect(sceneGlyph(scene('w', 'W', { windowId: 'window:1' }), devices)).toEqual({
      kind: 'app',
      bundleId: 'com.apple.Notes'
    })
    expect(sceneGlyph(scene('w', 'W', { windowId: 'window:9' }), devices)).toEqual({
      kind: 'window'
    })
    expect(sceneGlyph(scene('d', 'D'), devices)).toEqual({ kind: 'display' })
    expect(sceneGlyph(scene('c', 'C', {}, 'camera-only'), devices)).toEqual({ kind: 'camera' })
  })

  it("disables a scene whose app isn't ready, in S2's words, and the other orientation live", () => {
    const blocked = (appState: Parameters<typeof savedSceneBlockedReason>[0]['appState']) =>
      savedSceneBlockedReason({
        scene: figma(),
        appState,
        sessionActive: false,
        orientation: 'horizontal',
        devices: [camera]
      })
    expect(blocked('ready')).toBeNull()
    expect(blocked(undefined)).toBeNull()
    expect(blocked('not-running')).toBe("Figma isn't open")
    expect(blocked('no-window')).toBe('Figma has no window open')
    expect(blocked('minimized')).toBe("Figma's window is minimized")
    const vertical = scene('v', 'V', {}, 'vertical-screen-camera')
    expect(
      savedSceneBlockedReason({
        scene: vertical,
        appState: undefined,
        sessionActive: true,
        orientation: 'horizontal',
        devices: [camera]
      })
    ).toBe('Stop the recording or stream before switching orientation.')
    expect(
      savedSceneBlockedReason({
        scene: vertical,
        appState: undefined,
        sessionActive: false,
        orientation: 'horizontal',
        devices: [camera]
      })
    ).toBeNull()
    // An app's scene can't ask to resolve its sources: a camera it can't use says so.
    expect(
      savedSceneBlockedReason({
        scene: figma(),
        appState: 'ready',
        sessionActive: false,
        orientation: 'horizontal',
        devices: []
      })
    ).toBe('Camera unavailable. Choose a replacement in Sources.')
  })

  it('names a scene uniquely and suggests the name of what it shows', () => {
    const scenes = [scene('a', 'Figma'), scene('b', 'figma 2')]
    expect(uniqueSceneName('Figma', scenes)).toBe('Figma 3')
    expect(uniqueSceneName('Figma', scenes, 'a')).toBe('Figma')
    expect(uniqueSceneName('  ', [])).toBe('Scene')
    expect(uniqueSceneName('x'.repeat(90), [scene('a', 'x'.repeat(80))])).toBe(
      `${'x'.repeat(78)} 2`
    )
    const devices = [window('window:1', 'com.apple.Notes', 'Notes')]
    expect(suggestedSceneName(scene('w', 'W', { windowId: 'window:1' }).visual, devices, [])).toBe(
      'Notes'
    )
    expect(suggestedSceneName(scene('d', 'D').visual, [], [scene('a', 'Display 1')])).toBe(
      'Display 1 2'
    )
    expect(suggestedSceneName(scene('c', 'C', {}, 'camera-only').visual, [], [])).toBe(
      'Camera only'
    )
  })

  it('duplicates the look, sources and audio under a new id and name', () => {
    const original = { ...figma(), audio: sceneWithAudio(figma(), audio, 'now').audio }
    const copy = duplicatedScene(original, [original], { id: 'copy', now: 'later' })
    expect(copy).toMatchObject({ id: 'copy', name: 'Figma 2', createdAt: 'later' })
    expect(copy.visual).toEqual(original.visual)
    expect(copy.audio).toEqual(original.audio)
    copy.visual.layout.cameraZoom = 180
    expect(original.visual.layout.cameraZoom).not.toBe(180)
  })

  it('reports why Save scene… is off', () => {
    expect(saveSceneBlockedReason({ readOnly: false, connected: true, canSave: true })).toBeNull()
    expect(saveSceneBlockedReason({ readOnly: true, connected: true, canSave: false })).toBe(
      'Update Videorc to save scenes. Your saved scenes are kept.'
    )
    expect(saveSceneBlockedReason({ readOnly: false, connected: false, canSave: false })).toBe(
      'Videorc is reconnecting. Try again in a moment.'
    )
    expect(saveSceneBlockedReason({ readOnly: false, connected: true, canSave: false })).toBe(
      'Wait for the scene to finish changing.'
    )
  })
})

const audio = {
  microphoneId: 'mic',
  microphoneName: 'Shure',
  microphoneOff: false,
  systemAudioEnabled: true
}

describe('the ⋯ edits', () => {
  it('Change app… keeps the look, audio and following; renames an app-named scene', () => {
    const original = { ...sceneWithFollow(figma(), false, 'now'), audio }
    const sketch = {
      bundleId: 'com.bohemiancoding.sketch3',
      name: 'Sketch',
      frontWindowId: 'window:9'
    }
    const changed = sceneWithApp(original, sketch, [original], 'later')
    expect(changed.name).toBe('Sketch')
    expect(changed.audio).toEqual(audio)
    expect(changed.visual.layout).toEqual(original.visual.layout)
    expect(changed.visual.sources).toMatchObject({
      windowId: 'window:9',
      app: { bundleId: sketch.bundleId, name: 'Sketch', follows: false }
    })
    const named = { ...figma(), name: 'Design review' }
    expect(sceneWithApp(named, sketch, [named], 'later').name).toBe('Design review')
    const second = { ...figma(), name: 'Figma 2' }
    expect(sceneWithApp(second, sketch, [second, scene('s', 'Sketch')], 'later').name).toBe(
      'Sketch 2'
    )
  })

  it('turns following off and on only for scenes made for an app', () => {
    expect(sceneWithFollow(figma(), false, 'now').visual.sources.app?.follows).toBe(false)
    const display = scene('d', 'D')
    expect(sceneWithFollow(display, true, 'now')).toBe(display)
  })

  it('Save audio to scene writes the microphone and System audio', () => {
    expect(
      sceneWithAudio(figma(), { ...audio, microphoneId: undefined, microphoneOff: true }, 'now')
        .audio
    ).toEqual({
      microphoneId: undefined,
      microphoneName: 'Shure',
      microphoneOff: true,
      systemAudioEnabled: true
    })
  })
})
