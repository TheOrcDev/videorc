import { useCallback, useRef, useState } from 'react'
import type { AppPreviewsParams, AppPreviewsResult } from '@/lib/backend'
import { toast } from '@/lib/toast'
import { loadJson } from '@/lib/capture'
import { sceneAutosave } from '@/lib/scene-autosave'
import { movedScenes } from '@/lib/scene-order'
import {
  hydrateSceneLibrary,
  normalizeSceneAudio,
  normalizeSceneVisual,
  sceneNameError,
  SCENE_LIBRARY_KEY,
  type SceneAudio,
  type SceneVisual,
  type SavedScene
} from '@/lib/scene-presets'

/**
 * Plan 210 S5: what New scene…, the scene list and its ⋯ menu need beyond
 * apply, save, rename and delete. The Studio provides it.
 */
export type SceneLibraryActions = {
  readOnly: boolean
  /** Where the working scene came from: a built-in layout, or a saved scene (on, or left). */
  workingOrigin: 'builtin' | 'saved'
  /** The look on stream: New scene… makes its scenes in it. */
  workingVisual: SceneVisual
  /** What's on now: Save audio to scene writes it. */
  workingAudio: SceneAudio
  insert: (scenes: readonly SavedScene[], afterId?: string) => boolean
  move: (id: string, toIndex: number) => boolean
  replace: (scene: SavedScene) => boolean
  /** S4's pictures of each app's front window, only while the picker is open. */
  listAppPreviews: (params?: AppPreviewsParams) => Promise<AppPreviewsResult>
}

export function useScenePresets() {
  const [state, setState] = useState(() => hydrateSceneLibrary(loadJson(SCENE_LIBRARY_KEY, null)))
  const current = useRef(state)
  current.current = state
  const write = useCallback((scenes: SavedScene[]): boolean => {
    if (current.current.readOnly) return false
    const library = { version: 1 as const, scenes }
    try {
      localStorage.setItem(SCENE_LIBRARY_KEY, JSON.stringify(library))
      current.current = { ...current.current, library }
      setState(current.current)
      return true
    } catch {
      toast.error("Couldn't save the scene", {
        id: 'scene-save-storage',
        description: 'Free up disk space, then save it again.'
      })
      return false
    }
  }, [])
  const save = useCallback(
    (
      name: string,
      visual: SceneVisual,
      audio: SceneAudio | undefined,
      id?: string
    ): string | null => {
      const scenes = current.current.library.scenes
      const error = sceneNameError(name, scenes, id)
      if (error) {
        toast.error(error)
        return null
      }
      const previous = scenes.find((entry) => entry.id === id)
      const now = new Date().toISOString()
      const sceneAudio = normalizeSceneAudio(audio)
      const scene: SavedScene = {
        id: previous?.id ?? crypto.randomUUID(),
        name: name.trim(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        visual: normalizeSceneVisual(visual),
        ...(sceneAudio ? { audio: sceneAudio } : {})
      }
      return write(
        previous
          ? scenes.map((entry) => (entry.id === scene.id ? scene : entry))
          : [...scenes, scene]
      )
        ? scene.id
        : null
    },
    [write]
  )
  const rename = useCallback(
    (id: string, name: string): boolean => {
      const scene = current.current.library.scenes.find((entry) => entry.id === id)
      return scene ? save(name, scene.visual, scene.audio, id) !== null : false
    },
    [save]
  )
  const remove = useCallback(
    (id: string): boolean =>
      write(current.current.library.scenes.filter((entry) => entry.id !== id)),
    [write]
  )
  // Plan 210 S5. New scene…'s scenes go to the top of the library, a
  // duplicate right after its original; a drag or ⌥↑ ⌥↓ moves one. Names
  // stay unique: a scene whose name is taken is refused, never renamed here.
  const insert = useCallback(
    (added: readonly SavedScene[], afterId?: string): boolean => {
      const scenes = current.current.library.scenes
      const names = [...scenes]
      for (const scene of added) {
        if (sceneNameError(scene.name, names)) return false
        names.push(scene)
      }
      const at = afterId ? scenes.findIndex((entry) => entry.id === afterId) + 1 : 0
      return write([...scenes.slice(0, at), ...added, ...scenes.slice(at)])
    },
    [write]
  )
  const move = useCallback(
    (id: string, toIndex: number): boolean => {
      const next = movedScenes(current.current.library.scenes, id, toIndex)
      return next ? write(next) : false
    },
    [write]
  )
  /** A ⋯ edit (Change app…, following, audio): the scene in its place. */
  const replace = useCallback(
    (scene: SavedScene): boolean => {
      const scenes = current.current.library.scenes
      if (
        !scenes.some((entry) => entry.id === scene.id) ||
        sceneNameError(scene.name, scenes, scene.id)
      )
        return false
      return write(scenes.map((entry) => (entry.id === scene.id ? scene : entry)))
    },
    [write]
  )
  /** D3: a commit made while the scene was on writes its look (never its sources or audio). */
  const autosave = useCallback(
    (previousSceneId: string | null, sceneId: string | null, visual: SceneVisual): boolean => {
      const scene = sceneAutosave({
        previousSceneId,
        sceneId,
        scenes: current.current.library.scenes,
        visual,
        now: new Date().toISOString()
      })
      return scene ? replace(scene) : false
    },
    [replace]
  )
  return {
    scenes: state.library.scenes,
    error: state.error,
    readOnly: state.readOnly,
    save,
    rename,
    remove,
    insert,
    move,
    replace,
    autosave
  }
}
