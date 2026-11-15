import { useCallback, useMemo, useRef } from 'react'
import { useScenes } from '@/hooks/use-scenes'
import type { AppPreviewsParams, AppPreviewsResult, Device } from '@/lib/backend'
import {
  normalizeSceneAudio,
  normalizeSceneVisual,
  sceneNameError,
  type SavedScene,
  type SceneAudio,
  type SceneOrientation,
  type SceneVisual
} from '@/lib/scene-presets'
import {
  sceneDisplayRefreshed,
  sceneEditAutosave,
  sceneFromSaved,
  sceneWithShows,
  savedSceneView,
  type SceneCamera
} from '@/lib/scene-studio'
import { sceneOnStream, type Scene, type SceneShows } from '@/lib/scenes'
import { toast } from '@/lib/toast'

/**
 * Plan 210 S5: what New scene…, the scene list and its ⋯ menu need beyond
 * apply, save, rename and delete. The Studio provides it.
 */
export type SceneLibraryActions = {
  readOnly: boolean
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

/**
 * Plan 231 S2: the scene library as the Studio uses it. The stored scenes
 * (`useScenes`, v2) are read as visual snapshots in the studio's orientation
 * with the one shared camera, the shape the apply, preflight and list code
 * already takes, and every edit is written back as a stored scene.
 */
export function useSceneLibrary(orientation: SceneOrientation, camera: SceneCamera) {
  const library = useScenes()
  const latest = useRef(library)
  latest.current = library
  const { cameraId, cameraName, cameraOff } = camera
  const scenes = useMemo(
    () =>
      library.scenes.map((scene) =>
        savedSceneView(scene, orientation, { cameraId, cameraName, cameraOff })
      ),
    [library.scenes, orientation, cameraId, cameraName, cameraOff]
  )
  const stored = useCallback(
    (id: string | null | undefined): Scene | undefined =>
      id ? latest.current.read().scenes.find((scene) => scene.id === id) : undefined,
    []
  )
  const onStream = useCallback((): Scene => sceneOnStream(latest.current.read()), [])
  /** Save scene…: a scene from the current look, at the end (D5), or an edit of `id`. */
  const save = useCallback(
    (
      name: string,
      visual: SceneVisual,
      audio: SceneAudio | undefined,
      id?: string
    ): string | null => {
      const error = sceneNameError(name, latest.current.read().scenes, id)
      if (error) {
        toast.error(error)
        return null
      }
      const previous = stored(id)
      const now = new Date().toISOString()
      const sceneAudio = normalizeSceneAudio(audio)
      const scene = sceneFromSaved(
        {
          id: previous?.id ?? crypto.randomUUID(),
          name: name.trim(),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          visual: normalizeSceneVisual(visual),
          ...(sceneAudio ? { audio: sceneAudio } : {})
        },
        previous ?? onStream()
      )
      return (previous ? latest.current.replace(scene) : latest.current.insert([scene]))
        ? scene.id
        : null
    },
    [onStream, stored]
  )
  /** New scenes go at the end (D5); a duplicate goes right after its original. */
  const insert = useCallback(
    (added: readonly SavedScene[], afterId?: string): boolean => {
      const template = stored(afterId) ?? onStream()
      return latest.current.insert(
        added.map((scene) => sceneFromSaved(scene, template)),
        afterId
      )
    },
    [onStream, stored]
  )
  /** A ⋯ edit (Change app…, following, audio, repaired sources): the scene in its place. */
  const replace = useCallback(
    (scene: SavedScene): boolean => {
      const previous = stored(scene.id)
      return previous ? latest.current.replace(sceneFromSaved(scene, previous)) : false
    },
    [stored]
  )
  const rename = useCallback((id: string, name: string) => latest.current.rename(id, name), [])
  const move = useCallback((id: string, toIndex: number) => latest.current.move(id, toIndex), [])
  const remove = useCallback(
    (id: string, options: { sessionActive: boolean }) => latest.current.remove(id, options),
    []
  )
  const setOnStream = useCallback((id: string) => latest.current.setOnStream(id), [])
  /** D11: a commit made while the scene was on stream saves its look, and a picked screen. */
  const autosave = useCallback(
    (
      previous: { sceneId: string | null; shows: SceneShows | null },
      sceneId: string | null,
      visual: SceneVisual
    ): boolean => {
      const scene = sceneEditAutosave({
        previousSceneId: previous.sceneId,
        previousShows: previous.shows,
        sceneId,
        scenes: latest.current.read().scenes,
        visual,
        now: new Date().toISOString()
      })
      return scene ? latest.current.replace(scene) : false
    },
    []
  )
  /** D2: a Screen pick changes the screen of the scene on stream. */
  const setShows = useCallback(
    (id: string | null, shows: SceneShows): boolean => {
      const previous = stored(id)
      const scene = previous ? sceneWithShows(previous, shows, new Date().toISOString()) : null
      return scene ? latest.current.replace(scene) : false
    },
    [stored]
  )
  const refreshDisplay = useCallback(
    (id: string, devices: readonly Device[]): boolean => {
      const previous = stored(id)
      const scene = previous ? sceneDisplayRefreshed(previous, devices) : null
      return scene ? latest.current.replace(scene) : false
    },
    [stored]
  )
  /** Several scenes edited in one write (first-run setup's look). */
  const editAll = useCallback(
    (edit: (scenes: readonly Scene[]) => Scene[]): boolean => latest.current.replaceAll(edit),
    []
  )
  const nameMainDisplay = useCallback(
    (display: Device) => latest.current.nameMainDisplay(display),
    []
  )
  // `storedList` is the stored scenes as this render has them: it changes
  // with every stored edit, where `storedScenes()` reads them as they are now.
  return {
    scenes,
    /** A stored scene by id, as it is now. */
    stored,
    /** The stored scenes, as they are now. */
    storedScenes: useCallback((): readonly Scene[] => latest.current.read().scenes, []),
    storedList: library.scenes,
    onStreamId: library.onStreamId,
    error: library.error,
    readOnly: library.readOnly,
    migratedShortcuts: library.migratedShortcuts,
    save,
    rename,
    remove,
    insert,
    move,
    replace,
    autosave,
    setShows,
    setOnStream,
    refreshDisplay,
    editAll,
    nameMainDisplay
  }
}
