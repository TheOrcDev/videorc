import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalShortcutsConfig } from '@/lib/backend'
import {
  defaultCaptureConfig,
  loadCaptureConfig,
  loadJson,
  STORAGE_KEYS,
  type SettingsState
} from '@/lib/capture'
import { movedScenes } from '@/lib/scene-order'
import {
  hydrateSceneLibrary,
  hydrateWorkingScene,
  SCENE_LIBRARY_KEY,
  sceneNameError,
  WORKING_SCENE_KEY
} from '@/lib/scene-presets'
import {
  canDeleteScene,
  hydrateScenes,
  migrateToScenes,
  normalizeScene,
  SCENES_KEY,
  type Scene,
  type SceneLibrary
} from '@/lib/scenes'
import { toast } from '@/lib/toast'

type ScenesState = {
  library: SceneLibrary
  readOnly: boolean
  error: string | null
  /**
   * The shortcuts after the layout keys moved to scene keys (D15), on the
   * launch that migrated; null on every other launch. The Studio saves them
   * with its settings.
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

/**
 * The scene library as stored, or migrated from v1 and the working setup when
 * v2 is missing (plan 231 D15). Reads only: the hook writes the migration.
 * A version this build doesn't know is never written over: the scenes are
 * then today's setup, in memory, read-only.
 */
export function loadScenes(): ScenesState {
  const stored = hydrateScenes(read(SCENES_KEY))
  if (stored.library)
    return {
      library: stored.library,
      readOnly: false,
      error: stored.error,
      migratedShortcuts: null,
      unwritten: false
    }
  let migrated: ReturnType<typeof migrateToScenes>
  try {
    const settings = read(STORAGE_KEYS.settings) as Partial<SettingsState> | null
    migrated = migrateToScenes(
      stored.readOnly ? null : hydrateSceneLibrary(read(SCENE_LIBRARY_KEY)).library,
      hydrateWorkingScene(read(WORKING_SCENE_KEY)),
      loadCaptureConfig(),
      settings?.globalShortcuts
    )
  } catch {
    migrated = migrateToScenes(null, null, defaultCaptureConfig, undefined)
  }
  return {
    library: migrated.library,
    readOnly: stored.readOnly,
    error: stored.error,
    migratedShortcuts: stored.readOnly ? null : migrated.globalShortcuts,
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
      write({ version: 2, scenes, onStreamId }),
    [write]
  )
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
        normalized = added.map(normalizeScene)
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
        normalized = normalizeScene(scene)
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
      const verdict = canDeleteScene({ scenes, id, onStreamId, ...options })
      if (!verdict.allowed) return false
      return writeScenes(
        scenes.filter((scene) => scene.id !== id),
        verdict.switchToId ?? onStreamId
      )
    },
    [writeScenes]
  )
  return {
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
    remove
  }
}
