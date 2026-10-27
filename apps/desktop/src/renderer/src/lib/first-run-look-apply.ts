import type { CameraShape, LayoutPreset, LayoutSettings } from './backend'
import {
  LIVE_BACKGROUND_DEFAULT_LOOKS,
  type LiveBackgroundId
} from '../../../shared/live-background-ids'
import {
  applyLiveBackground as applyLiveBackgroundToRegistry,
  liveBackgroundSettings,
  type BackgroundAssetRegistry
} from './background-assets'
import {
  layoutPresetMemoryPatch,
  layoutPresetOrientation,
  studioModeTogglePreset,
  verticalOrientationVideoPatch,
  type CaptureConfig,
  type LayoutOrientation
} from './capture'
import { recalledLayoutFraming, rememberLayoutFraming } from './layout-framing-memory'

// Plan 207 S4: the "Your look" step of first-run setup writes the same state
// the Studio's own controls write, without a layout transaction. A
// transaction (`scene.layout.apply_preview`) starts the camera and screen the
// layout needs, which goes around plan 203's holds and would raise the OS
// prompt for a never-asked camera. A `captureConfig` change instead reaches
// the backend through the scene reload (`scene.load_from_capture_config`),
// an idle commit that starts nothing and carries the background.
//
// This half is what the Studio provider applies, so it ships in the eager
// bundle; the step's options (`first-run-look.ts`) load with setup.

/** What "Your look" chooses; the orientation is the preset's orientation. */
export type FirstRunLook = {
  orientation: LayoutOrientation
  layoutPreset: LayoutPreset
  cameraShape: CameraShape
  /** A live background in its first look, or None. */
  liveBackgroundId: LiveBackgroundId | null
}

export type FirstRunLookChoice = Pick<FirstRunLook, 'orientation' | 'layoutPreset' | 'cameraShape'>

/**
 * The preset a look lands on: its own when it belongs to the orientation,
 * otherwise the scene remembered for that orientation (the gallery's toggle).
 */
export function firstRunLookPreset(
  config: Pick<CaptureConfig, 'lastHorizontalPreset' | 'lastVerticalPreset'>,
  choice: Pick<FirstRunLookChoice, 'orientation' | 'layoutPreset'>
): LayoutPreset {
  return layoutPresetOrientation(choice.layoutPreset) === choice.orientation
    ? choice.layoutPreset
    : studioModeTogglePreset(choice.orientation, config)
}

/**
 * The Scene page's Shape write (`layout-tab.tsx`): Rounded means a rounded
 * SQUARE by default, so picking it snaps the aspect to square in the same
 * gesture; Circle draws a circle whatever the aspect, and Rectangle keeps it.
 */
export function cameraShapeLayoutPatch(cameraShape: CameraShape): Partial<LayoutSettings> {
  return cameraShape === 'rounded'
    ? { cameraShape: 'rounded', cameraAspect: 'square' }
    : { cameraShape }
}

/**
 * The `captureConfig` the Studio would hold after the gallery applied
 * `layoutPreset` (`requestCameraPresetTransaction` + the transaction's
 * commit point) and the Scene page set `cameraShape`: the preset's remembered
 * framing, Preset mode with no freeform overrides, the orientation ⇄ canvas
 * coupling (vertical presets take the 1080×1920 canvas and remember the
 * landscape one; leaving restores it), and the per-mode scene memory.
 * Off-air only: setup never runs beside a session.
 */
export function firstRunLookPatch(
  config: CaptureConfig,
  choice: FirstRunLookChoice
): CaptureConfig {
  const current = config.layout.layoutPreset
  const layoutPreset = firstRunLookPreset(config, choice)
  const layout: LayoutSettings = {
    ...config.layout,
    ...recalledLayoutFraming(config.layoutFramingMemory, current, layoutPreset),
    arrangementMode: 'preset',
    sourceTransformOverrides: {},
    layoutPreset,
    ...cameraShapeLayoutPatch(choice.cameraShape),
    cameraTransformMode: 'preset',
    cameraTransform: null
  }
  const coupling = verticalOrientationVideoPatch(
    current,
    layoutPreset,
    config.video,
    config.verticalRestoreVideo
  )
  return {
    ...config,
    ...(coupling ?? {}),
    ...layoutPresetMemoryPatch(layoutPreset),
    layout,
    layoutFramingMemory: rememberLayoutFraming(config.layoutFramingMemory, layout)
  }
}

/**
 * The registry after Assets' tile for `id` was clicked in its FIRST look
 * (plan 207 D8: setup offers each live background in its first look), or
 * after the background was taken off (None). The same registry when nothing
 * changes. Motion, dim and visibility stay as remembered.
 */
export function firstRunBackgroundChoice(
  registry: BackgroundAssetRegistry,
  id: LiveBackgroundId | null
): BackgroundAssetRegistry {
  if (id === null) {
    return registry.activeSlotId === null && registry.live.activeId === null
      ? registry
      : { ...registry, activeSlotId: null, live: { ...registry.live, activeId: null } }
  }
  const next = applyLiveBackgroundToRegistry(registry, id)
  const settings = liveBackgroundSettings(registry, id)
  const look = LIVE_BACKGROUND_DEFAULT_LOOKS[id]
  if (settings.look === look) {
    return registry.activeSlotId === null && registry.live.activeId === id ? registry : next
  }
  return {
    ...next,
    live: { ...next.live, settings: { ...next.live.settings, [id]: { ...settings, look } } }
  }
}

/** The live background a registry shows, or null for a picture or None. */
export function registryLiveBackgroundId(
  registry: Pick<BackgroundAssetRegistry, 'activeSlotId' | 'live'>
): LiveBackgroundId | null {
  return registry.activeSlotId === null ? registry.live.activeId : null
}

/**
 * Whether the look's writes must wait for setup to close (plan 207 edge
 * case "Replay while Clips runs"). The idle reload is refused while any
 * backend session runs (`commit_idle_scene_with_layout` bails with a session
 * present), and the Clips ring is one: a replay of setup from Settings lets a
 * running ring keep running (`firstRunReplayLocked`). The look is then held
 * and applied through the Studio's own transaction once the workspace shows,
 * where opening the layout's devices is what a Studio change does. On a first
 * launch nothing runs (setup holds the ring's start), so writes land at once.
 */
export function firstRunLookWritesHeld(recording: { state: string }): boolean {
  return (
    recording.state === 'starting' ||
    recording.state === 'recording' ||
    recording.state === 'streaming' ||
    recording.state === 'stopping'
  )
}

export type BackgroundLibrarySyncDecision = 'skip' | 'hold' | 'apply'

/**
 * Whether the background library sync (a layout transaction that puts the
 * library's background on the scene) may run: never for a background already
 * applied, and never while setup is open (plan 207 S4: a transaction starts
 * the scene's devices). A held change runs once the workspace shows, unless
 * setup's own writes already carried it through the idle reload and kept the
 * applied fingerprint in step.
 */
export function backgroundLibrarySyncDecision(input: {
  setupOpen: boolean
  fingerprint: string
  applied: string
}): BackgroundLibrarySyncDecision {
  if (input.fingerprint === input.applied) return 'skip'
  return input.setupOpen ? 'hold' : 'apply'
}
