import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalShortcutsConfig } from '@/lib/backend'
import { loadJson } from '@/lib/capture'
import { movedScenes } from '@/lib/scene-order'
import { sceneNameError } from '@/lib/scene-presets'
import { SCENES_KEY, type MainDisplay, type Scene, type SceneLibrary } from '@/lib/scenes'
import { toast } from '@/lib/toast'

type ScenesState = {
  library: SceneLibrary
  readOnly: boolean
  error: string | null
  /**
   * The shortcuts after the layout keys moved to scene keys (D15), from the
   * launch that migrated until the settings holding them are stored
   * (`settleShortcuts`); null otherwise. The Studio saves them with its
   * settings, again on a launch the first one never finished.
   */
  migratedShortcuts: GlobalShortcutsConfig | null
  /** The migrated library is not stored yet. */
  unwritten: boolean
}

function read(key: string): unknown {
  try {
    return loadJson<unknown>(key, null)
  } catch {
    return null
  }
}

/** The migration `prepareScenes` made for this launch, when the profile needed one. */
let prepared: { library: SceneLibrary; globalShortcuts: GlobalShortcutsConfig } | null = null

/** The library's reader (`lib/scenes-store`), loaded by `prepareScenes`. */
let store: typeof import('@/lib/scenes-store') | null = null

function scenesStore(): typeof import('@/lib/scenes-store') {
  if (!store) throw new Error('The scene library was read before it was prepared.')
  return store
}

/** D16's delete rule (`canDeleteScene`), once the library is prepared. */
export function sceneDeletion(
  input: Parameters<typeof import('@/lib/scenes-store').canDeleteScene>[0]
): ReturnType<typeof import('@/lib/scenes-store').canDeleteScene> {
  return scenesStore().canDeleteScene(input)
}

/** D11's autosave rule (`sceneEditAutosave`), once the library is prepared. */
export function sceneAutosave(
  input: Parameters<typeof import('@/lib/scenes-store').sceneEditAutosave>[0]
): ReturnType<typeof import('@/lib/scenes-store').sceneEditAutosave> {
  return scenesStore().sceneEditAutosave(input)
}

/** Whether the stored library can be read as it is, with no migration. */
export function scenesStored(): boolean {
  return store !== null && store.hydrateScenes(read(SCENES_KEY)).library !== null
}

/**
 * Before the Studio first renders: the library's reader is loaded (its own
 * chunk, so the entry carries none of it), and a profile with no usable
 * scene library gets one made from its v1 scenes and working setup (plan
 * 231 D15). The migration is a chunk of its own too, loaded only on the
 * launch that needs it.
 */
export async function prepareScenes(): Promise<void> {
  store ??= await import('@/lib/scenes-store')
  const stored = store.hydrateScenes(read(SCENES_KEY))
  if (stored.library) return
  const { migrateStoredScenes } = await import('@/lib/scenes-migration')
  prepared = migrateStoredScenes({ readOnly: stored.readOnly })
}

/**
 * The scene library as stored, or the one `prepareScenes` migrated from v1
 * and the working setup when v2 is missing. Reads only: the hook writes the
 * migration. A version this build doesn't know is never written over: the
 * scenes are then today's setup, in memory, read-only.
 */
export function loadScenes(): ScenesState {
  const stored = scenesStore().hydrateScenes(read(SCENES_KEY))
  if (stored.library)
    return {
      library: stored.library,
      readOnly: false,
      error: stored.error,
      // D15: a migration whose settings were never stored is replayed.
      migratedShortcuts: stored.library.pendingShortcuts ?? null,
      unwritten: false
    }
  if (!prepared) throw new Error('The scene library was read before it was prepared.')
  return {
    library: stored.readOnly
      ? prepared.library
      : { ...prepared.library, pendingShortcuts: prepared.globalShortcuts },
    readOnly: stored.readOnly,
    error: stored.error,
    migratedShortcuts: stored.readOnly ? null : prepared.globalShortcuts,
    unwritten: !stored.readOnly
  }
}

/**
 * Plan 231: the scene library, `videorc.scenes.v2`. Every write is the whole
 * library in one `setItem`; `videorc.scene-presets.v1` is read once to
 * migrate and never written, so a downgrade still finds its scenes.
 */
export function useScenes() {
  const [state, setState] = useState(loadScenes)
  const current = useRef(state)
  current.current = state
  const write = useCallback((library: SceneLibrary, options?: { quiet?: boolean }): boolean => {
    if (current.current.readOnly) return false
    try {
      localStorage.setItem(SCENES_KEY, JSON.stringify(library))
    } catch {
      if (!options?.quiet)
        toast.error("Couldn't save the scene", {
          id: 'scene-save-storage',
          description: 'Free up disk space, then save it again.'
        })
      return false
    }
    current.current = { ...current.current, library, unwritten: false }
    setState(current.current)
    return true
  }, [])
  // The migration is stored once, after the first render. A failed write
  // keeps the scenes in memory, and the next change or launch writes them.
  useEffect(() => {
    if (current.current.unwritten) write(current.current.library, { quiet: true })
  }, [write])

  const writeScenes = useCallback(
    (scenes: Scene[], onStreamId = current.current.library.onStreamId): boolean =>
      write({ ...current.current.library, version: 2, scenes, onStreamId }),
    [write]
  )
  /**
   * D15: the settings now hold the migrated keys and are stored, so the
   * library stops keeping them. Until this lands, every launch saves them
   * into the settings again.
   */
  const settleShortcuts = useCallback((): boolean => {
    const { pendingShortcuts, ...library } = current.current.library
    if (!pendingShortcuts) return true
    if (!write(library, { quiet: true })) return false
    current.current = { ...current.current, migratedShortcuts: null }
    setState(current.current)
    return true
  }, [write])
  /**
   * New scenes go at the end, so making one never moves a key in use (D5); a
   * duplicate goes right after its original. Names stay unique: a taken name
   * is refused, never renamed here.
   */
  const insert = useCallback(
    (added: readonly Scene[], afterId?: string): boolean => {
      const { scenes } = current.current.library
      const all = [...scenes]
      let normalized: Scene[]
      try {
        normalized = added.map(scenesStore().normalizeScene)
      } catch {
        return false
      }
      for (const scene of normalized) {
        if (all.some(({ id }) => id === scene.id) || sceneNameError(scene.name, all)) return false
        all.push(scene)
      }
      const after = afterId ? scenes.findIndex(({ id }) => id === afterId) : -1
      const at = after < 0 ? scenes.length : after + 1
      return writeScenes([...scenes.slice(0, at), ...normalized, ...scenes.slice(at)])
    },
    [writeScenes]
  )
  /** An edit of one scene, in its place: its screen, a layout, its name, its audio. */
  const replace = useCallback(
    (scene: Scene): boolean => {
      const { scenes } = current.current.library
      if (!scenes.some(({ id }) => id === scene.id) || sceneNameError(scene.name, scenes, scene.id))
        return false
      let normalized: Scene
      try {
        normalized = scenesStore().normalizeScene(scene)
      } catch {
        return false
      }
      return writeScenes(scenes.map((entry) => (entry.id === scene.id ? normalized : entry)))
    },
    [writeScenes]
  )
  const rename = useCallback(
    (id: string, name: string): boolean => {
      const { scenes } = current.current.library
      const scene = scenes.find((entry) => entry.id === id)
      if (!scene) return false
      const error = sceneNameError(name, scenes, id)
      if (error) {
        toast.error(error)
        return false
      }
      return replace({ ...scene, name: name.trim(), updatedAt: new Date().toISOString() })
    },
    [replace]
  )
  /** Reordering moves the position keys with the positions (D5). */
  const move = useCallback(
    (id: string, toIndex: number): boolean => {
      const next = movedScenes(current.current.library.scenes, id, toIndex)
      return next ? writeScenes(next) : false
    },
    [writeScenes]
  )
  /** Which scene is on stream. The Studio calls it once the switch is confirmed. */
  const setOnStream = useCallback(
    (id: string): boolean => {
      const { scenes, onStreamId } = current.current.library
      if (!scenes.some((scene) => scene.id === id)) return false
      return id === onStreamId || writeScenes(scenes, id)
    },
    [writeScenes]
  )
  /**
   * Delete, by D16's rule (`canDeleteScene`). When the scene on stream goes,
   * the library names the scene before it in the same write: the Studio
   * switches to `canDeleteScene(…).switchToId` first.
   */
  const remove = useCallback(
    (id: string, options: { sessionActive: boolean }): boolean => {
      const { scenes, onStreamId } = current.current.library
      const verdict = sceneDeletion({ scenes, id, onStreamId, ...options })
      if (!verdict.allowed) return false
      return writeScenes(
        scenes.filter((scene) => scene.id !== id),
        verdict.switchToId ?? onStreamId
      )
    },
    [writeScenes]
  )
  /**
   * The main display, once the device list names it, for the scenes that show
   * it without knowing which it is (a new user's defaults). Not an edit.
   */
  const nameMainDisplay = useCallback(
    (display: MainDisplay): boolean => {
      const { library } = current.current
      const next = scenesStore().withMainDisplay(library, display)
      return next !== library && write(next, { quiet: true })
    },
    [write]
  )
  /** Several scenes edited in one write (first-run setup's look). */
  const replaceAll = useCallback(
    (edit: (scenes: readonly Scene[]) => Scene[]): boolean => {
      const { scenes } = current.current.library
      let normalized: Scene[]
      try {
        normalized = edit(scenes).map(scenesStore().normalizeScene)
      } catch {
        return false
      }
      if (
        normalized.length !== scenes.length ||
        normalized.some((scene, index) => scene.id !== scenes[index]!.id)
      )
        return false
      return writeScenes(normalized)
    },
    [writeScenes]
  )
  /** The library as written, before the next render shows it. */
  const read = useCallback((): SceneLibrary => current.current.library, [])
  return {
    read,
    scenes: state.library.scenes,
    onStreamId: state.library.onStreamId,
    error: state.error,
    readOnly: state.readOnly,
    migratedShortcuts: state.migratedShortcuts,
    insert,
    replace,
    rename,
    move,
    setOnStream,
    remove,
    nameMainDisplay,
    replaceAll,
    settleShortcuts
  }
}
