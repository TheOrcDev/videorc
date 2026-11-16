import { describe, expect, it } from 'vitest'
import type { Device } from './backend'
import { scenesWithFirstRunLook } from './first-run-look'
import { normalizeSceneVisual, type SavedScene, type SceneVisual } from './scene-presets'
import {
  cameraSources,
  captureSources,
  noScreenLayoutReason,
  sameCaptureTarget,
  sceneCaptureIsBorrowed,
  sceneDisplayRefreshed,
  sceneDrawsScreen,
  sceneEditAutosave,
  sceneFromSaved,
  sceneKeepsCapture,
  sceneLegLayouts,
  sceneOnStreamAtLaunch,
  sceneWithShows,
  savedSceneView,
  verticalLegBorrowsScreen
} from './scene-studio'
import { canDeleteScene, firstSceneWithLayout, type Scene } from './scenes'
import { defaultScenes } from './scenes-migration'

const NOW = '2026-11-15T12:00:00.000Z'
const LATER = '2026-11-15T13:00:00.000Z'
const display1 = { id: 'screen:1', name: 'Display 1', displayUuid: 'uuid-1' }
const camera = { cameraId: 'camera:1', cameraName: 'FaceTime', cameraOff: false }

/** A new user's four scenes: Screen + camera, Screen only, Camera only, Side by side. */
const defaults = (): Scene[] => defaultScenes(display1, NOW)
const byLayout = (scenes: readonly Scene[], preset: string): Scene =>
  scenes.find((scene) => scene.layouts.horizontal.layoutPreset === preset)!
const figma = (): Scene => ({
  ...byLayout(defaults(), 'screen-camera'),
  id: 'figma',
  name: 'Figma',
  shows: { kind: 'app', bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
})

/** The working look and sources a commit confirms. */
function working(scene: Scene, sources: SceneVisual['sources'], layout = {}): SceneVisual {
  return normalizeSceneVisual({
    layout: { ...scene.layouts.horizontal, ...layout },
    sources: { ...camera, ...sources },
    background: scene.background
  })
}

describe('a scene as the Studio applies it (plan 231 S2)', () => {
  it('reads a scene in the studio orientation, with the one shared camera (D9)', () => {
    const scene = figma()
    const horizontal = savedSceneView(scene, 'horizontal', camera)
    expect(horizontal.visual.layout).toEqual(scene.layouts.horizontal)
    expect(horizontal.visual.sources).toMatchObject({
      cameraId: 'camera:1',
      cameraName: 'FaceTime',
      app: { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
    })
    expect(horizontal.visual.sources.windowId).toBeUndefined()
    expect(savedSceneView(scene, 'vertical', camera).visual.layout).toEqual(scene.layouts.vertical)
    // Another camera in Sources is every scene's camera: the scene keeps none.
    const other = savedSceneView(scene, 'horizontal', { cameraId: 'camera:2', cameraName: 'USB' })
    expect(other.visual.sources).toMatchObject({ cameraId: 'camera:2', cameraName: 'USB' })
  })

  it('a scene that shows no screen reads as Screen None', () => {
    const none = byLayout(defaults(), 'camera-only')
    expect(none.shows).toEqual({ kind: 'none' })
    expect(savedSceneView(none, 'horizontal', camera).visual.sources).toMatchObject({
      captureOff: true,
      screenId: undefined,
      windowId: undefined
    })
  })

  it('writes an edited snapshot back without its camera, keeping the other layout', () => {
    const scene = figma()
    const view = savedSceneView(scene, 'horizontal', camera)
    const edited: SavedScene = {
      ...view,
      name: 'Figma board',
      visual: normalizeSceneVisual({
        ...view.visual,
        layout: { ...view.visual.layout, layoutPreset: 'side-by-side' },
        sources: { cameraId: 'camera:9', windowId: 'window:7', windowName: 'Board' }
      })
    }
    const stored = sceneFromSaved(edited, scene)
    expect(stored.name).toBe('Figma board')
    expect(stored.shows).toEqual({ kind: 'window', windowId: 'window:7', windowName: 'Board' })
    expect(stored.layouts.horizontal.layoutPreset).toBe('side-by-side')
    expect(stored.layouts.vertical).toEqual(scene.layouts.vertical)
    expect(JSON.stringify(stored)).not.toContain('camera:9')
  })

  it('a new scene takes the 9:16 layout of the scene it is made from (D6)', () => {
    const onStream = byLayout(defaults(), 'screen-only')
    const view = savedSceneView(figma(), 'horizontal', camera)
    const stored = sceneFromSaved({ ...view, id: 'new', name: 'New' }, onStream)
    expect(stored.layouts.horizontal).toEqual(view.visual.layout)
    expect(stored.layouts.vertical).toEqual(onStream.layouts.vertical)
  })

  it('splits a snapshot into its screen and its camera', () => {
    const sources = savedSceneView(figma(), 'horizontal', camera).visual.sources
    expect(Object.keys(captureSources(sources)).sort()).toEqual([
      'captureOff',
      'screenId',
      'screenName',
      'screenUuid',
      'testPattern',
      'windowId',
      'windowName'
    ])
    expect(cameraSources(sources)).toEqual({
      cameraId: 'camera:1',
      cameraName: 'FaceTime',
      cameraOff: false
    })
  })
})

describe('the scene on stream at launch', () => {
  const all = defaults()
  const [screenCamera, screenOnly] = all
  it('is the one the library names while the look has its layout', () => {
    expect(sceneOnStreamAtLaunch(all, screenOnly!.id, screenOnly!.layouts.horizontal)).toBe(
      screenOnly!.id
    )
    // A Freeform arrangement keeps the scene it was made on.
    expect(
      sceneOnStreamAtLaunch(all, screenOnly!.id, {
        ...screenOnly!.layouts.horizontal,
        arrangementMode: 'freeform'
      })
    ).toBe(screenOnly!.id)
    // In a 9:16 studio the scene's 9:16 layout decides.
    expect(sceneOnStreamAtLaunch(all, screenOnly!.id, screenOnly!.layouts.vertical)).toBe(
      screenOnly!.id
    )
  })
  it('is the first scene with the layout that launched when the named one has another', () => {
    // A capture config seeded from outside: Screen only is what is on stream.
    expect(sceneOnStreamAtLaunch(all, screenCamera!.id, screenOnly!.layouts.horizontal)).toBe(
      screenOnly!.id
    )
    // No scene has the layout: the named scene stays.
    expect(
      sceneOnStreamAtLaunch(all.slice(0, 1), screenCamera!.id, screenOnly!.layouts.horizontal)
    ).toBe(screenCamera!.id)
  })
})

describe('a scene that shows no screen keeps the capture (D18)', () => {
  it('keeps it only while its layout draws no screen', () => {
    const none = byLayout(defaults(), 'camera-only')
    expect(sceneKeepsCapture(none, none.layouts.horizontal)).toBe(true)
    // A layout with a screen on a scene that shows none asks for one instead.
    expect(
      sceneKeepsCapture(none, { ...none.layouts.horizontal, layoutPreset: 'screen-camera' })
    ).toBe(false)
    expect(
      sceneKeepsCapture(none, { ...none.layouts.horizontal, arrangementMode: 'freeform' })
    ).toBe(false)
  })

  it('also keeps a screen-owning scene while its layout draws no screen', () => {
    const scene = figma()
    expect(
      sceneKeepsCapture(scene, { ...scene.layouts.horizontal, layoutPreset: 'camera-only' })
    ).toBe(true)
    expect(sceneKeepsCapture(undefined, scene.layouts.horizontal)).toBe(false)
  })

  // Review #1: the vertical stream is a leg too. A scene with Camera only on
  // the program and its screen on the 9:16 leg shows its own screen there.
  const cameraOnlyThenScreen = (): Scene => {
    const scene = figma()
    return {
      ...scene,
      layouts: {
        horizontal: { ...scene.layouts.horizontal, layoutPreset: 'camera-only' },
        vertical: { ...scene.layouts.vertical, layoutPreset: 'vertical-screen-only' }
      }
    }
  }
  it('judges every leg that is on: the program, and the vertical stream while armed', () => {
    const scene = cameraOnlyThenScreen()
    const program = scene.layouts.horizontal
    expect(sceneLegLayouts(scene, program, false)).toEqual([program])
    expect(sceneLegLayouts(scene, program, true)).toEqual([program, scene.layouts.vertical])
    expect(sceneDrawsScreen(scene, program, false)).toBe(false)
    expect(sceneDrawsScreen(scene, program, true)).toBe(true)
    expect(sceneKeepsCapture(scene, program, false)).toBe(true)
    expect(sceneKeepsCapture(scene, program, true)).toBe(false)
    // A 9:16 studio's program is the 9:16 layout: there is no second leg.
    expect(sceneLegLayouts(scene, scene.layouts.vertical, true)).toEqual([scene.layouts.vertical])
    // A scene no leg draws a screen for keeps the capture with the leg armed.
    const none = byLayout(defaults(), 'camera-only')
    expect(sceneKeepsCapture(none, none.layouts.horizontal, true)).toBe(true)
  })

  it("a capture kept from another scene is never the scene's own (D18)", () => {
    const scene = figma()
    const t3 = { kind: 'app' as const, bundleId: 'dev.t3', name: 'T3 Code', follows: true }
    expect(sceneCaptureIsBorrowed(scene, t3)).toBe(true)
    expect(
      sceneCaptureIsBorrowed(scene, { ...scene.shows, follows: false } as Scene['shows'])
    ).toBe(false)
    // A scene that shows none has no screen of its own: Change screen… decides.
    expect(sceneCaptureIsBorrowed(byLayout(defaults(), 'camera-only'), t3)).toBe(false)
    expect(noScreenLayoutReason('Camera only')).toBe(
      '“Camera only” shows no screen. Choose one with Change screen… first.'
    )
  })

  it('the vertical leg borrows a screen only while the program draws none', () => {
    const scene = cameraOnlyThenScreen()
    const t3 = { kind: 'app' as const, bundleId: 'dev.t3', name: 'T3 Code', follows: true }
    expect(verticalLegBorrowsScreen(scene, scene.layouts.horizontal, true, t3)).toBe(true)
    expect(verticalLegBorrowsScreen(scene, scene.layouts.horizontal, false, t3)).toBe(false)
    expect(verticalLegBorrowsScreen(scene, scene.layouts.horizontal, true, scene.shows)).toBe(false)
    expect(
      verticalLegBorrowsScreen(
        scene,
        { ...scene.layouts.horizontal, layoutPreset: 'screen-camera' },
        true,
        t3
      )
    ).toBe(false)
  })

  it('keeps a running capture only for the target it captures', () => {
    expect(sameCaptureTarget({ screenId: 'screen:1' }, { screenId: 'screen:1' })).toBe(true)
    expect(sameCaptureTarget({ screenId: 'screen:1' }, { screenId: 'screen:2' })).toBe(false)
    expect(sameCaptureTarget({ windowId: 'window:1' }, { screenId: 'screen:1' })).toBe(false)
    expect(sameCaptureTarget({ testPattern: true }, {})).toBe(false)
  })
})

describe('edits save into the scene on stream (D11)', () => {
  const scenes = (): Scene[] => [figma(), ...defaults()]
  const figmaSources = {
    windowId: 'window:3',
    windowName: 'Figma - Untitled',
    app: { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
  }

  it('saves the look into the layout of the committed orientation', () => {
    const all = scenes()
    const visual = working(all[0]!, figmaSources, { cameraZoom: 150 })
    const saved = sceneEditAutosave({
      previousSceneId: 'figma',
      previousShows: all[0]!.shows,
      sceneId: 'figma',
      scenes: all,
      visual,
      now: LATER
    })!
    expect(saved.layouts.horizontal.cameraZoom).toBe(150)
    expect(saved.layouts.vertical).toEqual(all[0]!.layouts.vertical)
    expect(saved.shows).toEqual(all[0]!.shows)
    expect(saved.updatedAt).toBe(LATER)
  })

  it('a 9:16 commit saves into the 9:16 layout and leaves the 16:9 one', () => {
    const all = scenes()
    const visual = normalizeSceneVisual({
      layout: { ...all[0]!.layouts.vertical, cameraZoom: 130 },
      sources: { ...camera, ...figmaSources },
      background: null
    })
    const saved = sceneEditAutosave({
      previousSceneId: 'figma',
      previousShows: all[0]!.shows,
      sceneId: 'figma',
      scenes: all,
      visual,
      now: LATER
    })!
    expect(saved.layouts.vertical.cameraZoom).toBe(130)
    expect(saved.layouts.horizontal).toEqual(all[0]!.layouts.horizontal)
  })

  it('the commit that puts a scene on stream is a switch, never an edit', () => {
    const all = scenes()
    const visual = working(all[0]!, figmaSources, { cameraZoom: 150 })
    for (const previousSceneId of [null, all[1]!.id])
      expect(
        sceneEditAutosave({
          previousSceneId,
          previousShows: null,
          sceneId: 'figma',
          scenes: all,
          visual,
          now: LATER
        })
      ).toBeNull()
  })

  it('writes nothing when the scene already keeps the look and the screen', () => {
    const all = scenes()
    expect(
      sceneEditAutosave({
        previousSceneId: 'figma',
        previousShows: all[0]!.shows,
        sceneId: 'figma',
        scenes: all,
        visual: working(all[0]!, figmaSources),
        now: LATER
      })
    ).toBeNull()
  })

  it('a Screen pick changes the screen of the scene on stream (D2)', () => {
    const all = scenes()
    const saved = sceneEditAutosave({
      previousSceneId: 'figma',
      previousShows: all[0]!.shows,
      sceneId: 'figma',
      scenes: all,
      visual: working(all[0]!, {
        screenId: 'screen:2',
        screenName: 'Display 2',
        screenUuid: 'uuid-2'
      }),
      now: LATER
    })!
    expect(saved.id).toBe('figma')
    expect(saved.shows).toEqual({
      kind: 'display',
      screenId: 'screen:2',
      screenName: 'Display 2',
      screenUuid: 'uuid-2'
    })
    // Only the screen changed: no other scene is written, none is left.
    expect(saved.layouts).toEqual(all[0]!.layouts)
  })

  it("an app's front window changing is not a pick", () => {
    const all = scenes()
    expect(
      sceneEditAutosave({
        previousSceneId: 'figma',
        previousShows: all[0]!.shows,
        sceneId: 'figma',
        scenes: all,
        visual: working(all[0]!, { ...figmaSources, windowId: 'window:9', windowName: 'Other' }),
        now: LATER
      })
    ).toBeNull()
  })

  it('a scene that shows no screen keeps showing none under a kept capture (D18)', () => {
    const all = scenes()
    const none = byLayout(all, 'camera-only')
    // Camera only went on stream over Figma's running capture, then its
    // camera was zoomed: the screen under it is no pick.
    const saved = sceneEditAutosave({
      previousSceneId: none.id,
      previousShows: all[0]!.shows,
      sceneId: none.id,
      scenes: all,
      visual: working(none, figmaSources, { cameraZoom: 140 }),
      now: LATER
    })!
    expect(saved.shows).toEqual({ kind: 'none' })
    expect(saved.layouts.horizontal.cameraZoom).toBe(140)
  })

  // Review #1, #4: the capture another scene left running never becomes the
  // screen of a scene that shows none, whatever layout it takes (D19 asks).
  it('never takes a kept capture as its screen, even under a screen layout', () => {
    const all = scenes()
    const none = byLayout(all, 'camera-only')
    const saved = sceneEditAutosave({
      previousSceneId: none.id,
      previousShows: all[0]!.shows,
      sceneId: none.id,
      scenes: all,
      visual: working(none, figmaSources, { layoutPreset: 'screen-camera' }),
      now: LATER
    })!
    expect(saved.shows).toEqual({ kind: 'none' })
  })

  it('never writes audio', () => {
    const all = scenes()
    const pinned: Scene = {
      ...all[0]!,
      audio: { microphoneId: 'mic:1', microphoneOff: false, systemAudioEnabled: true }
    }
    const saved = sceneEditAutosave({
      previousSceneId: 'figma',
      previousShows: pinned.shows,
      sceneId: 'figma',
      scenes: [pinned, ...all.slice(1)],
      visual: working(pinned, figmaSources, { cameraZoom: 120 }),
      now: LATER
    })!
    expect(saved.audio).toEqual(pinned.audio)
  })

  it('a pick writes the screen at once, and nothing when it is the same', () => {
    const scene = figma()
    const picked = sceneWithShows(scene, { kind: 'none' }, LATER)!
    expect(picked.shows).toEqual({ kind: 'none' })
    expect(picked.updatedAt).toBe(LATER)
    expect(sceneWithShows(scene, { ...scene.shows }, LATER)).toBeNull()
  })
})

describe("a scene's display, as listed now (plan 213 F1)", () => {
  const screen = (id: string, displayUuid: string): Device => ({
    id,
    name: 'Display 1',
    kind: 'screen',
    status: 'available',
    displayUuid
  })

  it('follows its display to a new id, without counting as an edit', () => {
    const scene = byLayout(defaults(), 'screen-only')
    const refreshed = sceneDisplayRefreshed(scene, [screen('screen:7', 'uuid-1')])!
    expect(refreshed.shows).toMatchObject({ kind: 'display', screenId: 'screen:7' })
    expect(refreshed.updatedAt).toBe(scene.updatedAt)
    expect(sceneDisplayRefreshed(scene, [screen('screen:1', 'uuid-1')])).toBeNull()
    expect(sceneDisplayRefreshed(figma(), [screen('screen:7', 'uuid-1')])).toBeNull()
  })
})

describe("first-run setup's look (plan 207 S4)", () => {
  it('goes on the scene on stream whole, and gives the defaults its shape and background', () => {
    const all = [...defaults(), figma()]
    const onStream = byLayout(all, 'side-by-side')
    const background = { assetId: 'live-poster-aurora-1' } as Scene['background']
    const layout = { ...onStream.layouts.horizontal, cameraShape: 'circle' as const }
    const next = scenesWithFirstRunLook(all, { onStreamId: onStream.id, layout, background })
    expect(byLayout(next, 'side-by-side').layouts.horizontal).toEqual(layout)
    for (const scene of next.filter((entry) => entry.id.startsWith('default-'))) {
      expect(scene.layouts.horizontal.cameraShape).toBe('circle')
      expect(scene.layouts.vertical.cameraShape).toBe('circle')
      expect(scene.background).toEqual(background)
    }
    // A scene the streamer made keeps its own look.
    expect(next.find((scene) => scene.id === 'figma')).toEqual(figma())
    // Every scene keeps its layout: only the one on stream takes the look's.
    expect(next.map((scene) => scene.layouts.horizontal.layoutPreset)).toEqual(
      all.map((scene) => scene.layouts.horizontal.layoutPreset)
    )
  })
})

describe('what a layout means to a key or a remote (D14)', () => {
  it('is the first scene with that layout in the studio orientation, or none', () => {
    const all = [figma(), ...defaults()]
    // Figma is Screen + camera and comes first.
    expect(firstSceneWithLayout(all, 'horizontal', 'screen-camera')?.id).toBe('figma')
    expect(firstSceneWithLayout(all, 'horizontal', 'side-by-side')?.id).toBe(
      byLayout(all, 'side-by-side').id
    )
    // No scene uses a 9:16 layout in a 16:9 studio: the switch is refused.
    expect(firstSceneWithLayout(all, 'horizontal', 'vertical-split')).toBeUndefined()
  })
})

describe('deleting a scene (D16)', () => {
  const all = defaults()
  it('off air, the scene on stream gives way to the one before it', () => {
    expect(
      canDeleteScene({ scenes: all, id: all[2]!.id, onStreamId: all[2]!.id, sessionActive: false })
    ).toEqual({ allowed: true, switchToId: all[1]!.id })
    expect(
      canDeleteScene({ scenes: all, id: all[0]!.id, onStreamId: all[0]!.id, sessionActive: false })
    ).toEqual({ allowed: true, switchToId: all[1]!.id })
  })
  it('while recording or live, the scene on stream stays; the last scene always does', () => {
    expect(
      canDeleteScene({ scenes: all, id: all[2]!.id, onStreamId: all[2]!.id, sessionActive: true })
    ).toEqual({ allowed: false, reason: 'Switch to another scene first.' })
    expect(
      canDeleteScene({ scenes: all, id: all[1]!.id, onStreamId: all[2]!.id, sessionActive: true })
    ).toEqual({ allowed: true, switchToId: null })
    expect(
      canDeleteScene({
        scenes: all.slice(0, 1),
        id: all[0]!.id,
        onStreamId: all[0]!.id,
        sessionActive: false
      })
    ).toEqual({ allowed: false, reason: 'Keep at least one scene.' })
  })
  // Review #2: a scene going on stream can't be deleted under its switch,
  // idle or live, on stream or not.
  it('a scene going on stream stays until its switch is over', () => {
    for (const sessionActive of [false, true])
      expect(
        canDeleteScene({
          scenes: all,
          id: all[1]!.id,
          onStreamId: all[2]!.id,
          sessionActive,
          goingOn: true
        })
      ).toEqual({
        allowed: false,
        reason: 'This scene is going on stream. Try again in a moment.'
      })
  })
})
