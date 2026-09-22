import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { loadJson } from '@/lib/capture'
import {
  hydrateSceneLibrary,
  normalizeSceneVisual,
  sceneNameError,
  SCENE_LIBRARY_KEY,
  type SceneVisual,
  type SavedScene
} from '@/lib/scene-presets'

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
      toast.error('Scene could not be saved. Storage is unavailable or full.')
      return false
    }
  }, [])
  const save = useCallback(
    (name: string, visual: SceneVisual, id?: string): string | null => {
      const scenes = current.current.library.scenes
      const error = sceneNameError(name, scenes, id)
      if (error) {
        toast.error(error)
        return null
      }
      const previous = scenes.find((entry) => entry.id === id)
      const now = new Date().toISOString()
      const scene: SavedScene = {
        id: previous?.id ?? crypto.randomUUID(),
        name: name.trim(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        visual: normalizeSceneVisual(visual)
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
      return scene ? save(name, scene.visual, id) !== null : false
    },
    [save]
  )
  const remove = useCallback(
    (id: string): boolean =>
      write(current.current.library.scenes.filter((entry) => entry.id !== id)),
    [write]
  )
  return {
    scenes: state.library.scenes,
    error: state.error,
    readOnly: state.readOnly,
    save,
    rename,
    remove
  }
}
