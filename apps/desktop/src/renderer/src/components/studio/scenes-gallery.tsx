import { sceneSourceProblems, visualSources } from '@/lib/scene-presets'
import { acceleratorDisplayKeys } from '../../../../shared/accelerator'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { CheckIcon, DisplayIcon, MobileIcon } from '@/components/icons'
import { lazy, Suspense, type ReactElement } from 'react'
const ScenePresetControls = lazy(() => import('@/components/scene-presets'))

import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset, VerticalScreenFraming } from '@/lib/backend'
import {
  layoutPresetOrientation,
  studioModeTogglePreset,
  type LayoutOrientation
} from '@/lib/capture'
import { cn } from '@/lib/utils'

// Built-in layouts and named visual snapshots share the Scenes surface.
// The gallery is MODE-SCOPED: horizontal and vertical are two disjoint scene
// vocabularies, and the orientation toggle in the header is the only way to
// cross between them (off-air only — the canvas flips with the mode).
const HORIZONTAL_SCENES: { id: LayoutPreset; label: string }[] = [
  { id: 'screen-camera', label: 'Screen + Cam' },
  { id: 'screen-only', label: 'Screen' },
  { id: 'camera-only', label: 'Camera' },
  { id: 'side-by-side', label: 'Side by side' }
]

export const VERTICAL_SCENES: { id: LayoutPreset; label: string }[] = [
  { id: 'vertical-camera-top', label: 'Camera top' },
  { id: 'vertical-camera-bottom', label: 'Camera bottom' },
  { id: 'vertical-split', label: 'Split' },
  { id: 'vertical-screen-camera', label: 'Screen + Cam' },
  { id: 'vertical-screen-only', label: 'Screen' },
  { id: 'vertical-camera-only', label: 'Camera' }
]

const STUDIO_ORIENTATION_OPTIONS: SegmentedControlOption<LayoutOrientation>[] = [
  {
    value: 'horizontal',
    label: <DisplayIcon />,
    'aria-label': 'Horizontal studio (16:9)',
    title: 'Horizontal · 16:9'
  },
  {
    value: 'vertical',
    label: <MobileIcon />,
    'aria-label': 'Vertical studio (9:16)',
    title: 'Vertical · 9:16'
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
  const switchMode = (target: LayoutOrientation): void => {
    if (target === mode) {
      return
    }
    applyCameraPreset({ layoutPreset: studioModeTogglePreset(target, captureConfig) })
  }

  return (
    <PanelSection
      title="Scenes"
      description={
        mode === 'vertical' ? 'Switch the 9:16 program layout.' : 'Switch the program layout.'
      }
      action={
        <div className="flex items-center gap-1.5">
          {/* The mode toggle changes the canvas orientation, and the encoder
              canvas is fixed at session start — disabled while live (the
              backend refuses cross-orientation scene switches too). The
              gallery is in the EAGER Studio chunk: SegmentedControl has no
              Radix, so it costs the initial asset budget nothing. A switch
              restarts the canvas, so arrows only move focus (manual). */}
          <SegmentedControl
            activationMode="manual"
            aria-label="Studio orientation"
            disabled={isSessionActive}
            options={STUDIO_ORIENTATION_OPTIONS}
            size="sm"
            title={
              isSessionActive
                ? 'The canvas is fixed while a session is running. Stop to switch orientation.'
                : undefined
            }
            value={mode}
            onValueChange={switchMode}
          />
          <Button size="sm" variant="ghost" onClick={() => openStudioPanel('layouts')}>
            Edit scene
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(104px,1fr))]">
        {scenes.map((preset) => {
          const problems = sceneSourceProblems(
            {
              layout: {
                ...captureConfig.layout,
                layoutPreset: preset.id,
                arrangementMode: 'preset'
              },
              sources: visualSources(captureConfig.sources),
              background: null
            },
            deviceList.devices
          )
          const disabled = problems.length > 0
          const active = !activeSavedSceneId && activePreset === preset.id
          return (
            <button
              key={preset.id}
              aria-pressed={active}
              className={cn(
                'group flex flex-col gap-2 rounded-row border p-2 text-left',
                active ? 'border-primary bg-primary/5' : 'bg-foreground/[0.04] hover:bg-accent',
                disabled && 'cursor-not-allowed opacity-50'
              )}
              disabled={disabled}
              title={problems.length ? problems.join(' ') : undefined}
              type="button"
              onClick={() => applyCameraPreset({ layoutPreset: preset.id })}
            >
              <LayoutThumb
                framing={captureConfig.layout.verticalScreenFraming}
                preset={preset.id}
              />
              <span className="flex items-center justify-between gap-1.5">
                <span className="truncate text-sm font-medium">
                  {layoutSwitchPending === preset.id ? 'Switching…' : preset.label}
                  {settings.globalShortcuts?.layouts?.[preset.id] ? (
                    <KbdGroup>
                      {acceleratorDisplayKeys(
                        settings.globalShortcuts.layouts[preset.id],
                        runtimeInfo?.platform
                      ).map((glyph, index) => (
                        <Kbd key={`${glyph}-${index}`}>{glyph}</Kbd>
                      ))}
                    </KbdGroup>
                  ) : null}
                </span>
                {active ? (
                  <CheckIcon className="size-4 shrink-0 text-primary" weight="bold" />
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
      {mode === 'vertical' ? (
        <ScreenFramingControl
          value={captureConfig.layout.verticalScreenFraming}
          onChange={(verticalScreenFraming) => applyCameraPreset({ verticalScreenFraming })}
        />
      ) : null}
      <Suspense fallback={null}>
        <ScenePresetControls />
      </Suspense>
    </PanelSection>
  )
}

/**
 * Fill / Fit for the screen in vertical scenes. Fill is the short-form look
 * (the screen fills its area and is cropped); Fit keeps the whole screen
 * visible. A SegmentedControl, Radix-free like the mode toggle.
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
