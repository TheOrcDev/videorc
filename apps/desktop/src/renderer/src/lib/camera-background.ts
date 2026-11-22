import {
  CAMERA_BACKGROUND_EDGES,
  CAMERA_BACKGROUND_MODES,
  CAMERA_BACKGROUND_STRONG_BLUR_PCT,
  CAMERA_KEY_EDGE_MAX_PCT,
  type CameraBackground,
  type CameraBackgroundEdges,
  type CameraBackgroundKey,
  type CameraBackgroundMode,
  type CameraKeyEdges,
  type LayoutSettings
} from '../../../shared/backend'
import { cameraLookLayout } from './camera-look'

// Plan 258 S1: one background per camera, kept in every scene (D3), stored
// in the settings beside `cameraLooks` and put on the layout at the output
// boundary the way the look is. Green and blue screen are two of its picks
// (D4); a scene's own key fields stay readable for one release, so a rollback
// loses nothing. S3's stage draws the blur and the picture; since S5 the
// camera's choice is also what keys (once the D4 migration has settled), so
// the Studio and the Scene page edit only this setting.

/** What a camera has before anything is picked: Off, with Strong blur ready. */
export const DEFAULT_CAMERA_BACKGROUND: CameraBackground = {
  mode: 'off',
  blurPct: CAMERA_BACKGROUND_STRONG_BLUR_PCT,
  edges: 'balanced'
}

/**
 * An effect the camera effect stage draws (a blur, a picture, a video, Cut
 * out), as opposed to Off or a screen key. The privacy rules (D2, D6) and
 * the room's fail-closed rule (S5, before S8) apply to these.
 */
export function cameraBackgroundIsEffect(
  background: Pick<CameraBackground, 'mode'> | undefined | null
): boolean {
  return (
    background?.mode === 'blur' ||
    background?.mode === 'image' ||
    background?.mode === 'video' ||
    background?.mode === 'cutout'
  )
}

/** The D4 migration's version, stored once it settles. */
export const CAMERA_BACKGROUND_MIGRATION_VERSION = 1

/**
 * Whether the D4 migration settles (stores its version and stops). S5 made
 * the camera's choice what renders (`cameraBackgroundLayout` keys from it
 * once the version is stored), so the next run moves the scenes' keys as
 * they are then and never runs again. Before S5 it followed the scenes on
 * every run and stored nothing.
 */
export const CAMERA_BACKGROUND_MIGRATION_SETTLES = true

/** True once the D4 migration has moved the scenes' keys to the camera. */
export function cameraBackgroundMigrated(version: number | undefined): boolean {
  return (version ?? 0) >= CAMERA_BACKGROUND_MIGRATION_VERSION
}

const ASSET_ID_MAX = 256

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

function normalizeHideEdges(value: unknown): CameraKeyEdges | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<Record<keyof CameraKeyEdges, unknown>>
  const edges: CameraKeyEdges = {
    leftPct: clampInt(raw.leftPct, 0, 0, CAMERA_KEY_EDGE_MAX_PCT),
    topPct: clampInt(raw.topPct, 0, 0, CAMERA_KEY_EDGE_MAX_PCT),
    rightPct: clampInt(raw.rightPct, 0, 0, CAMERA_KEY_EDGE_MAX_PCT),
    bottomPct: clampInt(raw.bottomPct, 0, 0, CAMERA_KEY_EDGE_MAX_PCT)
  }
  return Object.values(edges).some((pct) => pct > 0) ? edges : undefined
}

/** The scene key's defaults (`defaultCaptureConfig.layout`), for a key stored without one. */
const DEFAULT_KEY: CameraBackgroundKey = { similarityPct: 40, smoothnessPct: 8, spillPct: 10 }

function normalizeKey(value: unknown): CameraBackgroundKey | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<Record<keyof CameraBackgroundKey, unknown>>
  const hideEdges = normalizeHideEdges(raw.hideEdges)
  return {
    similarityPct: clampInt(raw.similarityPct, DEFAULT_KEY.similarityPct, 0, 100),
    smoothnessPct: clampInt(raw.smoothnessPct, DEFAULT_KEY.smoothnessPct, 0, 100),
    spillPct: clampInt(raw.spillPct, DEFAULT_KEY.spillPct, 0, 100),
    ...(hideEdges ? { hideEdges } : {})
  }
}

/**
 * A stored or received background, bounded; `undefined` when it isn't one.
 * An unknown mode reads as Off, never as an effect it might not be.
 */
export function normalizeCameraBackground(value: unknown): CameraBackground | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<Record<keyof CameraBackground, unknown>>
  const mode: CameraBackgroundMode = (CAMERA_BACKGROUND_MODES as readonly unknown[]).includes(
    raw.mode
  )
    ? (raw.mode as CameraBackgroundMode)
    : 'off'
  const edges: CameraBackgroundEdges = (CAMERA_BACKGROUND_EDGES as readonly unknown[]).includes(
    raw.edges
  )
    ? (raw.edges as CameraBackgroundEdges)
    : DEFAULT_CAMERA_BACKGROUND.edges
  const assetId =
    typeof raw.assetId === 'string' && raw.assetId.length > 0 && raw.assetId.length <= ASSET_ID_MAX
      ? raw.assetId
      : undefined
  const key = normalizeKey(raw.key)
  return {
    mode,
    blurPct: clampInt(raw.blurPct, DEFAULT_CAMERA_BACKGROUND.blurPct, 0, 100),
    edges,
    ...(assetId ? { assetId } : {}),
    ...(key ? { key } : {})
  }
}

/** Every camera's stored background, bounded; cameras with nothing usable are dropped. */
export function normalizeCameraBackgrounds(
  value: unknown
): Record<string, CameraBackground> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const backgrounds: Record<string, CameraBackground> = {}
  for (const [cameraId, stored] of Object.entries(value)) {
    const background = cameraId ? normalizeCameraBackground(stored) : undefined
    if (background) backgrounds[cameraId] = background
  }
  return Object.keys(backgrounds).length > 0 ? backgrounds : undefined
}

/** The two screen colours as the key's hex (lib/green-screen's, kept here free of UI imports). */
const KEY_HEX = { green: '#00FF00', blue: '#0000FF' } as const

/**
 * The layout's key fields from the camera's choice (D4): on, with the
 * colour and tuning, for Green or Blue screen; off for anything else, so a
 * key never runs with a blur or a picture. Only the switch changes for Off,
 * so the fields a rollback reads keep their last tuning.
 */
function cameraKeyLayout(base: LayoutSettings, background: CameraBackground | undefined) {
  if (background?.mode !== 'green' && background?.mode !== 'blue')
    return base.cameraChromaKeyEnabled ? { ...base, cameraChromaKeyEnabled: false } : base
  const key = background.key ?? DEFAULT_KEY
  const { cameraChromaKeyEdges: _edges, ...rest } = base
  return {
    ...rest,
    cameraChromaKeyEnabled: true,
    cameraChromaKeyColor: KEY_HEX[background.mode],
    cameraChromaKeySimilarityPct: key.similarityPct,
    cameraChromaKeySmoothnessPct: key.smoothnessPct,
    cameraChromaKeySpillPct: key.spillPct,
    ...(key.hideEdges ? { cameraChromaKeyEdges: key.hideEdges } : {})
  }
}

/**
 * The layout an output gets: the selected camera's background on it, or none
 * while that camera's is Off (so layouts from before plan 258 go out as they
 * were). A previous camera's background never carries over.
 *
 * `keyFromCamera` (true once the D4 migration has settled): the key fields
 * come from the camera's choice too, so one pick is the whole truth and a
 * scene's own key can't come back on, beside a blur or after Off. Before the
 * migration has run the scene's key goes out as it was.
 */
export function cameraBackgroundLayout(
  layout: LayoutSettings,
  cameraId: string | undefined,
  backgrounds: Record<string, CameraBackground> | undefined,
  keyFromCamera = false
): LayoutSettings {
  const { cameraBackground: _previous, ...rest } = layout
  const cameraBackground = normalizeCameraBackground(cameraId ? backgrounds?.[cameraId] : undefined)
  const base = keyFromCamera ? cameraKeyLayout(rest, cameraBackground) : rest
  return cameraBackground && cameraBackground.mode !== 'off' ? { ...base, cameraBackground } : base
}

/**
 * The output boundary: the selected camera's look and background on the
 * layout, from the settings that keep them per camera. Every session start,
 * live layout change and Preview update goes through here.
 */
export function cameraOutputLayout(
  layout: LayoutSettings,
  cameraId: string | undefined,
  settings: {
    cameraLooks?: Parameters<typeof cameraLookLayout>[2]
    cameraBackgrounds?: Record<string, CameraBackground>
    cameraBackgroundMigration?: number
  }
): LayoutSettings {
  return cameraBackgroundLayout(
    cameraLookLayout(layout, cameraId, settings.cameraLooks),
    cameraId,
    settings.cameraBackgrounds,
    cameraBackgroundMigrated(settings.cameraBackgroundMigration)
  )
}

/**
 * One camera's background set in the settings (the Studio's and the Scene
 * page's picks): stored under the camera that renders, or nothing for no
 * camera. Off is kept with its tuning, so picking Blur again finds it.
 */
export function withCameraBackground(
  backgrounds: Record<string, CameraBackground> | undefined,
  cameraId: string | undefined,
  background: CameraBackground
): Record<string, CameraBackground> | undefined {
  if (!cameraId) return backgrounds
  const normalized = normalizeCameraBackground(background)
  if (!normalized) return backgrounds
  return { ...backgrounds, [cameraId]: normalized }
}

/** The selected camera's background, Off with Strong blur ready when it has none. */
export function cameraBackgroundFor(
  backgrounds: Record<string, CameraBackground> | undefined,
  cameraId: string | undefined
): CameraBackground {
  return (
    normalizeCameraBackground(cameraId ? backgrounds?.[cameraId] : undefined) ??
    DEFAULT_CAMERA_BACKGROUND
  )
}

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
