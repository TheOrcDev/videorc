import type { ReactElement } from 'react'

import { SceneGalleryReason } from '@/components/studio/scene-card'
import {
  LayoutThumb,
  ScreenFramingControl,
  VERTICAL_SCENES
} from '@/components/studio/scenes-gallery'
import { DisabledReason } from '@/components/ui/disabled-reason'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useStudioCore, type StudioCoreContextValue } from '@/hooks/use-studio'
import type { LayoutPreset, LayoutSettings, VerticalScreenFraming } from '@/lib/backend'
import {
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  layoutPresetOrientation
} from '@/lib/capture'
import { recalledLayoutFraming, type LayoutFramingMemory } from '@/lib/layout-framing-memory'
import { sceneGalleryReason, type SceneSourceGap } from '@/lib/scene-presets'

const READ_ONLY_REASON = 'Update Videorc to change your scenes.'

const LAYOUT_ITEMS = VERTICAL_SCENES.map((scene) => ({ value: scene.id, label: scene.label }))

/**
 * A scene's 9:16 layout after the Vertical stream's edit. Fill or Fit only
 * changes the framing; another layout is a layout pick, as in a 9:16 studio:
 * its remembered framing, the preset arrangement and no camera drag.
 */
export function verticalStreamLayout(
  vertical: LayoutSettings,
  patch: Partial<Pick<LayoutSettings, 'layoutPreset' | 'verticalScreenFraming'>>,
  memory: LayoutFramingMemory
): LayoutSettings {
  const preset = patch.layoutPreset ?? vertical.layoutPreset
  if (preset === vertical.layoutPreset) return { ...vertical, ...patch }
  return {
    ...vertical,
    ...recalledLayoutFraming(memory, vertical.layoutPreset, preset),
    arrangementMode: 'preset',
    sourceTransformOverrides: {},
    ...patch,
    cameraTransformMode: 'preset',
    cameraTransform: null
  }
}

/**
 * The Vertical stream's edit, saved into the scene on stream as its 9:16
 * layout (the provider sends it to the vertical stream while live). False
 * when it couldn't be saved (scenes this build can't change).
 */
export function editVerticalStreamLayout(
  studio: Pick<
    StudioCoreContextValue,
    'sceneOnStream' | 'savedScenes' | 'captureConfig' | 'sceneLibraryActions' | 'setCaptureConfig'
  >,
  patch: Parameters<typeof verticalStreamLayout>[1]
): boolean {
  const { sceneOnStream, captureConfig } = studio
  const view = studio.savedScenes.find((scene) => scene.id === sceneOnStream?.id)
  if (!sceneOnStream || !view) return false
  const layout = verticalStreamLayout(
    sceneOnStream.layouts.vertical,
    patch,
    captureConfig.layoutFramingMemory
  )
  // A scene's layout of the other orientation is saved as that layout (D4).
  if (
    !studio.sceneLibraryActions.replace({
      ...view,
      updatedAt: new Date().toISOString(),
      visual: { ...view.visual, layout }
    })
  )
    return false
  // An older build streams these; they steer nothing now.
  studio.setCaptureConfig((current) => ({
    ...current,
    lastVerticalPreset: layout.layoutPreset,
    simulcastScreenFraming: layout.verticalScreenFraming
  }))
  return true
}

/** A 9:16 layout in a list: its diagram, then its name. */
export function LayoutChoice({
  preset,
  label,
  framing
}: {
  preset: LayoutPreset
  label: string
  framing: VerticalScreenFraming
}): ReactElement {
  return (
    <span className="flex items-center gap-2">
      {/* The layout's diagram, never a picture of the stream. */}
      <span aria-hidden="true" className="block w-9 shrink-0">
        <LayoutThumb framing={framing} preset={preset} />
      </span>
      {label}
    </span>
  )
}

/**
 * Plan 231 D4: the 9:16 layout of the scene on stream and its Fill or Fit,
 * which is what the vertical stream beside a 16:9 studio shows. Each scene
 * keeps its own, so a scene switch cuts the vertical stream to that scene's
 * layout. An edit here saves into the scene on stream and, while live, goes
 * to the vertical stream only. The Vertical stream panel holds it; Studio's
 * Scenes section mounts it too, as its "Vertical stream" fields (S6). In
 * a 9:16 studio the scene's 9:16 layout is the studio's own Layout.
 */
export function VerticalStreamLayoutControl({
  framingLabel
}: {
  /** Fill or Fit's visible name ("Framing" in Studio's Scenes section). */
  framingLabel?: string
} = {}): ReactElement | null {
  const studio = useStudioCore()
  const { sceneOnStream, captureConfig, sceneLibraryActions } = studio
  if (!sceneOnStream || layoutPresetOrientation(captureConfig.layout.layoutPreset) !== 'horizontal')
    return null
  const vertical = sceneOnStream.layouts.vertical
  const framing = vertical.verticalScreenFraming
  const readOnly = sceneLibraryActions.readOnly
  const edit = (patch: Parameters<typeof verticalStreamLayout>[1]): void => {
    editVerticalStreamLayout(studio, patch)
  }
  const { sources } = captureConfig
  const hasCamera = Boolean(sources.cameraId)
  const hasScreen =
    sceneOnStream.shows.kind !== 'none' && Boolean(sources.screenId ?? sources.windowId)
  // What a layout needs that isn't chosen, said once under the control
  // (plan 174 S3.3, B-20), as the Scenes gallery does.
  const choices = VERTICAL_SCENES.map((scene) => {
    const gaps: SceneSourceGap[] = []
    if (layoutPresetNeedsCamera(scene.id) && !hasCamera)
      gaps.push({ source: 'camera', state: 'off' })
    if (layoutPresetNeedsScreen(scene.id) && !hasScreen)
      gaps.push({ source: 'screen', state: 'off' })
    return { scene, gaps }
  })
  const reason = sceneGalleryReason(
    choices.flatMap(({ scene, gaps }) => (gaps.length > 0 ? [{ label: scene.label, gaps }] : []))
  )
  const current = VERTICAL_SCENES.find((scene) => scene.id === vertical.layoutPreset)

  return (
    <div className="flex flex-col gap-3" data-slot="vertical-stream-layout">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">Layout</span>
            <span className="text-xs text-muted-foreground">
              The 9:16 layout of {sceneOnStream.name}, the scene on stream. Each scene keeps its
              own.
            </span>
          </div>
          <DisabledReason reason={readOnly ? READ_ONLY_REASON : null}>
            <Select
              disabled={readOnly}
              items={LAYOUT_ITEMS}
              value={vertical.layoutPreset}
              onValueChange={(layoutPreset) => {
                if (layoutPreset && layoutPreset !== vertical.layoutPreset) edit({ layoutPreset })
              }}
            >
              <SelectTrigger
                aria-label="Vertical stream layout"
                className="w-44 shrink-0"
                data-videorc-vertical-stream-layout={vertical.layoutPreset}
              >
                <SelectValue>{current ? current.label : null}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {choices.map(({ scene, gaps }) => (
                    <SelectItem
                      key={scene.id}
                      data-vertical-stream-layout={scene.id}
                      disabled={gaps.length > 0 && scene.id !== vertical.layoutPreset}
                      value={scene.id}
                    >
                      <LayoutChoice framing={framing} label={scene.label} preset={scene.id} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledReason>
        </div>
        <SceneGalleryReason reason={reason} />
      </div>
      <ScreenFramingControl
        disabledReason={readOnly ? READ_ONLY_REASON : null}
        label={framingLabel}
        value={framing}
        onChange={(verticalScreenFraming) => edit({ verticalScreenFraming })}
      />
    </div>
  )
}
