import {
  HORIZONTAL_LAYOUT_PRESETS,
  VERTICAL_LAYOUT_PRESETS,
  type Device,
  type LayoutPreset,
  type LayoutSettings,
  type MediaAccessSnapshot,
  type SourceSelection
} from './backend'
import type { LayoutOrientation } from './capture'
import { layoutPresetLabel } from './layout-labels'
import { sceneSourceGaps, visualSources, type SceneSourceGap } from './scene-presets'

// Plan 207 S4: what "Your look" offers (the layouts, why one is off, where the
// shape draws). Only the setup chunk imports this module; the writes the
// Studio provider applies live in `first-run-look-apply.ts`.

export * from './first-run-look-apply'

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
  const sources = visualSources(input.sources)
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
