import type { LayoutPreset, LayoutSettings } from './backend'
import {
  hydrateWorkingScene,
  normalizeSavedSceneCloud,
  normalizeSceneApp,
  normalizeSceneAudio,
  normalizeSceneVisual,
  sceneNameError,
  type SceneOrientation,
  type SceneVisual
} from './scene-presets'
import {
  defaultCaptureConfig,
  HORIZONTAL_LAYOUT_PRESETS,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  layoutPresetOrientation
} from './capture'
import { canonicalJson } from './scene-visibility-identity'
import {
  DELETE_ON_STREAM_REASON,
  GOING_ON_STREAM_REASON,
  KEEP_ONE_SCENE_REASON,
  sameShows,
  showsFromSources,
  type MainDisplay,
  type Scene,
  type SceneLibrary,
  type SceneShows
} from './scenes'

// Plan 231: reading and checking the stored scene library. Its own chunk,
// loaded by `prepareScenes` (hooks/use-scenes.ts) before the Studio first
// renders, so the entry chunk carries none of it.

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
        : {}),
      ...(data.verticalLayoutsRepaired === true ? { verticalLayoutsRepaired: true } : {})
    },
    readOnly: false,
    error
  }
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

/** A display as a scene shows it; the main display not named yet when there is none. */
export function displayShows(display: MainDisplay | null | undefined): SceneShows {
  return {
    kind: 'display',
    screenId: display?.id ?? '',
    ...(display?.name ? { screenName: display.name } : {}),
    ...(display?.displayUuid && display.id ? { screenUuid: display.displayUuid } : {})
  }
}

/** The ids the migration gives the four default scenes: stable, so a second run names the same scenes. */
export const defaultSceneId = (preset: LayoutPreset): string => `default-${preset}`

/** Whether two built-in layouts put the same sources on stream: a screen or not, a camera or not. */
export function presetsShowSameSources(a: LayoutPreset, b: LayoutPreset): boolean {
  return (
    layoutPresetNeedsScreen(a) === layoutPresetNeedsScreen(b) &&
    layoutPresetNeedsCamera(a) === layoutPresetNeedsCamera(b)
  )
}

/**
 * The 9:16 layout that shows what a 16:9 built-in layout shows: Camera only
 * and Screen only their own, a screen with a camera (Screen + camera, Side by
 * side) the 9:16 layout a new user starts on, Camera top.
 */
export function verticalTwinPreset(preset: LayoutPreset): LayoutPreset {
  if (layoutPresetOrientation(preset) === 'vertical') return preset
  if (preset === 'camera-only') return 'vertical-camera-only'
  if (preset === 'screen-only') return 'vertical-screen-only'
  return defaultCaptureConfig.lastVerticalPreset
}

/** `layout` on its 9:16 twin, in preset arrangement, with its own look and framing. */
function onVerticalTwin(layout: LayoutSettings, horizontal: LayoutPreset): LayoutSettings {
  return {
    ...layout,
    layoutPreset: verticalTwinPreset(horizontal),
    cameraTransformMode: 'preset',
    cameraTransform: null,
    arrangementMode: 'preset',
    sourceTransformOverrides: {}
  }
}

/**
 * Owner report 2026-11-23 (0.37.0): plan 231's migration (0.34.0) gave every
 * scene the 9:16 layout the vertical stream used to show for it, which for
 * anything but Camera only and Screen only was the one remembered 9:16
 * layout. A streamer whose last 9:16 pick was Camera only got a "Screen +
 * camera" and a "Side by side" that show only the camera in 9:16 ("No
 * screen"), with their screen still assigned.
 *
 * Once per library (`verticalLayoutsRepaired`), each default scene the
 * migration made (its id, its own 16:9 layout, neither in Freeform) whose
 * 9:16 layout shows other sources than its 16:9 one is put on its 9:16 twin
 * (`verticalTwinPreset`), keeping its look and framing. Nothing else is
 * touched: saved scenes, renamed defaults' names, screens, keys, audio and
 * backgrounds stay, as do invalid entries a hydrate would drop. When the
 * scene is the one a 9:16 studio shows right now, exactly as stored, the
 * working setup is moved with it, so the program and its card never drift.
 *
 * Takes and returns what is stored (the raw JSON), so the caller writes the
 * library and, when given, the working setup. Null when there is nothing to
 * write: no usable library, or one already repaired.
 */
export function repairStoredSceneVerticals(
  rawLibrary: unknown,
  rawWorking: unknown
): {
  library: Record<string, unknown>
  working: Record<string, unknown> | null
  repaired: string[]
} | null {
  const { library } = hydrateScenes(rawLibrary)
  if (!library || library.verticalLayoutsRepaired) return null
  const repairedScenes = new Map<string, Scene>()
  const before = new Map<string, LayoutSettings>()
  for (const preset of HORIZONTAL_LAYOUT_PRESETS) {
    const scene = library.scenes.find(({ id }) => id === defaultSceneId(preset))
    if (!scene) continue
    const { horizontal, vertical } = scene.layouts
    if (
      horizontal.layoutPreset !== preset ||
      horizontal.arrangementMode === 'freeform' ||
      vertical.arrangementMode === 'freeform' ||
      presetsShowSameSources(preset, vertical.layoutPreset)
    )
      continue
    before.set(scene.id, vertical)
    repairedScenes.set(scene.id, {
      ...scene,
      layouts: { horizontal, vertical: onVerticalTwin(vertical, preset) }
    })
  }
  const raw = rawLibrary as Record<string, unknown>
  const entries: unknown[] = Array.isArray(raw.scenes) ? raw.scenes : []
  const nextLibrary = {
    ...raw,
    scenes: entries.map((entry) => {
      const id = (entry as { id?: unknown } | null)?.id
      return (typeof id === 'string' && repairedScenes.get(id)) || entry
    }),
    verticalLayoutsRepaired: true
  }
  const working = hydrateWorkingScene(rawWorking)
  const workingScene = working?.sceneId ? repairedScenes.get(working.sceneId) : undefined
  const workingBefore = working?.sceneId ? before.get(working.sceneId) : undefined
  const movesWorking =
    !!working &&
    !!workingScene &&
    !!workingBefore &&
    layoutPresetOrientation(working.visual.layout.layoutPreset) === 'vertical' &&
    canonicalJson(working.visual.layout) === canonicalJson(workingBefore)
  const rawWorkingData = rawWorking as Record<string, unknown> | null
  return {
    library: nextLibrary,
    working:
      movesWorking && rawWorkingData
        ? {
            ...rawWorkingData,
            visual: {
              ...(rawWorkingData.visual as Record<string, unknown>),
              layout: workingScene.layouts.vertical
            }
          }
        : null,
    repaired: [...repairedScenes.keys()]
  }
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
