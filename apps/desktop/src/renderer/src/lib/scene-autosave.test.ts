import { describe, expect, it } from 'vitest'

import { defaultCaptureConfig } from './capture'
import { capturePickLeavesScene, sceneAutosave } from './scene-autosave'
import { normalizeSceneVisual, type SavedScene, type SceneVisual } from './scene-presets'

const visual = (overrides: Partial<SceneVisual['layout']> = {}, sources = {}): SceneVisual =>
  normalizeSceneVisual({
    layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-camera', ...overrides },
    sources: { cameraId: 'camera', windowId: 'window:figma', windowName: 'Figma', ...sources },
    background: null
  })
const figma = (): SavedScene => ({
  id: 'figma',
  name: 'Figma',
  createdAt: '2026-10-28',
  updatedAt: '2026-10-28',
  visual: visual(
    {},
    {
      windowId: 'window:figma',
      app: { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
    }
  ),
  audio: {
    microphoneId: 'mic',
    microphoneName: 'Shure',
    microphoneOff: false,
    systemAudioEnabled: true
  }
})
const now = '2026-10-29T10:00:00.000Z'

describe('sceneAutosave (plan 210 D3)', () => {
  it('writes the look of an edit made while the scene is on, never its sources or audio', () => {
    const scene = figma()
    const edited = visual({ cameraZoom: 150, cameraShape: 'circle' }, { windowId: 'window:other' })
    const written = sceneAutosave({
      previousSceneId: 'figma',
      sceneId: 'figma',
      scenes: [scene],
      visual: edited,
      now
    })
    expect(written?.visual.layout.cameraZoom).toBe(150)
    expect(written?.visual.layout.cameraShape).toBe('circle')
    // What the scene shows stays its own: the app, not the window on screen.
    expect(written?.visual.sources).toEqual(scene.visual.sources)
    expect(written?.audio).toEqual(scene.audio)
    expect(written?.updatedAt).toBe(now)
    expect(written?.createdAt).toBe(scene.createdAt)
  })

  it('writes a background edit and an undo like any other commit', () => {
    const scene = figma()
    const withBackground = normalizeSceneVisual({
      ...scene.visual,
      background: { assetId: 'builtin-bg-01', fit: 'fill' }
    })
    const saved = sceneAutosave({
      previousSceneId: 'figma',
      sceneId: 'figma',
      scenes: [scene],
      visual: withBackground,
      now
    })
    expect(saved?.visual.background?.assetId).toBe('builtin-bg-01')
    // The undo back to no background is one more commit while it is on.
    const undone = sceneAutosave({
      previousSceneId: 'figma',
      sceneId: 'figma',
      scenes: [saved!],
      visual: scene.visual,
      now
    })
    expect(undone?.visual.background).toBeNull()
  })

  it('never writes on the commit that puts the scene on stream', () => {
    // An undo back into a scene carries the outgoing scene's background: a
    // switch is not an edit.
    expect(
      sceneAutosave({
        previousSceneId: 't3',
        sceneId: 'figma',
        scenes: [figma()],
        visual: visual({ cameraZoom: 175 }),
        now
      })
    ).toBeNull()
    expect(
      sceneAutosave({
        previousSceneId: null,
        sceneId: 'figma',
        scenes: [figma()],
        visual: visual({ cameraZoom: 175 }),
        now
      })
    ).toBeNull()
  })

  it('never saves a built-in layout, a deleted scene or an unchanged look', () => {
    expect(
      sceneAutosave({
        previousSceneId: null,
        sceneId: null,
        scenes: [figma()],
        visual: visual({ cameraZoom: 175 }),
        now
      })
    ).toBeNull()
    expect(
      sceneAutosave({
        previousSceneId: 'gone',
        sceneId: 'gone',
        scenes: [figma()],
        visual: visual(),
        now
      })
    ).toBeNull()
    const scene = figma()
    expect(
      sceneAutosave({
        previousSceneId: 'figma',
        sceneId: 'figma',
        scenes: [scene],
        // Another window of the same look: sources never count as a change.
        visual: { ...scene.visual, sources: { ...scene.visual.sources, windowId: 'window:2' } },
        now
      })
    ).toBeNull()
  })
})

describe('capturePickLeavesScene (plan 210 D3)', () => {
  it('leaves for another screen or window, and stays for the same one', () => {
    const current = { screenId: 'screen:1', captureOff: false, testPattern: false }
    expect(capturePickLeavesScene(current, { screenId: 'screen:2' })).toBe(true)
    expect(capturePickLeavesScene(current, { windowId: 'window:7' })).toBe(true)
    expect(capturePickLeavesScene(current, { captureOff: true })).toBe(true)
    expect(capturePickLeavesScene(current, { screenId: 'screen:1' })).toBe(false)
  })

  it('always leaves a scene made for an app: a pick makes it one fixed window', () => {
    expect(
      capturePickLeavesScene(
        {
          windowId: 'window:figma',
          app: { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
        },
        { windowId: 'window:figma' }
      )
    ).toBe(true)
  })
})
