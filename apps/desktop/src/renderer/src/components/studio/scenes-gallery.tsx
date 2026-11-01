import {
  galleryPresetIsActive,
  orientationSwitchPreset,
  sceneGalleryReason,
  sceneSourceGaps,
  visualSources
} from '@/lib/scene-presets'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { DisplayIcon, MobileIcon } from '@/components/icons'
import { lazy, Suspense, type ReactElement } from 'react'
const ScenePresetControls = lazy(() => import('@/components/scene-presets'))

import { PanelSection } from '@/components/panel-section'
import { SectionLabel } from '@/components/section-label'
import { SceneCard, SceneGalleryReason } from '@/components/studio/scene-card'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset, VerticalScreenFraming } from '@/lib/backend'
import {
  layoutPresetOrientation,
  studioModeTogglePreset,
  type LayoutOrientation
} from '@/lib/capture'
import { LAYOUT_PRESET_LABELS } from '@/lib/layout-labels'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Built-in layouts and named visual snapshots share the Scenes surface.
// The gallery is MODE-SCOPED: horizontal and vertical are two disjoint scene
// vocabularies, and the orientation toggle in the header is the only way to
// cross between them (off-air only — the canvas flips with the mode).
// Names come from the one layout table (plan 174 S1.4, V-X3).
const scene = (id: LayoutPreset): { id: LayoutPreset; label: string } => ({
  id,
  label: LAYOUT_PRESET_LABELS[id]
})

const HORIZONTAL_SCENES: { id: LayoutPreset; label: string }[] = [
  scene('screen-camera'),
  scene('screen-only'),
  scene('camera-only'),
  scene('side-by-side')
]

export const VERTICAL_SCENES: { id: LayoutPreset; label: string }[] = [
  scene('vertical-camera-top'),
  scene('vertical-camera-bottom'),
  scene('vertical-split'),
  scene('vertical-screen-camera'),
  scene('vertical-screen-only'),
  scene('vertical-camera-only')
]

const STUDIO_ORIENTATION_OPTIONS: SegmentedControlOption<LayoutOrientation>[] = [
  {
    value: 'horizontal',
    label: <DisplayIcon />,
    'aria-label': 'Horizontal studio (16:9)',
    tooltip: 'Horizontal · 16:9'
  },
  {
    value: 'vertical',
    label: <MobileIcon />,
    'aria-label': 'Vertical studio (9:16)',
    tooltip: 'Vertical · 9:16'
  }
]

const SCREEN_FRAMING_OPTIONS: SegmentedControlOption<VerticalScreenFraming>[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' }
]

export function ScenesGallery(): ReactElement {
  const {
    captureConfig,
    applyCameraPreset,
    layoutSwitchPending,
    isSessionActive,
    activeSavedSceneId,
    deviceList,
    settings,
    runtimeInfo
  } = useStudioCore()
  const { openStudioPanel } = useWorkspaceNav()
  const activePreset = captureConfig.layout.layoutPreset
  const mode = layoutPresetOrientation(activePreset)
  const scenes = mode === 'vertical' ? VERTICAL_SCENES : HORIZONTAL_SCENES

  // Entering a mode re-applies its remembered scene; the orientation⇄canvas
  // coupling in applyCameraPreset flips the output profile alongside it.
  // What each scene needs that the current sources lack (plan 174 S3.3).
  const cards = scenes.map((preset) => ({
    preset,
    gaps: sceneSourceGaps(
      {
        layout: { ...captureConfig.layout, layoutPreset: preset.id, arrangementMode: 'preset' },
        sources: visualSources(captureConfig.sources),
        background: null
      },
      deviceList.devices
    )
  }))
  const reason = sceneGalleryReason(
    cards.map(({ preset, gaps }) => ({ label: preset.label, gaps }))
  )

  const switchMode = (target: LayoutOrientation): void => {
    if (target === mode) {
      return
    }
    const targetScenes = target === 'vertical' ? VERTICAL_SCENES : HORIZONTAL_SCENES
    const usable = (layoutPreset: LayoutPreset): boolean =>
      sceneSourceGaps(
        {
          layout: { ...captureConfig.layout, layoutPreset, arrangementMode: 'preset' },
          sources: visualSources(captureConfig.sources),
          background: null
        },
        deviceList.devices
      ).length === 0
    applyCameraPreset({
      layoutPreset: orientationSwitchPreset(
        studioModeTogglePreset(target, captureConfig),
        targetScenes.map((scene) => scene.id),
        usable
      )
    })
  }

  return (
    <PanelSection
      title="Scenes"
      description={
        mode === 'vertical'
          ? 'Click a scene to put it on the 9:16 stream.'
          : 'Click a scene to put it on stream.'
      }
      action={
        <div className="flex items-center gap-1.5">
          {/* The mode toggle changes the canvas orientation, and the encoder
              canvas is fixed at session start — disabled while live (the
              backend refuses cross-orientation scene switches too). The
              gallery is in the EAGER Studio chunk: SegmentedControl has no
              Tabs primitive, so it costs the initial asset budget nothing. A switch
              restarts the canvas, so arrows only move focus (manual). */}
          <DisabledReason
            reason={
              isSessionActive
                ? 'Locked while you’re recording or live. Stop to switch orientation.'
                : null
            }
          >
            <SegmentedControl
              activationMode="manual"
              aria-label="Studio orientation"
              disabled={isSessionActive}
              options={STUDIO_ORIENTATION_OPTIONS}
              size="sm"
              value={mode}
              onValueChange={switchMode}
            />
          </DisabledReason>
          <Button variant="ghost" onClick={() => openStudioPanel('layouts')}>
            Edit scene
          </Button>
        </div>
      }
    >
      {/* Plan 210 D6: your saved scenes first, in their order, then the
          layouts, each under its heading. */}
      <Suspense fallback={null}>
        <ScenePresetControls />
      </Suspense>
      <SectionLabel className="px-1">Layouts</SectionLabel>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(104px,1fr))]">
        {cards.map(({ preset, gaps }) => {
          const active = galleryPresetIsActive(captureConfig.layout, preset.id, activeSavedSceneId)
          const shortcut = settings.globalShortcuts?.layouts?.[preset.id]
          return (
            <SceneCard
              key={preset.id}
              data-scene-preset={preset.id}
              disabled={gaps.length > 0}
              label={layoutSwitchPending === preset.id ? 'Switching…' : preset.label}
              meta={
                shortcut ? (
                  <ShortcutKeys accelerator={shortcut} platform={runtimeInfo?.platform} />
                ) : undefined
              }
              selected={active}
              thumb={
                <LayoutThumb
                  framing={captureConfig.layout.verticalScreenFraming}
                  preset={preset.id}
                />
              }
              onSelect={() => applyCameraPreset({ layoutPreset: preset.id })}
            />
          )
        })}
      </div>
      {/* Why some scenes can't be chosen, once, under the gallery (B-20). */}
      <SceneGalleryReason
        action={
          <Button size="xs" variant="ghost" onClick={() => openWorkspaceTab('sources')}>
            Open Sources
          </Button>
        }
        reason={reason}
      />
      {mode === 'vertical' ? (
        <ScreenFramingControl
          value={captureConfig.layout.verticalScreenFraming}
          onChange={(verticalScreenFraming) => applyCameraPreset({ verticalScreenFraming })}
        />
      ) : null}
    </PanelSection>
  )
}

/**
 * Fill / Fit for the screen in vertical scenes. Fill is the short-form look
 * (the screen fills its area and is cropped); Fit keeps the whole screen
 * visible. A SegmentedControl, with no Tabs primitive, like the mode toggle.
 */
export function ScreenFramingControl({
  value,
  onChange
}: {
  value: VerticalScreenFraming
  onChange: (value: VerticalScreenFraming) => void
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3" data-slot="screen-framing-control">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">Screen</span>
        <span className="text-xs text-muted-foreground">
          {value === 'fit'
            ? 'Shows your whole screen. The camera takes the rest.'
            : 'Fills the area and crops the sides of your screen.'}
        </span>
      </div>
      <SegmentedControl
        aria-label="Screen framing"
        className="shrink-0"
        options={SCREEN_FRAMING_OPTIONS}
        value={value}
        onValueChange={onChange}
      />
    </div>
  )
}

// A small diagram of each preset's arrangement — clearer (and more honest) than
// a generic icon, and it never claims to be a live thumbnail of the program.
// Vertical scenes draw on a portrait frame so the whole gallery reads 9:16.
export function LayoutThumb({
  preset,
  framing = 'fill'
}: {
  preset: LayoutPreset
  /** Vertical scenes only: draws the Fit geometry (geometry truth, like the
   *  bands the backend composes: a 16:9 screen is ~32% of the 9:16 canvas). */
  framing?: VerticalScreenFraming
}): ReactElement {
  if (layoutPresetOrientation(preset) === 'vertical' && framing === 'fit') {
    return (
      <div className="relative mx-auto aspect-[9/16] w-3/5 overflow-hidden rounded-chip border bg-gradient-to-br from-muted/40 to-muted/70">
        {preset === 'vertical-camera-top' ? (
          <>
            <div className="absolute inset-x-1 top-1 h-[62%] rounded-[2px] bg-foreground/30" />
            <div className="absolute inset-x-1 bottom-1 h-[30%] rounded-[2px] bg-foreground/10" />
          </>
        ) : null}
        {preset === 'vertical-camera-bottom' || preset === 'vertical-split' ? (
          <>
            <div className="absolute inset-x-1 top-1 h-[30%] rounded-[2px] bg-foreground/10" />
            <div className="absolute inset-x-1 bottom-1 h-[62%] rounded-[2px] bg-foreground/30" />
          </>
        ) : null}
        {preset === 'vertical-screen-camera' ? (
          <>
            <div className="absolute inset-x-1 top-[35%] h-[30%] rounded-[2px] bg-foreground/10" />
            <div className="absolute right-1.5 bottom-1.5 h-[13%] w-[38%] rounded-[2px] border border-background/60 bg-foreground/30" />
          </>
        ) : null}
        {preset === 'vertical-screen-only' ? (
          <div className="absolute inset-x-1 top-[35%] h-[30%] rounded-[2px] bg-foreground/10" />
        ) : null}
        {preset === 'vertical-camera-only' ? (
          <div className="absolute inset-1 rounded-[2px] bg-foreground/30" />
        ) : null}
      </div>
    )
  }
  if (layoutPresetOrientation(preset) === 'vertical') {
    return (
      <div className="relative mx-auto aspect-[9/16] w-3/5 overflow-hidden rounded-chip border bg-gradient-to-br from-muted/40 to-muted/70">
        {preset === 'vertical-camera-top' ? (
          <>
            <div className="absolute inset-x-1 top-1 h-[37%] rounded-[2px] bg-foreground/30" />
            <div className="absolute inset-x-1 bottom-1 h-[55%] rounded-[2px] bg-foreground/10" />
          </>
        ) : null}
        {preset === 'vertical-camera-bottom' ? (
          <>
            <div className="absolute inset-x-1 top-1 h-[55%] rounded-[2px] bg-foreground/10" />
            <div className="absolute inset-x-1 bottom-1 h-[37%] rounded-[2px] bg-foreground/30" />
          </>
        ) : null}
        {preset === 'vertical-split' ? (
          <>
            <div className="absolute inset-x-1 top-1 h-[46%] rounded-[2px] bg-foreground/10" />
            <div className="absolute inset-x-1 bottom-1 h-[46%] rounded-[2px] bg-foreground/30" />
          </>
        ) : null}
        {preset === 'vertical-screen-camera' ? (
          <>
            <div className="absolute inset-1 rounded-[2px] bg-foreground/10" />
            <div className="absolute right-1.5 bottom-1.5 h-[13%] w-[38%] rounded-[2px] border border-background/60 bg-foreground/30" />
          </>
        ) : null}
        {preset === 'vertical-screen-only' ? (
          <div className="absolute inset-1 rounded-[2px] bg-foreground/10" />
        ) : null}
        {preset === 'vertical-camera-only' ? (
          <div className="absolute inset-1 rounded-[2px] bg-foreground/30" />
        ) : null}
      </div>
    )
  }
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-chip border bg-gradient-to-br from-muted/40 to-muted/70">
      {preset === 'screen-only' || preset === 'screen-camera' ? (
        <div className="absolute inset-1.5 rounded-[3px] bg-foreground/10" />
      ) : null}
      {preset === 'camera-only' ? (
        <div className="absolute inset-x-1/4 inset-y-1.5 rounded-[3px] bg-foreground/20" />
      ) : null}
      {preset === 'screen-camera' ? (
        <div className="absolute right-1.5 bottom-1.5 h-2/5 w-[30%] rounded-[2px] border border-background/60 bg-foreground/30" />
      ) : null}
      {preset === 'side-by-side' ? (
        <>
          <div className="absolute inset-y-1.5 left-1.5 w-[44%] rounded-[3px] bg-foreground/10" />
          <div className="absolute inset-y-1.5 right-1.5 w-[44%] rounded-[3px] bg-foreground/25" />
        </>
      ) : null}
    </div>
  )
}
