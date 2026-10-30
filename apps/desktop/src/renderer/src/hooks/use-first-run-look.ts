import { useEffect, useMemo } from 'react'

import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useStudioCore } from '@/hooks/use-studio'
import type { CameraShape, Device, LayoutPreset, MediaAccessSnapshot } from '@/lib/backend'
import type { BackgroundAssetRegistry } from '@/lib/background-assets'
import {
  layoutPresetOrientation,
  studioModeTogglePreset,
  type CaptureConfig,
  type LayoutOrientation
} from '@/lib/capture'
import {
  firstRunLayoutOptions,
  firstRunLookFromState,
  type FirstRunLayoutOption,
  type FirstRunLook
} from '@/lib/first-run-look'
import type { LiveBackgroundId } from '../../../shared/live-background-ids'

// Plan 207 S4: the state behind "Your look" (S5 draws it). Every setter
// writes through the provider's `applyFirstRunLook`, which changes
// `captureConfig` and the background registry only; the scene reload commits
// that idle, so no camera or screen opens while setup is open.

export type FirstRunLookController = {
  orientation: LayoutOrientation
  layoutPreset: LayoutPreset
  cameraShape: CameraShape
  /** The live background on the scene, or null for None. */
  liveBackgroundId: LiveBackgroundId | null
  /** Every layout of the orientation, in gallery order, with why it's disabled. */
  options: FirstRunLayoutOption[]
  /** The layout that works for this device set (D7); applied when the current one doesn't. */
  preselected: LayoutPreset
  /** Whether the Shape control applies to the chosen layout. */
  shapeApplies: boolean
  /** True while the look waits for setup to close (a replay with the Clips ring running). */
  held: boolean
  setOrientation: (orientation: LayoutOrientation) => void
  setLayout: (preset: LayoutPreset) => void
  setShape: (shape: CameraShape) => void
  setBackground: (id: LiveBackgroundId | null) => void
}

export { firstRunLookFromState } from '@/lib/first-run-look'

export type FirstRunLookControllerInput = {
  config: CaptureConfig
  registry: Pick<BackgroundAssetRegistry, 'activeSlotId' | 'live'>
  hold: FirstRunLook | null
  mediaAccess: MediaAccessSnapshot | null
  devices: readonly Device[]
  apply: (patch: Partial<FirstRunLook>) => void
}

/** The controller's pure half: what the hook shows and what each setter applies. */
export function firstRunLookController(input: FirstRunLookControllerInput): FirstRunLookController {
  const look = input.hold ?? firstRunLookFromState(input.config, input.registry)
  const optionsFor = (
    orientation: LayoutOrientation,
    current: LayoutPreset
  ): ReturnType<typeof firstRunLayoutOptions> =>
    firstRunLayoutOptions({
      orientation,
      current,
      layout: input.config.layout,
      sources: input.config.sources,
      mediaAccess: input.mediaAccess,
      devices: input.devices
    })
  const { options, preselected } = optionsFor(look.orientation, look.layoutPreset)
  return {
    ...look,
    options,
    preselected,
    shapeApplies: options.some(
      (option) => option.preset === look.layoutPreset && option.shapeApplies
    ),
    held: input.hold !== null,
    setOrientation: (orientation) => {
      // The gallery's toggle: the scene remembered for that orientation when
      // the sources can show it, otherwise one that works.
      const remembered = studioModeTogglePreset(orientation, input.config)
      input.apply({
        orientation,
        layoutPreset: optionsFor(orientation, remembered).preselected
      })
    },
    setLayout: (preset) => {
      input.apply({ orientation: layoutPresetOrientation(preset), layoutPreset: preset })
    },
    setShape: (cameraShape) => {
      input.apply({ cameraShape })
    },
    setBackground: (liveBackgroundId) => {
      input.apply({ liveBackgroundId })
    }
  }
}

export function useFirstRunLook(): FirstRunLookController {
  const { captureConfig, deviceList, mediaAccess, firstRunLookHold, applyFirstRunLook } =
    useStudioCore()
  const { registry } = useBackgroundAssets()
  const controller = useMemo(
    () =>
      firstRunLookController({
        config: captureConfig,
        registry,
        hold: firstRunLookHold,
        mediaAccess,
        devices: deviceList.devices,
        apply: applyFirstRunLook
      }),
    [applyFirstRunLook, captureConfig, deviceList.devices, firstRunLookHold, mediaAccess, registry]
  )
  // D7 / D11: the step preselects a layout that works, and the Studio opens
  // on it even when the user only presses Continue.
  const { layoutPreset, preselected, setLayout } = controller
  useEffect(() => {
    if (preselected !== layoutPreset) setLayout(preselected)
  }, [layoutPreset, preselected, setLayout])
  return controller
}
