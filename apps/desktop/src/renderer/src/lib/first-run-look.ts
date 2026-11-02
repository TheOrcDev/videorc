import {
  HORIZONTAL_LAYOUT_PRESETS,
  VERTICAL_LAYOUT_PRESETS,
  type CameraShape,
  type Device,
  type LayoutPreset,
  type LayoutSettings,
  type MediaAccessSnapshot,
  type SourceSelection
} from './backend'
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
import { layoutPresetLabel } from './layout-labels'
import { sceneSourceGaps, usingVisualSources, type SceneSourceGap } from './scene-presets'

// Plan 207 S4: the "Your look" step of first-run setup writes the same state
// the Studio's own controls write, without a layout transaction. A
// transaction (`scene.layout.apply_preview`) starts the camera and screen the
// layout needs, which goes around plan 203's holds and would raise the OS
// prompt for a never-asked camera. A `captureConfig` change instead reaches
// the backend through the scene reload (`scene.load_from_capture_config`),
// an idle commit that starts nothing and carries the background.
//
// The setup chunk imports this module and the Studio provider loads it on
// demand, so none of it ships in the eager bundle; the two checks the
// provider runs on every render live in `first-run.ts`.

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
 * coupling (vertical presets take the portrait twin of the chosen canvas and
 * remember the landscape one; leaving restores it), and the per-mode scene
 * memory.
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
 * Whether the camera shape draws on this layout. The inset presets apply the
 * bubble shape (`scene_geometry.rs` `camera_mask`); Camera only, Side by side
 * and the stacked vertical scenes keep the camera rectangular in Preset mode.
 * (Freeform always draws the shape, but setup never leaves Preset mode.)
 */
export function shapeApplies(preset: LayoutPreset): boolean {
  return preset === 'screen-camera' || preset === 'vertical-screen-camera'
}

export const FIRST_RUN_LOOK_REASONS = {
  screenGrant: 'Allow Screen Recording first.',
  screenOff: 'No screen is chosen.',
  noScreen: 'No screen found.',
  cameraGrant: 'Allow the camera first.',
  cameraOff: 'Camera is off.',
  noCamera: 'No camera found.'
} as const

export type FirstRunLayoutOption = {
  preset: LayoutPreset
  label: string
  available: boolean
  /** Why the layout can't be chosen; null when it can. */
  reason: string | null
  /** Whether the Shape control applies to this layout. */
  shapeApplies: boolean
}

export type FirstRunLayoutOptionsInput = {
  orientation: LayoutOrientation
  /** The layout to keep when it works: the Studio's current one, or the one remembered for the other orientation. */
  current: LayoutPreset
  layout: LayoutSettings
  sources: SourceSelection
  mediaAccess: MediaAccessSnapshot | null
  devices: readonly Device[]
}

export type FirstRunLayoutOptions = {
  options: FirstRunLayoutOption[]
  /**
   * The layout the step shows as chosen (D7): `current` when it works, else
   * one that does (no screen → Camera only; no camera → Screen only), else
   * `current` (every layout is disabled and Continue still works).
   */
  preselected: LayoutPreset
}

function grantMissing(status: MediaAccessSnapshot[keyof MediaAccessSnapshot] | undefined): boolean {
  return status === 'not-determined' || status === 'denied' || status === 'restricted'
}

function gapReason(
  gap: SceneSourceGap,
  mediaAccess: MediaAccessSnapshot | null,
  devices: readonly Device[]
): string {
  if (gap.source === 'camera') {
    if (grantMissing(mediaAccess?.camera)) return FIRST_RUN_LOOK_REASONS.cameraGrant
    const present = devices.some(
      (device) => device.kind === 'camera' && device.status === 'available'
    )
    return gap.state === 'off' && present
      ? FIRST_RUN_LOOK_REASONS.cameraOff
      : FIRST_RUN_LOOK_REASONS.noCamera
  }
  if (grantMissing(mediaAccess?.screen)) return FIRST_RUN_LOOK_REASONS.screenGrant
  const present = devices.some(
    (device) =>
      (device.kind === 'screen' || device.kind === 'window') && device.status === 'available'
  )
  return gap.state === 'off' && present
    ? FIRST_RUN_LOOK_REASONS.screenOff
    : FIRST_RUN_LOOK_REASONS.noScreen
}

/**
 * Every layout of the orientation, in gallery order, with why it can't be
 * chosen (the camera first, then the screen, as the gallery's line reads),
 * and the layout to preselect.
 */
export function firstRunLayoutOptions(input: FirstRunLayoutOptionsInput): FirstRunLayoutOptions {
  const presets: readonly LayoutPreset[] =
    input.orientation === 'vertical' ? VERTICAL_LAYOUT_PRESETS : HORIZONTAL_LAYOUT_PRESETS
  const sources = usingVisualSources(input.sources)
  const options = presets.map((preset): FirstRunLayoutOption => {
    const gaps = sceneSourceGaps(
      {
        layout: { ...input.layout, layoutPreset: preset, arrangementMode: 'preset' },
        sources,
        background: null
      },
      input.devices
    )
    const gap = gaps.find((entry) => entry.source === 'camera') ?? gaps[0]
    return {
      preset,
      label: layoutPresetLabel(preset),
      available: gaps.length === 0,
      reason: gap ? gapReason(gap, input.mediaAccess, input.devices) : null,
      shapeApplies: shapeApplies(preset)
    }
  })
  const available = (preset: LayoutPreset): boolean =>
    options.some((option) => option.preset === preset && option.available)
  const cameraOnly: LayoutPreset =
    input.orientation === 'vertical' ? 'vertical-camera-only' : 'camera-only'
  const screenOnly: LayoutPreset =
    input.orientation === 'vertical' ? 'vertical-screen-only' : 'screen-only'
  const current = presets.includes(input.current) ? input.current : presets[0]
  const preselected = available(current)
    ? current
    : available(cameraOnly)
      ? cameraOnly
      : available(screenOnly)
        ? screenOnly
        : current
  return { options, preselected }
}
