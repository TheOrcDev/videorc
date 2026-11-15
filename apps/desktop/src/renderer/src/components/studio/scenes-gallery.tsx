import { lazy, Suspense, type ReactElement, type ReactNode } from 'react'
const ScenesSection = lazy(() => import('@/components/scene-presets'))

import { PanelSection } from '@/components/panel-section'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset, VerticalScreenFraming } from '@/lib/backend'
import { layoutPresetOrientation } from '@/lib/capture'
import { LAYOUT_PRESET_LABELS } from '@/lib/layout-labels'
import { cn } from '@/lib/utils'

// Plan 231 D8: Studio's Scenes section is the home of scenes. Its header, the
// cards, their reorder and the scene on stream's own fields (Screen, Layout,
// Fill or Fit, Vertical stream layout) are one lazy chunk
// (`components/scene-presets.tsx`), loaded right after this below-the-fold
// row: none of it is in the Studio's first paint. Both looks share it; with
// Retro LCD the fields sit on a screen (plan 197).
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

const SCREEN_FRAMING_OPTIONS: SegmentedControlOption<VerticalScreenFraming>[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' }
]

export function ScenesGallery(): ReactElement {
  const { settings } = useStudioCore()
  // Settings → General → Retro LCD (plan 197): the same section in its look.
  const look = settings.retroLcdStudio === true ? 'lcd' : 'default'
  return (
    <Suspense fallback={<ScenesSectionFallback />}>
      <ScenesSection look={look} />
    </Suspense>
  )
}

/** The section's room while its chunk loads, so the page under it never jumps far. */
function ScenesSectionFallback(): ReactElement {
  return (
    <PanelSection title="Scenes">
      <Skeleton className="h-24" />
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
  label = 'Screen',
  disabledReason = null,
  onChange
}: {
  value: VerticalScreenFraming
  orientation?: 'vertical' | 'horizontal'
  /** The visible name ("Framing" beside Studio's Screen field, plan 231 S6). */
  label?: string
  /** Why it can't change now; it is disabled while there is one. */
  disabledReason?: string | null
  onChange: (value: VerticalScreenFraming) => void
}): ReactElement {
  return (
    <div
      className="flex items-center justify-between gap-3"
      data-slot="screen-framing-control"
      data-videorc-screen-framing={orientation}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
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
        disabled={disabledReason !== null}
        disabledReason={disabledReason}
        options={SCREEN_FRAMING_OPTIONS}
        value={value}
        onValueChange={onChange}
      />
    </div>
  )
}

/**
 * Where a layout draws the screen (plan 231 D7): the scene's still picture
 * when it has one, else what it shows as a glyph (an app's icon, a display),
 * else the empty area. Never the live program.
 */
function ThumbScreen({
  className,
  picture,
  glyph
}: {
  className: string
  picture?: string
  glyph?: ReactNode
}): ReactElement {
  return (
    <div
      className={cn('absolute overflow-hidden bg-foreground/10', className)}
      data-picture={picture ? '' : undefined}
      data-slot="layout-thumb-screen"
    >
      {picture ? (
        <img alt="" className="size-full object-cover" draggable={false} src={picture} />
      ) : glyph ? (
        <span className="flex size-full items-center justify-center">{glyph}</span>
      ) : null}
    </div>
  )
}

/** Where a layout draws the camera: a neutral plate, opaque over a picture (D7). */
function ThumbCamera({
  className,
  strong = false
}: {
  className: string
  /** At icon size the plate needs more contrast to read. */
  strong?: boolean
}): ReactElement {
  return (
    <div
      className={cn('absolute overflow-hidden bg-glass-solid', className)}
      data-slot="layout-thumb-camera"
    >
      <span className={cn('absolute inset-0', strong ? 'bg-foreground/55' : 'bg-foreground/25')} />
    </div>
  )
}

// A small diagram of each preset's arrangement — clearer (and more honest) than
// a generic icon, and it never claims to be a live thumbnail of the program.
// Vertical scenes draw on a portrait frame so the whole gallery reads 9:16.
export function LayoutThumb({
  preset,
  framing = 'fill',
  picture,
  glyph,
  compact = false
}: {
  preset: LayoutPreset
  /** Vertical scenes only: draws the Fit geometry (geometry truth, like the
   *  bands the backend composes: a 16:9 screen is ~32% of the 9:16 canvas). */
  framing?: VerticalScreenFraming
  /** A still of the scene's screen for the screen area (plan 231 D7, `sources.scene_pictures`). */
  picture?: string
  /** Drawn in the screen area while there is no picture: the app's icon, a display glyph. */
  glyph?: ReactNode
  /** A 16:9 diagram at icon size (a choice in the Layout field): thinner insets, no glyph. */
  compact?: boolean
}): ReactElement {
  const screen = { picture, glyph: compact ? undefined : glyph }
  if (layoutPresetOrientation(preset) === 'vertical' && framing === 'fit') {
    return (
      <div className="relative mx-auto aspect-[9/16] w-3/5 overflow-hidden rounded-chip border bg-gradient-to-br from-muted/40 to-muted/70">
        {preset === 'vertical-camera-top' ? (
          <>
            <ThumbCamera className="inset-x-1 top-1 h-[62%] rounded-[2px]" />
            <ThumbScreen className="inset-x-1 bottom-1 h-[30%] rounded-[2px]" {...screen} />
          </>
        ) : null}
        {preset === 'vertical-camera-bottom' || preset === 'vertical-split' ? (
          <>
            <ThumbScreen className="inset-x-1 top-1 h-[30%] rounded-[2px]" {...screen} />
            <ThumbCamera className="inset-x-1 bottom-1 h-[62%] rounded-[2px]" />
          </>
        ) : null}
        {preset === 'vertical-screen-camera' ? (
          <>
            <ThumbScreen className="inset-x-1 top-[35%] h-[30%] rounded-[2px]" {...screen} />
            <ThumbCamera className="right-1.5 bottom-1.5 h-[13%] w-[38%] rounded-[2px] border border-background/60" />
          </>
        ) : null}
        {preset === 'vertical-screen-only' ? (
          <ThumbScreen className="inset-x-1 top-[35%] h-[30%] rounded-[2px]" {...screen} />
        ) : null}
        {preset === 'vertical-camera-only' ? (
          <ThumbCamera className="inset-1 rounded-[2px]" />
        ) : null}
      </div>
    )
  }
  if (layoutPresetOrientation(preset) === 'vertical') {
    return (
      <div className="relative mx-auto aspect-[9/16] w-3/5 overflow-hidden rounded-chip border bg-gradient-to-br from-muted/40 to-muted/70">
        {preset === 'vertical-camera-top' ? (
          <>
            <ThumbCamera className="inset-x-1 top-1 h-[37%] rounded-[2px]" />
            <ThumbScreen className="inset-x-1 bottom-1 h-[55%] rounded-[2px]" {...screen} />
          </>
        ) : null}
        {preset === 'vertical-camera-bottom' ? (
          <>
            <ThumbScreen className="inset-x-1 top-1 h-[55%] rounded-[2px]" {...screen} />
            <ThumbCamera className="inset-x-1 bottom-1 h-[37%] rounded-[2px]" />
          </>
        ) : null}
        {preset === 'vertical-split' ? (
          <>
            <ThumbScreen className="inset-x-1 top-1 h-[46%] rounded-[2px]" {...screen} />
            <ThumbCamera className="inset-x-1 bottom-1 h-[46%] rounded-[2px]" />
          </>
        ) : null}
        {preset === 'vertical-screen-camera' ? (
          <>
            <ThumbScreen className="inset-1 rounded-[2px]" {...screen} />
            <ThumbCamera className="right-1.5 bottom-1.5 h-[13%] w-[38%] rounded-[2px] border border-background/60" />
          </>
        ) : null}
        {preset === 'vertical-screen-only' ? (
          <ThumbScreen className="inset-1 rounded-[2px]" {...screen} />
        ) : null}
        {preset === 'vertical-camera-only' ? (
          <ThumbCamera className="inset-1 rounded-[2px]" />
        ) : null}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'relative aspect-video w-full overflow-hidden border bg-gradient-to-br from-muted/40 to-muted/70',
        compact ? 'rounded-[3px] border-foreground/25' : 'rounded-chip'
      )}
    >
      {preset === 'screen-only' || preset === 'screen-camera' ? (
        <ThumbScreen
          className={
            compact ? 'inset-[2px] rounded-[1px] bg-foreground/25' : 'inset-1.5 rounded-[3px]'
          }
          {...screen}
        />
      ) : null}
      {preset === 'camera-only' ? (
        <ThumbCamera
          className={
            compact
              ? 'inset-x-1/4 inset-y-[2px] rounded-[1px]'
              : 'inset-x-1/4 inset-y-1.5 rounded-[3px]'
          }
          strong={compact}
        />
      ) : null}
      {preset === 'screen-camera' ? (
        <ThumbCamera
          className={
            compact
              ? 'right-[3px] bottom-[3px] h-1/2 w-[34%] rounded-[1px]'
              : 'right-1.5 bottom-1.5 h-2/5 w-[30%] rounded-[2px] border border-background/60'
          }
          strong={compact}
        />
      ) : null}
      {preset === 'side-by-side' ? (
        <>
          <ThumbScreen
            className={
              compact
                ? 'inset-y-[2px] left-[2px] w-[45%] rounded-[1px] bg-foreground/25'
                : 'inset-y-1.5 left-1.5 w-[44%] rounded-[3px]'
            }
            {...screen}
          />
          <ThumbCamera
            className={
              compact
                ? 'inset-y-[2px] right-[2px] w-[45%] rounded-[1px]'
                : 'inset-y-1.5 right-1.5 w-[44%] rounded-[3px]'
            }
            strong={compact}
          />
        </>
      ) : null}
    </div>
  )
}
