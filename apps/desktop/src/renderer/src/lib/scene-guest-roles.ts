import type { LayoutPreset } from '@/lib/backend'
import { layoutPresetOrientation } from '@/lib/capture'
import type { SavedScene, SavedSceneCloud } from '@/lib/scene-presets'
import {
  SCENE_EXTENSION_VERSION,
  SCENE_MAX_GUEST_SLOTS,
  defaultSceneGuests,
  type SceneGuests,
  type SceneOrientation,
  type SceneRect
} from '../../../shared/cloud-scene'

/**
 * Plan 249 S12, D7: where a talk show's guests go while this saved scene is
 * on the room program. Chosen per scene (⋯ → Guests in the room…) and saved
 * as the scene's versioned `cloud` extension; the native fields are untouched.
 *
 * - `beside`: the stable default (landscape: a column on the right; portrait:
 *   a band below). A scene saved before guest roles uses it.
 * - `below`: the scene above, guests in a band along the bottom.
 * - `over`: the scene keeps the whole frame; guests are explicit small boxes
 *   over its bottom edge, one per guest, up to six.
 */
export type SceneGuestPlacement = 'beside' | 'below' | 'over'
export const SCENE_GUEST_PLACEMENTS: readonly SceneGuestPlacement[] = ['beside', 'below', 'over']
export const SCENE_GUEST_PLACEMENT_LABELS: Record<SceneGuestPlacement, string> = {
  beside: 'Beside',
  below: 'Below',
  over: 'Over the scene'
}

/** The scene's orientation is its preset's (Freeform keeps one underneath). */
export function sceneOrientation(preset: LayoutPreset): SceneOrientation {
  return layoutPresetOrientation(preset) === 'vertical' ? 'v' : 'h'
}

/** Small 16:9 boxes over the bottom edge, as canvas fractions. */
function overSlots(orientation: SceneOrientation): SceneRect[] {
  if (orientation === 'h')
    return Array.from({ length: SCENE_MAX_GUEST_SLOTS }, (_, i) => ({
      x: 0.02 + i * 0.16,
      y: 0.81,
      w: 0.15,
      h: 0.15
    }))
  // Portrait: two rows of three 16:9 boxes (0.3 of the width is 0.095 of the height).
  return Array.from({ length: SCENE_MAX_GUEST_SLOTS }, (_, i) => ({
    x: 0.035 + (i % 3) * 0.32,
    y: 0.78 + Math.floor(i / 3) * 0.105,
    w: 0.3,
    h: 0.095
  }))
}

export function sceneGuestRoles(
  placement: SceneGuestPlacement,
  orientation: SceneOrientation
): SceneGuests {
  if (placement === 'below')
    return {
      host: { x: 0.125, y: 0, w: 0.75, h: 0.75 },
      region: { x: 0, y: 0.75, w: 1, h: 0.25 },
      slots: []
    }
  if (placement === 'over')
    return {
      host: { x: 0, y: 0, w: 1, h: 1 },
      region: { x: 0, y: 0.78, w: 1, h: 0.22 },
      slots: overSlots(orientation)
    }
  return defaultSceneGuests(orientation)
}

/** The placement a saved scene keeps; `beside` when it keeps none (or a newer version). */
export function sceneGuestPlacement(scene: Pick<SavedScene, 'cloud'>): SceneGuestPlacement {
  const placement = scene.cloud?.version === SCENE_EXTENSION_VERSION ? scene.cloud.placement : null
  return SCENE_GUEST_PLACEMENTS.includes(placement as SceneGuestPlacement)
    ? (placement as SceneGuestPlacement)
    : 'beside'
}

/** The saved scene with these guest roles; its native fields are unchanged. */
export function sceneWithGuestRoles(
  scene: SavedScene,
  placement: SceneGuestPlacement,
  now: string
): SavedScene {
  const cloud: SavedSceneCloud = {
    version: SCENE_EXTENSION_VERSION,
    placement,
    guests: sceneGuestRoles(placement, sceneOrientation(scene.visual.layout.layoutPreset))
  }
  return { ...scene, updatedAt: now, cloud }
}

/**
 * Plan 231 D4 on plan 249 S12: one scene works in 16:9 and in 9:16, so the
 * guest roles saved with it are drawn in the orientation the room program
 * uses now, from the placement they name. An extension that names no known
 * placement (a newer version, or guests saved without one) is kept as is.
 */
export function sceneExtensionForOrientation(
  extension: unknown,
  orientation: SceneOrientation
): unknown {
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) return extension
  const cloud = extension as { version?: unknown; placement?: unknown }
  if (cloud.version !== SCENE_EXTENSION_VERSION) return extension
  if (!SCENE_GUEST_PLACEMENTS.includes(cloud.placement as SceneGuestPlacement)) return extension
  return {
    ...cloud,
    guests: sceneGuestRoles(cloud.placement as SceneGuestPlacement, orientation)
  }
}
