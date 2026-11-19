import type { Device, GlobalShortcutsConfig, LayoutPreset, LayoutSettings } from './backend'
import { layoutPresetNeedsScreen, layoutPresetOrientation } from './capture'
import {
  normalizeSceneApp,
  normalizeSceneAudio,
  normalizeSavedSceneCloud,
  normalizeSceneVisual,
  sceneNameError,
  type SavedSceneBackground,
  type SavedSceneCloud,
  type SceneAudio,
  type SceneOrientation,
  type SceneVisual,
  type VisualSources
} from './scene-presets'

// Plan 231: every scene shows its own screen. A scene is what it shows (an
// app's front window, a fixed window, a display, or nothing) plus how it is
// arranged in each orientation. The built-in layouts are a scene's Layout
// choice, never something to switch to (D2), and one scene works in 16:9 and
// in 9:16 (D4). The camera device is one for every scene and lives in
// `captureConfig.sources` only (D9).

export const SCENES_KEY = 'videorc.scenes.v2'

export type SceneShows =
  | { kind: 'app'; bundleId: string; name: string; follows: boolean }
  | { kind: 'window'; windowId: string; windowName?: string }
  /**
   * An empty `screenId` is the main display before the device list has named
   * it (a new user's defaults): `withMainDisplay` writes the real one.
   */
  | { kind: 'display'; screenId: string; screenName?: string; screenUuid?: string }
  /** Shows no screen (Camera only); D18. */
  | { kind: 'none' }
  /** Development builds. */
  | { kind: 'test-pattern' }

export type Scene = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  shows: SceneShows
  layouts: { horizontal: LayoutSettings; vertical: LayoutSettings }
  background: SavedSceneBackground | null
  /** Only when pinned with Save audio to scene (D10). */
  audio?: SceneAudio
  /**
   * Plan 249 S12: the room's guest roles for this scene (⋯ → Guests in the
   * room…), a versioned extension kept as saved. The room adapter recomputes
   * the guests for the orientation it draws in from the placement it names.
   */
  cloud?: SavedSceneCloud
}

/**
 * The custom keys stay in `GlobalShortcutsConfig.scenes[id]`; the position
 * keys are S4's `scene-slot-1` … `scene-slot-9`.
 *
 * `pendingShortcuts` (D15) is the shortcuts after the layout keys moved to
 * scene keys, stored with the library the migration made and kept until the
 * settings that hold them are stored too. A launch cut short between the two
 * writes replays them: the same keys again, the library never made again.
 */
export type SceneLibrary = {
  version: 2
  scenes: Scene[]
  onStreamId: string
  pendingShortcuts?: GlobalShortcutsConfig
}

export type MainDisplay = Pick<Device, 'id' | 'name' | 'displayUuid'>

/** What the capture pickers hold, as a scene keeps it. */
export type ShowsSources = Required<Pick<VisualSources, 'captureOff' | 'testPattern'>> &
  Pick<VisualSources, 'screenId' | 'screenName' | 'screenUuid' | 'windowId' | 'windowName' | 'app'>

/** What a v1 scene's or the working setup's sources show. */
export function showsFromSources(sources: VisualSources): SceneShows {
  const app = normalizeSceneApp(sources.app)
  if (app) return { kind: 'app', ...app }
  if (sources.windowId)
    return {
      kind: 'window',
      windowId: sources.windowId,
      ...(sources.windowName ? { windowName: sources.windowName } : {})
    }
  if (sources.screenId || sources.screenName)
    return {
      kind: 'display',
      screenId: sources.screenId ?? '',
      ...(sources.screenName ? { screenName: sources.screenName } : {}),
      ...(sources.screenUuid ? { screenUuid: sources.screenUuid } : {})
    }
  if (sources.testPattern) return { kind: 'test-pattern' }
  if (sources.captureOff) return { kind: 'none' }
  // Nothing chosen yet is automatic selection in v1: the main display.
  return { kind: 'display', screenId: '' }
}

/**
 * The capture part of a source selection for what a scene shows. Every key is
 * written, so spreading it over a selection clears the previous screen. An
 * app's front window is resolved when the scene goes on stream.
 */
export function showsSources(shows: SceneShows): ShowsSources {
  const none: ShowsSources = {
    screenId: undefined,
    screenName: undefined,
    screenUuid: undefined,
    windowId: undefined,
    windowName: undefined,
    app: undefined,
    captureOff: false,
    testPattern: false
  }
  switch (shows.kind) {
    case 'app':
      return {
        ...none,
        app: { bundleId: shows.bundleId, name: shows.name, follows: shows.follows }
      }
    case 'window':
      return { ...none, windowId: shows.windowId, windowName: shows.windowName }
    case 'display':
      return {
        ...none,
        screenId: shows.screenId || undefined,
        screenName: shows.screenName,
        screenUuid: shows.screenUuid
      }
    case 'none':
      return { ...none, captureOff: true }
    case 'test-pattern':
      return { ...none, testPattern: true }
  }
}

/**
 * Whether two scenes show the same screen. A display's UUID decides when both
 * have one (plan 213 F1), else its id. Following is not part of it.
 */
export function sameShows(a: SceneShows, b: SceneShows): boolean {
  if (a.kind === 'app' && b.kind === 'app') return a.bundleId === b.bundleId
  if (a.kind === 'window' && b.kind === 'window') return a.windowId === b.windowId
  if (a.kind === 'display' && b.kind === 'display')
    return a.screenUuid && b.screenUuid
      ? a.screenUuid === b.screenUuid
      : a.screenId === b.screenId && (a.screenId !== '' || a.screenName === b.screenName)
  return a.kind === b.kind
}

function normalizeShows(raw: unknown): SceneShows {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid scene screen')
  const data = raw as Record<string, unknown>
  const optional = (key: string): string | undefined => {
    const value = data[key]
    if (value !== undefined && typeof value !== 'string') throw new Error('Invalid screen label')
    return value || undefined
  }
  switch (data.kind) {
    case 'app': {
      const app = normalizeSceneApp(data)
      if (!app) throw new Error('Invalid scene app')
      return { kind: 'app', ...app }
    }
    case 'window': {
      if (typeof data.windowId !== 'string' || !data.windowId) throw new Error('Invalid window')
      const windowName = optional('windowName')
      return { kind: 'window', windowId: data.windowId, ...(windowName ? { windowName } : {}) }
    }
    case 'display': {
      if (typeof data.screenId !== 'string') throw new Error('Invalid display')
      const screenName = optional('screenName')
      const screenUuid = optional('screenUuid')
      return {
        kind: 'display',
        screenId: data.screenId,
        ...(screenName ? { screenName } : {}),
        // As in v1: a UUID left over without its display is no pick.
        ...(screenUuid && (data.screenId || screenName) ? { screenUuid } : {})
      }
    }
    case 'none':
      return { kind: 'none' }
    case 'test-pattern':
      return { kind: 'test-pattern' }
    default:
      throw new Error('Unknown scene screen')
  }
}

/**
 * One stored scene, or a throw: a scene with a broken screen, a layout that
 * is not a built-in one, or a layout in the wrong orientation is rejected
 * whole. Invalid optional fields are dropped, never the scene.
 */
export function normalizeScene(raw: unknown): Scene {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid scene')
  const data = raw as Partial<Scene>
  if (
    typeof data.id !== 'string' ||
    !data.id ||
    data.id.length > 128 ||
    typeof data.name !== 'string' ||
    sceneNameError(data.name, []) ||
    typeof data.createdAt !== 'string' ||
    typeof data.updatedAt !== 'string' ||
    !data.layouts ||
    typeof data.layouts !== 'object'
  )
    throw new Error('Invalid scene')
  // The v1 visual check is the layout and background check: one rule for both.
  const visual = (layout: unknown, orientation: SceneOrientation): SceneVisual => {
    const normalized = normalizeSceneVisual({ layout, sources: {}, background: data.background })
    if (layoutPresetOrientation(normalized.layout.layoutPreset) !== orientation)
      throw new Error('Layout in the wrong orientation')
    return normalized
  }
  const horizontal = visual(data.layouts.horizontal, 'horizontal')
  const vertical = visual(data.layouts.vertical, 'vertical')
  const audio = normalizeSceneAudio(data.audio)
  const cloud = normalizeSavedSceneCloud(data.cloud)
  return {
    id: data.id,
    name: data.name.trim(),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    shows: normalizeShows(data.shows),
    layouts: { horizontal: horizontal.layout, vertical: vertical.layout },
    background: horizontal.background,
    ...(audio ? { audio } : {}),
    ...(cloud ? { cloud } : {})
  }
}

export const SCENES_UNKNOWN_VERSION_ERROR =
  'Update Videorc to open these scenes. Your saved data is preserved.'

/**
 * The stored v2 library. `library` is null when nothing is stored (migrate
 * from v1), when the version is one this build doesn't know (read-only: the
 * stored data must not be written over), or when no stored scene is usable.
 */
export function hydrateScenes(raw: unknown): {
  library: SceneLibrary | null
  readOnly: boolean
  error: string | null
} {
  if (raw == null) return { library: null, readOnly: false, error: null }
  const data = (typeof raw === 'object' ? raw : {}) as Partial<SceneLibrary>
  if (data.version !== 2)
    return { library: null, readOnly: true, error: SCENES_UNKNOWN_VERSION_ERROR }
  const entries: unknown[] = Array.isArray(data.scenes) ? data.scenes : []
  const scenes: Scene[] = []
  for (const entry of entries) {
    try {
      const scene = normalizeScene(entry)
      if (scenes.some(({ id }) => id === scene.id) || sceneNameError(scene.name, scenes)) continue
      scenes.push(scene)
    } catch {
      /* Reject only the malformed entry. */
    }
  }
  const error = scenes.length !== entries.length ? "Some invalid scenes couldn't be loaded." : null
  if (scenes.length === 0) return { library: null, readOnly: false, error }
  const pending = data.pendingShortcuts
  return {
    library: {
      version: 2,
      scenes,
      // A scene is always on stream: a lost id falls to the first scene.
      onStreamId: scenes.some(({ id }) => id === data.onStreamId)
        ? data.onStreamId!
        : scenes[0]!.id,
      ...(pending && typeof pending === 'object' && !Array.isArray(pending)
        ? { pendingShortcuts: pending }
        : {})
    },
    readOnly: false,
    error
  }
}

// The pure reads the Studio, the keys and the remotes share.

/** The scene at a 1-based position: position 1 answers to the first scene key (D5). */
export function sceneAtPosition<T extends { id: string }>(
  scenes: readonly T[],
  position: number
): T | undefined {
  return Number.isInteger(position) && position >= 1 ? scenes[position - 1] : undefined
}

/** A scene's 1-based position, or null when it is not in the list. */
export function scenePosition(scenes: readonly Pick<Scene, 'id'>[], id: string): number | null {
  const index = scenes.findIndex((scene) => scene.id === id)
  return index < 0 ? null : index + 1
}

/** The scene on stream. */
export function sceneOnStream(library: SceneLibrary): Scene {
  return library.scenes.find(({ id }) => id === library.onStreamId) ?? library.scenes[0]!
}

/** A scene's layout in a 16:9 or a 9:16 studio, or on that leg of a dual stream (D4). */
export function sceneLayout(
  scene: Pick<Scene, 'layouts'>,
  orientation: SceneOrientation
): LayoutSettings {
  return scene.layouts[orientation]
}

/** Whether a layout puts a screen on stream: Freeform, or a built-in layout with a screen. */
export function layoutShowsScreen(layout: LayoutSettings): boolean {
  return layout.arrangementMode === 'freeform' || layoutPresetNeedsScreen(layout.layoutPreset)
}

/**
 * The first scene whose layout in this orientation is `preset` (D14: where a
 * remote's legacy `layoutPreset` goes). A Freeform arrangement is not its
 * underlying layout.
 */
export function firstSceneWithLayout<S extends Pick<Scene, 'layouts'>>(
  scenes: readonly S[],
  orientation: SceneOrientation,
  preset: LayoutPreset
): S | undefined {
  return scenes.find((scene) => {
    const layout = sceneLayout(scene, orientation)
    return layout.layoutPreset === preset && layout.arrangementMode !== 'freeform'
  })
}

export const KEEP_ONE_SCENE_REASON = 'Keep at least one scene.'
export const DELETE_ON_STREAM_REASON = 'Switch to another scene first.'
export const GOING_ON_STREAM_REASON = 'This scene is going on stream. Try again in a moment.'

/**
 * Whether a scene can be deleted (D16). The last scene never can, nor can a
 * scene a switch is putting on stream (`goingOn`), so the stream never lands
 * on a scene the library no longer has. Off air, deleting the scene on stream
 * first switches to the scene before it (`switchToId`; the one after, for the
 * first scene). While recording or live, the scene on stream can't be deleted.
 */
export function canDeleteScene(input: {
  scenes: readonly Pick<Scene, 'id'>[]
  id: string
  onStreamId: string
  sessionActive: boolean
  goingOn?: boolean
}): { allowed: true; switchToId: string | null } | { allowed: false; reason: string | null } {
  const index = input.scenes.findIndex((scene) => scene.id === input.id)
  if (index < 0) return { allowed: false, reason: null }
  if (input.scenes.length <= 1) return { allowed: false, reason: KEEP_ONE_SCENE_REASON }
  if (input.goingOn) return { allowed: false, reason: GOING_ON_STREAM_REASON }
  if (input.id !== input.onStreamId) return { allowed: true, switchToId: null }
  if (input.sessionActive) return { allowed: false, reason: DELETE_ON_STREAM_REASON }
  return { allowed: true, switchToId: input.scenes[index > 0 ? index - 1 : 1]!.id }
}

/**
 * The library with the main display written into every scene that shows it
 * without knowing which it is. The same library when there is nothing to write.
 */
export function withMainDisplay(library: SceneLibrary, mainDisplay: MainDisplay): SceneLibrary {
  const waits = ({ shows }: Scene): boolean =>
    shows.kind === 'display' && !shows.screenId && !shows.screenName
  if (!mainDisplay.id || !library.scenes.some(waits)) return library
  return {
    ...library,
    scenes: library.scenes.map((scene) =>
      waits(scene) ? { ...scene, shows: displayShows(mainDisplay) } : scene
    )
  }
}

/** A display as a scene shows it; the main display not named yet when there is none. */
export function displayShows(display: MainDisplay | null | undefined): SceneShows {
  return {
    kind: 'display',
    screenId: display?.id ?? '',
    ...(display?.name ? { screenName: display.name } : {}),
    ...(display?.displayUuid && display.id ? { screenUuid: display.displayUuid } : {})
  }
}
