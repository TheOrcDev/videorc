import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'

import { SceneSwitchPending } from '@/components/scene/scene-switch-status'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useAppIcons } from '@/hooks/use-app-icons'
import { scenePictureTargetKey, useScenePictures } from '@/hooks/use-scene-pictures'
import { useStudioCore } from '@/hooks/use-studio'
import { shortcutAriaKeys } from '@/lib/platform'
import {
  MOVE_SCENE_DOWN_ACCELERATOR,
  MOVE_SCENE_LEFT_ACCELERATOR,
  MOVE_SCENE_RIGHT_ACCELERATOR,
  MOVE_SCENE_UP_ACCELERATOR,
  savedSceneBlockedReason,
  sceneGlyph,
  sceneMoveKeyStep,
  type SceneGlyph
} from '@/lib/scene-list'
import type { GlobalShortcutsConfig } from '@/lib/backend'
import type { SavedScene } from '@/lib/scene-presets'
import {
  sceneCardsCameraGaps,
  sceneCardWords,
  scenePictureTarget,
  sceneSlotKeysLine
} from '@/lib/scene-section'

// Plan 231 D8: Studio's Scenes section (cards) and the Scene page (rows) list
// the same scenes the same way. Both read each scene through this one hook
// and move scenes through the one below, so the two lists can't drift: the
// same words, the same reasons, the same keys, the same pictures, the same
// reorder. Part of the lazy scene UI.

/** Why a scene list can't change: the library is from a newer Videorc. */
export const SCENES_READ_ONLY_REASON = 'Update Videorc to change your scenes.'

/**
 * The line under both lists' title (D5): "Each scene shows its own screen.
 * ⌃⌥1 to ⌃⌥9 switch them from any app." in the platform's keys, or the
 * general words once the streamer changed the first or ninth key.
 */
export function ScenesLine({
  config,
  platform
}: {
  config: GlobalShortcutsConfig | undefined
  platform: string | undefined
}): ReactElement {
  const keys = sceneSlotKeysLine(config, platform)
  if (!keys)
    return <>Each scene shows its own screen. A scene&apos;s key switches to it from any app.</>
  return (
    <>
      Each scene shows its own screen.{' '}
      <ShortcutKeys accelerator={keys.first} platform={platform} variant="text" /> to{' '}
      <ShortcutKeys accelerator={keys.last} platform={platform} variant="text" /> switch them from
      any app.
    </>
  )
}

/** One scene as Studio's card and the Scene page's row show it. */
export interface SceneEntry {
  scene: SavedScene
  /** Its place in the list, from 1: the position key's number (D5). */
  position: number
  onStream: boolean
  /** Going on stream now (issue #1275). Another scene's click takes it over. */
  pending: boolean
  /** It can't be chosen now: its own reason, the camera it needs (D9), or a switch to it running. */
  disabled: boolean
  /** Its own reason while it can't be chosen ("Figma isn't open", or the camera's line). */
  disabledReason: string | null
  /** The quiet words: the pending mark, why it can't go on, "Resolve sources", or what it shows. */
  meta: ReactNode
  /** The icon of what it shows: the app's, else a glyph. */
  glyph: SceneGlyph
  /** The still of its screen (D7), once one came back. */
  picture: string | undefined
}

/**
 * Every scene, in order, as both lists show it. `needsSources` is
 * `useSceneDialogs().needsSources`. The stills come from one
 * `useScenePictures` call per list: a window shows one page at a time, so
 * Studio's section and the Scene page never ask at once.
 */
export function useSceneEntries(needsSources: (scene: SavedScene) => boolean): {
  entries: SceneEntry[]
  /** The apps' icons, for `SceneGlyphIcon`. */
  icons: ReadonlyMap<string, string | null>
  /** Why the scenes that need the camera are off, said once under the list, or null. */
  cameraReason: string | null
} {
  const {
    savedScenes,
    activeSavedSceneId,
    savedScenePendingId,
    savedSceneAppStates,
    deviceList,
    screenPrivacy,
    isSessionActive
  } = useStudioCore()
  const glyphs = new Map(
    savedScenes.map((scene) => [scene.id, sceneGlyph(scene, deviceList.devices)])
  )
  const icons = useAppIcons([
    ...new Set([
      ...savedScenes.flatMap((scene) =>
        scene.visual.sources.app ? [scene.visual.sources.app.bundleId] : []
      ),
      ...[...glyphs.values()].flatMap((glyph) => (glyph.kind === 'app' ? [glyph.bundleId] : []))
    ])
  ])
  // D7: one still per thing shown (three scenes on Display 1 share one).
  const pictureTargets = new Map(
    savedScenes.flatMap((scene) => {
      const target = scenePictureTarget(scene.visual)
      return target ? [[scene.id, target] as const] : []
    })
  )
  const stills = useScenePictures({
    targets: [
      ...new Map(
        [...pictureTargets.values()].map((target) => [scenePictureTargetKey(target), target])
      ).values()
    ],
    hidden: screenPrivacy.hidden,
    busy: isSessionActive
  })
  const camera = sceneCardsCameraGaps(savedScenes, deviceList.devices)
  const entries = savedScenes.map((scene, index): SceneEntry => {
    const pending = savedScenePendingId === scene.id
    const blocked = savedSceneBlockedReason({
      scene,
      appState: savedSceneAppStates[scene.id],
      devices: deviceList.devices
    })
    const cameraBlocked = camera.blocked.has(scene.id)
    const target = pictureTargets.get(scene.id)
    return {
      scene,
      position: index + 1,
      onStream: activeSavedSceneId === scene.id,
      pending,
      disabled: blocked !== null || cameraBlocked || pending,
      disabledReason: blocked ?? (cameraBlocked ? camera.reason : null),
      meta: pending ? (
        <SceneSwitchPending />
      ) : (
        (blocked ??
        // A scene for an app never asks for its window again: S2 resolves it.
        (!cameraBlocked && !scene.visual.sources.app && needsSources(scene)
          ? 'Resolve sources'
          : sceneCardWords(scene)))
      ),
      glyph: glyphs.get(scene.id)!,
      picture: target ? stills.get(scenePictureTargetKey(target)) : undefined
    }
  })
  return { entries, icons, cameraReason: camera.reason }
}

/** Where a dragged scene would land, beside the one under the pointer. */
export type SceneDropEdge = 'before' | 'after'

/**
 * Reorder (D5, D8): drag a scene, or ⌥ and an arrow on a focused one (⌥← ⌥→
 * across Studio's cards, ⌥↑ ⌥↓ down the Scene page's rows; WCAG 2.1.1, never
 * only by dragging). The keys move with the places. A scene moved by its keys
 * keeps the focus: React may move its node, and a moved node loses focus, so
 * it is found again by the scene's id (`data-saved-scene`) inside
 * `containerRef`, at `focusSelector`. A library this build can't change
 * never moves.
 */
export function useSceneReorder({
  axis,
  focusSelector
}: {
  axis: 'horizontal' | 'vertical'
  /** The scene's focusable button, inside its `[data-saved-scene]`. */
  focusSelector: string
}): {
  containerRef: RefObject<HTMLDivElement | null>
  /** The move keys for `aria-keyshortcuts`, or undefined while the library is read-only. */
  keyShortcuts: string | undefined
  /** The drag handlers for the scene at `index`. */
  dragProps: (
    id: string,
    index: number
  ) => {
    draggable: boolean
    onDragStart: (event: DragEvent<HTMLElement>) => void
    onDragEnter: () => void
    onDragOver: (event: DragEvent<HTMLElement>) => void
    onDragEnd: () => void
    onDrop: (event: DragEvent<HTMLElement>) => void
  }
  /** The scene being dragged. */
  dragging: (id: string) => boolean
  /** Where the dragged scene would land beside the one at `index`, or null. */
  dropEdge: (index: number) => SceneDropEdge | null
  /** The focused scene's keys: ⌥ and an arrow move it one place. */
  onMoveKey: (id: string, index: number) => (event: KeyboardEvent<HTMLElement>) => void
} {
  const { savedScenes, sceneLibraryActions, runtimeInfo } = useStudioCore()
  const readOnly = sceneLibraryActions.readOnly
  const platform = runtimeInfo?.platform
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const draggingIndex = savedScenes.findIndex((scene) => scene.id === draggingId)
  const endDrag = (): void => {
    setDraggingId(null)
    setDropIndex(null)
  }
  const containerRef = useRef<HTMLDivElement>(null)
  const refocusId = useRef<string | null>(null)
  useEffect(() => {
    const id = refocusId.current
    if (!id) return
    refocusId.current = null
    const item = [...(containerRef.current?.querySelectorAll('[data-saved-scene]') ?? [])].find(
      (entry) => entry.getAttribute('data-saved-scene') === id
    )
    item?.querySelector<HTMLElement>(focusSelector)?.focus()
  }, [savedScenes, focusSelector])
  const [back, forward] =
    axis === 'horizontal'
      ? [MOVE_SCENE_LEFT_ACCELERATOR, MOVE_SCENE_RIGHT_ACCELERATOR]
      : [MOVE_SCENE_UP_ACCELERATOR, MOVE_SCENE_DOWN_ACCELERATOR]
  return {
    containerRef,
    keyShortcuts: readOnly
      ? undefined
      : `${shortcutAriaKeys(back, platform)} ${shortcutAriaKeys(forward, platform)}`,
    dragProps: (id, index) => ({
      draggable: !readOnly,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move'
        setDraggingId(id)
      },
      onDragEnter: () => {
        if (draggingId && draggingId !== id) setDropIndex(index)
      },
      onDragOver: (event) => event.preventDefault(),
      onDragEnd: endDrag,
      onDrop: (event) => {
        event.preventDefault()
        if (draggingId && draggingId !== id) sceneLibraryActions.move(draggingId, index)
        endDrag()
      }
    }),
    dragging: (id) => draggingId === id,
    dropEdge: (index) =>
      dropIndex === index && draggingIndex >= 0 && draggingIndex !== index
        ? draggingIndex < index
          ? 'after'
          : 'before'
        : null,
    onMoveKey: (id, index) => (event) => {
      if (readOnly) return
      const step = sceneMoveKeyStep(event, axis)
      if (step === null) return
      event.preventDefault()
      if (sceneLibraryActions.move(id, index + step)) refocusId.current = id
    }
  }
}
