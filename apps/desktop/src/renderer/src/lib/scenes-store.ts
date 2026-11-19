import {
  normalizeSavedSceneCloud,
  normalizeSceneApp,
  normalizeSceneAudio,
  normalizeSceneVisual,
  sceneNameError,
  type SceneOrientation,
  type SceneVisual
} from './scene-presets'
import { layoutPresetOrientation } from './capture'
import {
  DELETE_ON_STREAM_REASON,
  GOING_ON_STREAM_REASON,
  KEEP_ONE_SCENE_REASON,
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
        : {})
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
