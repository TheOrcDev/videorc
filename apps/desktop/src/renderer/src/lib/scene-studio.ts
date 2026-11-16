import type { Device, LayoutSettings } from './backend'
import { layoutPresetOrientation } from './capture'
import {
  sceneDisplayRefresh,
  usingVisualSources,
  type SavedScene,
  type SceneOrientation,
  type SceneVisual,
  type VisualSources
} from './scene-presets'
import { canonicalJson } from './scene-visibility-identity'
import {
  firstSceneWithLayout,
  layoutShowsScreen,
  sameShows,
  sceneLayout,
  showsFromSources,
  showsSources,
  type Scene,
  type SceneShows
} from './scenes'

// Plan 231 S2: the Studio runs on scenes. Its apply, preflight, swap in place
// and follow paths read a scene as a visual snapshot (plan 210's saved-scene
// shape): the scene's layout for the studio's orientation, the screen it
// shows, and the one camera every scene shares (D9). These are the two
// directions between that shape and a stored scene, and what an edit made
// while a scene is on stream saves into it (D11).

/** The camera every scene shares: `captureConfig.sources` only (D9). */
export type SceneCamera = Pick<VisualSources, 'cameraId' | 'cameraName' | 'cameraOff'>

const CAPTURE_KEYS = [
  'screenId',
  'screenName',
  'screenUuid',
  'windowId',
  'windowName',
  'captureOff',
  'testPattern'
] as const
const CAMERA_KEYS = ['cameraId', 'cameraName', 'cameraOff'] as const

type CaptureSources = Pick<VisualSources, (typeof CAPTURE_KEYS)[number]>

function pick<K extends keyof VisualSources>(
  sources: VisualSources,
  keys: readonly K[]
): Pick<VisualSources, K> {
  return Object.fromEntries(keys.map((key) => [key, sources[key]])) as Pick<VisualSources, K>
}

/** The screen part of a snapshot's sources: every key, so a spread clears the previous screen. */
export function captureSources(sources: VisualSources): CaptureSources {
  return pick(sources, CAPTURE_KEYS)
}

/** The camera part of a snapshot's sources. */
export function cameraSources(sources: VisualSources): SceneCamera {
  return pick(sources, CAMERA_KEYS)
}

/** A scene as the Studio applies and lists it, in one orientation, with the shared camera. */
export function savedSceneView(
  scene: Scene,
  orientation: SceneOrientation,
  camera: SceneCamera
): SavedScene {
  return {
    id: scene.id,
    name: scene.name,
    createdAt: scene.createdAt,
    updatedAt: scene.updatedAt,
    visual: {
      layout: sceneLayout(scene, orientation),
      sources: usingVisualSources({ ...cameraSources(camera), ...showsSources(scene.shows) }),
      background: scene.background
    },
    ...(scene.audio ? { audio: scene.audio } : {})
  }
}

/**
 * The stored scene for a snapshot: its screen, its layout in the snapshot's
 * orientation, its background and audio. The other orientation's layout comes
 * from `template`: the scene itself on an edit, its original on a duplicate,
 * the scene on stream for a new one (D6). The snapshot's camera is dropped (D9).
 */
export function sceneFromSaved(saved: SavedScene, template: Pick<Scene, 'layouts'>): Scene {
  return {
    id: saved.id,
    name: saved.name,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    shows: showsFromSources(saved.visual.sources),
    layouts: {
      ...template.layouts,
      [layoutPresetOrientation(saved.visual.layout.layoutPreset)]: saved.visual.layout
    },
    background: saved.visual.background,
    ...(saved.audio ? { audio: saved.audio } : {})
  }
}

/**
 * The scene on stream at launch: the one the library names, while the look
 * that launched has its layout. A look with another layout (a capture config
 * written from outside, a downgrade and back) is on the first scene with that
 * layout instead, so the scene named on stream is the one that is.
 */
export function sceneOnStreamAtLaunch(
  scenes: readonly Scene[],
  onStreamId: string,
  layout: LayoutSettings
): string {
  const orientation = layoutPresetOrientation(layout.layoutPreset)
  const named = scenes.find((scene) => scene.id === onStreamId)
  if (named && sceneLayout(named, orientation).layoutPreset === layout.layoutPreset)
    return onStreamId
  return firstSceneWithLayout(scenes, orientation, layout.layoutPreset)?.id ?? onStreamId
}

/**
 * The layouts a scene is drawn in on the legs that are on (D4): the program's,
 * plus its 9:16 layout on the vertical stream while one is armed or live
 * beside a 16:9 studio (`verticalLeg`).
 */
export function sceneLegLayouts(
  scene: Pick<Scene, 'layouts'>,
  program: LayoutSettings,
  verticalLeg: boolean
): LayoutSettings[] {
  return verticalLeg && layoutPresetOrientation(program.layoutPreset) === 'horizontal'
    ? [program, scene.layouts.vertical]
    : [program]
}

/**
 * Whether a scene draws a screen on any leg that is on (D4, D18): then it
 * needs its own screen, its app's window resolved, and its screen available.
 */
export function sceneDrawsScreen(
  scene: Pick<Scene, 'layouts'>,
  program: LayoutSettings,
  verticalLeg: boolean
): boolean {
  return sceneLegLayouts(scene, program, verticalLeg).some(layoutShowsScreen)
}

/**
 * Whether a scene going on stream leaves the capture as it is (D18): no leg
 * draws a screen for it, so the running capture keeps running and going back
 * to an app's scene is a swap in place. A leg that draws one (the vertical
 * stream's 9:16 layout too) shows the scene's own screen, never the one an
 * earlier scene left running.
 */
export function sceneKeepsCapture(
  scene: Pick<Scene, 'layouts'> | undefined,
  program: LayoutSettings,
  verticalLeg = false
): boolean {
  return scene !== undefined && !sceneDrawsScreen(scene, program, verticalLeg)
}

/**
 * Whether the capture now is not the one the scene shows (D18): the running
 * capture an earlier scene left, kept under a scene that drew no screen. A
 * leg that starts drawing a screen must take the scene's own instead. A scene
 * that shows none has no screen of its own: Change screen… decides (D19).
 */
export function sceneCaptureIsBorrowed(scene: Pick<Scene, 'shows'>, working: SceneShows): boolean {
  return scene.shows.kind !== 'none' && !sameShows(scene.shows, working)
}

/**
 * The vertical leg would show a capture the scene doesn't own (D18): it draws
 * the scene's 9:16 screen layout (edited on the Vertical stream panel, or a
 * vertical stream armed since) while the program draws none, and the capture
 * is one an earlier scene left running. The scene must go on again with its
 * own screen before the leg shows it.
 */
export function verticalLegBorrowsScreen(
  scene: Pick<Scene, 'shows' | 'layouts'>,
  program: LayoutSettings,
  verticalLeg: boolean,
  working: SceneShows
): boolean {
  return (
    verticalLeg &&
    layoutPresetOrientation(program.layoutPreset) === 'horizontal' &&
    !layoutShowsScreen(program) &&
    layoutShowsScreen(scene.layouts.vertical) &&
    sceneCaptureIsBorrowed(scene, working)
  )
}

/**
 * Whether two source selections capture the same thing (D18): a capture kept
 * running is only ever the one the selection names.
 */
export function sameCaptureTarget(
  a: Pick<VisualSources, 'screenId' | 'windowId' | 'testPattern'>,
  b: Pick<VisualSources, 'screenId' | 'windowId' | 'testPattern'>
): boolean {
  return (
    (a.windowId ?? null) === (b.windowId ?? null) &&
    (a.screenId ?? null) === (b.screenId ?? null) &&
    Boolean(a.testPattern) === Boolean(b.testPattern)
  )
}

/** D19: a scene that shows no screen can't take a layout that draws one. */
export function noScreenLayoutReason(sceneName: string): string {
  return `“${sceneName}” shows no screen. Choose one with Change screen… first.`
}

/**
 * The scene a confirmed commit writes, or null when it writes none (D11).
 *
 * - Only a commit made while the scene was already on stream writes: the
 *   commit that puts a scene on stream is a switch, not an edit.
 * - The look goes into the layout of the committed orientation; the other
 *   orientation's layout stays.
 * - The screen is written when it changed while the scene was on: a Screen
 *   pick in Sources, in Studio, on the phone or by a remote (D2). An app's
 *   front window changing is not a pick.
 * - A capture kept running under a scene that shows no screen (D18) is never
 *   its screen: Change screen… (D19) or a Screen pick decides that.
 * - Audio never changes this way (D10).
 */
export function sceneEditAutosave(input: {
  /** The scene on stream before this commit, and what the capture showed then. */
  previousSceneId: string | null
  previousShows: SceneShows | null
  sceneId: string | null
  scenes: readonly Scene[]
  /** The committed working look and sources. */
  visual: SceneVisual
  now: string
}): Scene | null {
  const { sceneId, visual } = input
  if (!sceneId || input.previousSceneId !== sceneId) return null
  const scene = input.scenes.find((entry) => entry.id === sceneId)
  if (!scene) return null
  const orientation = layoutPresetOrientation(visual.layout.layoutPreset)
  const working = showsFromSources(visual.sources)
  const picked = input.previousShows !== null && !sameShows(input.previousShows, working)
  const shows = picked ? working : scene.shows
  if (
    canonicalJson(scene.layouts[orientation]) === canonicalJson(visual.layout) &&
    canonicalJson(scene.background) === canonicalJson(visual.background) &&
    canonicalJson(scene.shows) === canonicalJson(shows)
  )
    return null
  return {
    ...scene,
    shows,
    layouts: { ...scene.layouts, [orientation]: visual.layout },
    background: visual.background,
    updatedAt: input.now
  }
}

/** A Screen pick's scene (D2): the scene with the picked screen, or null when it shows it already. */
export function sceneWithShows(scene: Scene, shows: SceneShows, now: string): Scene | null {
  return canonicalJson(scene.shows) === canonicalJson(shows)
    ? null
    : { ...scene, shows, updatedAt: now }
}

/**
 * A scene's display as it is listed now (plan 213 F1), or null when nothing
 * changed. Not an edit: `updatedAt` stays.
 */
export function sceneDisplayRefreshed(scene: Scene, devices: readonly Device[]): Scene | null {
  if (scene.shows.kind !== 'display') return null
  const display = sceneDisplayRefresh(showsSources(scene.shows), devices)
  return display ? { ...scene, shows: showsFromSources(display) } : null
}
