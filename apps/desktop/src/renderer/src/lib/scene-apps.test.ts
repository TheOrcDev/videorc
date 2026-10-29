import { describe, expect, it } from 'vitest'
import { defaultCaptureConfig } from './capture'
import {
  appWindowFailureCopy,
  resolveSceneWindow,
  sceneForFrontApp,
  scenesForApps
} from './scene-apps'
import {
  hydrateSceneLibrary,
  hydrateWorkingScene,
  normalizeSceneVisual,
  sceneNameError,
  sceneSourceGaps,
  type SceneVisual
} from './scene-presets'

const look = (): SceneVisual =>
  normalizeSceneVisual({
    layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
    sources: { cameraId: 'camera', screenId: 'display' },
    background: null
  })
const options = { id: () => 'id', now: () => '2026-10-28' }
const app = {
  bundleId: 'com.figma.Desktop',
  name: 'Figma',
  frontWindowId: 'window',
  frontWindowName: 'Design'
}
const make = () => scenesForApps([app], look(), [], options)[0]

describe('scenes for apps', () => {
  it('keeps the look, follows, clears display and audio, and clones the snapshot', () => {
    const working = look()
    const scene = scenesForApps([app], working, [], options)[0]
    expect(scene.visual.sources).toMatchObject({
      cameraId: 'camera',
      windowId: 'window',
      app: { bundleId: app.bundleId, name: 'Figma', follows: true }
    })
    expect(scene.visual.sources.screenId).toBeUndefined()
    expect(scene).not.toHaveProperty('audio')
    expect(scene.createdAt).toBe('2026-10-28')
    scene.visual.layout.cameraZoom = 123
    expect(scene.visual.layout).not.toEqual(working.layout)
    expect(working.sources.screenId).toBe('display')
  })
  it('round trips library and working scenes at v1', () => {
    const scene = make()
    expect(
      hydrateSceneLibrary(JSON.parse(JSON.stringify({ version: 1, scenes: [scene] })))
    ).toMatchObject({ library: { version: 1, scenes: [scene] }, error: null })
    expect(
      hydrateWorkingScene({ version: 1, sceneId: scene.id, visual: scene.visual })?.visual
    ).toEqual(scene.visual)
  })
  it.each([null, [], 'bad', { bundleId: 4 }, { bundleId: '' }])(
    'drops invalid app identity without losing the scene: %j',
    (raw) => {
      const scene = make()
      const result = hydrateSceneLibrary({
        version: 1,
        scenes: [
          { ...scene, visual: { ...scene.visual, sources: { ...scene.visual.sources, app: raw } } }
        ]
      })
      expect(result.library.scenes).toHaveLength(1)
      expect(result.library.scenes[0].visual.sources.app).toBeUndefined()
    }
  )
  it('repairs optional app fields independently and never enables malformed follows', () => {
    const scene = make()
    expect(
      normalizeSceneVisual({
        ...scene.visual,
        sources: { app: { bundleId: app.bundleId, name: 42, follows: 'true' } }
      }).sources.app
    ).toEqual({ bundleId: app.bundleId, name: app.bundleId, follows: false })
    expect(
      normalizeSceneVisual({
        ...scene.visual,
        sources: { app: { ...app, follows: false, unknown: true } }
      }).sources.app
    ).toEqual({ bundleId: app.bundleId, name: app.name, follows: false })
  })
  it('retains the v1 parser contract: unknown source keys are ignored', () => {
    // Before S2, normalizeSceneVisual validated known fields only and
    // visualSources projected this allowlist. An app key never rejected an entry.
    const scene = make()
    const legacyKeys = [
      'cameraId',
      'cameraName',
      'cameraOff',
      'captureOff',
      'screenId',
      'screenName',
      'windowId',
      'windowName',
      'testPattern'
    ]
    const legacySources = Object.fromEntries(
      Object.entries(scene.visual.sources).filter(([key]) => legacyKeys.includes(key))
    )
    expect(
      hydrateSceneLibrary({
        version: 1,
        scenes: [{ ...scene, visual: { ...scene.visual, sources: legacySources } }]
      }).library.scenes
    ).toHaveLength(1)
    expect(
      normalizeSceneVisual({ ...scene.visual, sources: { ...legacySources, futureKey: {} } })
        .sources
    ).toEqual(legacySources)
  })
  it('dedupes existing and new names case insensitively within 80 characters', () => {
    const names = scenesForApps(
      [app, { ...app, name: 'figma' }],
      look(),
      [{ ...make(), name: 'FIGMA' }],
      options
    ).map((s) => s.name)
    expect(names).toEqual(['Figma 2', 'figma 3'])
    const long = { ...app, name: 'x'.repeat(100) }
    const scenes = scenesForApps([long, long], look(), [], options)
    expect(scenes.map((s) => s.name.length)).toEqual([80, 80])
    expect(sceneNameError(scenes[1].name, [scenes[0]])).toBeNull()
  })
  it('requests app resolution even with a stale window, with no missing-window gap', () => {
    const scene = make()
    expect(sceneSourceGaps(scene.visual, [])).toEqual([])
    expect(resolveSceneWindow(scene.visual, [])).toEqual({
      kind: 'resolve-app',
      bundleId: app.bundleId
    })
    expect(
      resolveSceneWindow(scene.visual, [], undefined, { windowId: 'new', title: 'New' })
    ).toMatchObject({ kind: 'ready', sources: { windowId: 'new' } })
    expect(scene.visual.sources.windowId).toBe('window')
  })
  it.each([
    ['not-running', 'app-not-running', "Figma isn't open"],
    ['no-window', 'app-no-window', 'Figma has no window open'],
    ['minimized', 'app-minimized', "Figma's window is minimized"]
  ] as const)('returns typed %s and copy', (reason, typed, copy) => {
    expect(resolveSceneWindow(make().visual, [], undefined, { reason })).toEqual({
      kind: 'blocked',
      reason: typed
    })
    expect(appWindowFailureCopy('Figma', typed)).toBe(copy)
  })
  it('preserves fixed-window semantics, with an explicit ownership fallback before resolve sources', () => {
    const visual = make().visual
    delete visual.sources.app
    expect(sceneSourceGaps(visual, [])).toEqual([{ source: 'screen', state: 'unavailable' }])
    expect(resolveSceneWindow(visual, [])).toEqual({ kind: 'resolve-sources' })
    expect(resolveSceneWindow(visual, [], app.bundleId)).toEqual({
      kind: 'resolve-app',
      bundleId: app.bundleId
    })
    expect(
      resolveSceneWindow(
        visual,
        [{ id: 'window', kind: 'window', status: 'available', name: 'Design' }],
        app.bundleId
      )
    ).toMatchObject({ kind: 'ready' })
  })
  it('selects the latest used following scene in the current orientation only', () => {
    const a = make(),
      b = { ...make(), id: 'b' },
      stopped = {
        ...make(),
        id: 'stopped',
        visual: {
          ...make().visual,
          sources: { app: { ...make().visual.sources.app!, follows: false } }
        }
      }
    const vertical = {
      ...make(),
      id: 'vertical',
      visual: {
        ...make().visual,
        layout: { ...make().visual.layout, layoutPreset: 'vertical-screen-only' as const }
      }
    }
    const scenes = [a, b, stopped, vertical]
    expect(sceneForFrontApp(scenes, app, { b: 20, stopped: 100 }, 'horizontal')?.id).toBe('b')
    expect(sceneForFrontApp(scenes, app, {}, 'vertical')?.id).toBe('vertical')
    expect(sceneForFrontApp(scenes, { bundleId: 'other' }, {}, 'horizontal')).toBeUndefined()
    expect(sceneForFrontApp([stopped], app, {}, 'horizontal')).toBeUndefined()
  })
})
