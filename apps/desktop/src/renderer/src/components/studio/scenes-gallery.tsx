import { DisplayIcon, MobileIcon } from '@/components/icons'
import { lazy, Suspense, type ReactElement } from 'react'
const ScenePresetControls = lazy(() => import('@/components/scene-presets'))

import { PanelSection } from '@/components/panel-section'
import { SceneSwitchStatus } from '@/components/scene/scene-switch-status'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { useEditScene } from '@/hooks/use-edit-scene'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset, VerticalScreenFraming } from '@/lib/backend'
import {
  layoutPresetOrientation,
  studioModeTogglePreset,
  type LayoutOrientation
} from '@/lib/capture'
import { EDIT_SCENE_LABEL } from '@/lib/edit-scene'
import { LAYOUT_PRESET_LABELS } from '@/lib/layout-labels'

// Plan 231 D2: the gallery shows scenes only, the same list in 16:9 and in
// 9:16, each in its layout for the studio's orientation. A layout is a choice
// inside a scene. The orientation toggle in the header flips the canvas (off
// air only) and puts the scene on stream on in its other layout.
// Names come from the one layout table (plan 174 S1.4, V-X3).
const scene = (id: LayoutPreset): { id: LayoutPreset; label: string } => ({
  id,
  label: LAYOUT_PRESET_LABELS[id]
})

/** The 9:16 layouts, for the Vertical stream panel. */
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
  const { captureConfig, applyCameraPreset, isSessionActive } = useStudioCore()
  const editScene = useEditScene()
  const mode = layoutPresetOrientation(captureConfig.layout.layoutPreset)

  // The scene on stream goes on in its own layout for the other orientation;
  // the orientation⇄canvas coupling in applyCameraPreset flips the output
  // profile alongside it.
  const switchMode = (target: LayoutOrientation): void => {
    if (target === mode) {
      return
    }
    applyCameraPreset(
      { layoutPreset: studioModeTogglePreset(target, captureConfig) },
      { toOrientation: true }
    )
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
          {/* Plan 215 D4: the same Edit scene as the Scene page's and ⌘K's. */}
          <Button variant="ghost" onClick={editScene}>
            {EDIT_SCENE_LABEL}
          </Button>
        </div>
      }
    >
      {/* Plan 231 D2: the scenes, in their order. */}
      <Suspense fallback={null}>
        <ScenePresetControls />
      </Suspense>
      {/* Issue #1275: what a slow switch is waiting for. */}
      <SceneSwitchStatus />
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
 * The landscape screen scenes offer the same choice (plan 213 G3), Fit by
 * default there: a screen of another shape fills the frame with Fill.
 */
export function ScreenFramingControl({
  value,
  orientation = 'vertical',
  onChange
}: {
  value: VerticalScreenFraming
  orientation?: 'vertical' | 'horizontal'
  onChange: (value: VerticalScreenFraming) => void
}): ReactElement {
  return (
    <div
      className="flex items-center justify-between gap-3"
      data-slot="screen-framing-control"
      data-videorc-screen-framing={orientation}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">Screen</span>
        <span className="text-xs text-muted-foreground">
          {orientation === 'horizontal'
            ? value === 'fit'
              ? 'Shows your whole screen. A screen of another shape gets bars.'
              : "Fills the frame and crops the edges of your screen that don't fit."
            : value === 'fit'
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
