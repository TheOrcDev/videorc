import type { CameraBackground, LayoutSettings } from '../../../shared/backend'
import {
  CAMERA_BACKGROUND_MIGRATION_SETTLES,
  CAMERA_BACKGROUND_MIGRATION_VERSION,
  cameraBackgroundMigrated,
  DEFAULT_CAMERA_BACKGROUND,
  normalizeCameraBackgrounds,
  normalizeHideEdges,
  normalizeKey
} from './camera-background'

// Plan 258 D4: the scenes' green or blue screen moves to the camera, once.
// Its own module, loaded on demand: since S5 it settles on its first run, so
// the launch bundle never carries it (renderer asset budget, plan 113).

type KeyedLayout = Pick<
  LayoutSettings,
  | 'cameraChromaKeyEnabled'
  | 'cameraChromaKeyColor'
  | 'cameraChromaKeySimilarityPct'
  | 'cameraChromaKeySmoothnessPct'
  | 'cameraChromaKeySpillPct'
  | 'cameraChromaKeyEdges'
>

/** What the migration reads of a scene: its id and both layouts. */
export type CameraBackgroundMigrationScene = {
  id: string
  layouts: { horizontal: KeyedLayout; vertical: KeyedLayout }
}

/** The scene's keyed layout: the landscape one first (the vertical leg takes the program's key). */
function keyedLayout(scene: CameraBackgroundMigrationScene): KeyedLayout | undefined {
  return [scene.layouts.horizontal, scene.layouts.vertical].find(
    (layout) => layout?.cameraChromaKeyEnabled === true
  )
}

/**
 * The key's colour as `greenScreenColor` (lib/green-screen) reads it: blue
 * only for blue, any other hex keys green. Kept here so this module stays
 * free of UI imports (`capture.ts` and the node contract tests load it).
 */
function keyColor(layout: Pick<KeyedLayout, 'cameraChromaKeyColor'>): 'green' | 'blue' {
  return layout.cameraChromaKeyColor.toUpperCase() === '#0000FF' ? 'blue' : 'green'
}

export type CameraBackgroundMigration = {
  cameraBackgrounds: Record<string, CameraBackground> | undefined
  cameraBackgroundMigration: number | undefined
}

/**
 * D4: the key moves to the camera. The camera's choice becomes Green or Blue
 * screen with the tuning of the scene on stream if that scene keys, else of
 * the first scene that does; with no keyed scene, a screen the camera has
 * goes Off, keeping its tuning. An effect already picked for the camera
 * (blur, a picture, Cut out) is never replaced by a key. The scenes are left
 * as they are, so a rollback loses nothing.
 *
 * It runs again on every change of the scenes or the camera until it
 * settles (`settle`, CAMERA_BACKGROUND_MIGRATION_SETTLES), so a key turned
 * on or off in a scene before then still reaches the camera. A key waits
 * for a selected camera rather than being lost.
 *
 * `null` when there is nothing to write: already settled, no camera for a
 * keyed scene, or the settings already say what the scenes do.
 */
export function migrateCameraBackgrounds(input: {
  cameraBackgrounds: Record<string, CameraBackground> | undefined
  cameraBackgroundMigration: number | undefined
  cameraId: string | undefined
  scenes: readonly CameraBackgroundMigrationScene[]
  onStreamId: string | null | undefined
  settle?: boolean
}): CameraBackgroundMigration | null {
  if (cameraBackgroundMigrated(input.cameraBackgroundMigration)) return null
  const settle = input.settle ?? CAMERA_BACKGROUND_MIGRATION_SETTLES
  const backgrounds = normalizeCameraBackgrounds(input.cameraBackgrounds) ?? {}
  const result = (next: Record<string, CameraBackground>): CameraBackgroundMigration | null => {
    const migration: CameraBackgroundMigration = {
      cameraBackgrounds: Object.keys(next).length > 0 ? next : undefined,
      cameraBackgroundMigration: settle
        ? CAMERA_BACKGROUND_MIGRATION_VERSION
        : input.cameraBackgroundMigration
    }
    const unchanged =
      migration.cameraBackgroundMigration === input.cameraBackgroundMigration &&
      JSON.stringify(migration.cameraBackgrounds) === JSON.stringify(input.cameraBackgrounds)
    return unchanged ? null : migration
  }
  const onStream = input.scenes.find((scene) => scene.id === input.onStreamId)
  const keyed =
    (onStream ? keyedLayout(onStream) : undefined) ??
    input.scenes.map(keyedLayout).find((layout) => layout !== undefined)
  if (!keyed) {
    const current = input.cameraId ? backgrounds[input.cameraId] : undefined
    if (input.cameraId && current && (current.mode === 'green' || current.mode === 'blue'))
      return result({ ...backgrounds, [input.cameraId]: { ...current, mode: 'off' } })
    return result(backgrounds)
  }
  if (!input.cameraId) return null
  const current = backgrounds[input.cameraId] ?? DEFAULT_CAMERA_BACKGROUND
  if (current.mode !== 'off' && current.mode !== 'green' && current.mode !== 'blue')
    return result(backgrounds)
  const hideEdges = normalizeHideEdges(keyed.cameraChromaKeyEdges)
  const migrated: CameraBackground = {
    ...current,
    mode: keyColor(keyed),
    key: normalizeKey({
      similarityPct: keyed.cameraChromaKeySimilarityPct,
      smoothnessPct: keyed.cameraChromaKeySmoothnessPct,
      spillPct: keyed.cameraChromaKeySpillPct,
      ...(hideEdges ? { hideEdges } : {})
    })
  }
  return result({ ...backgrounds, [input.cameraId]: migrated })
}
