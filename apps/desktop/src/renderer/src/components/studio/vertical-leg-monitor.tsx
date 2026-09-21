import { CheckIcon, MobileIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import {
  LayoutThumb,
  ScreenFramingControl,
  VERTICAL_SCENES
} from '@/components/studio/scenes-gallery'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import {
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  simulcastArmed,
  simulcastLegPreset
} from '@/lib/capture'
import { cn } from '@/lib/utils'

/**
 * The vertical leg of a dual-orientation stream: pick its scene, choose how
 * the screen is framed, and decide whether it follows the horizontal program.
 * Every change is saved for the next session and, while live, lands on the
 * vertical leg only (the backend never touches the horizontal program for a
 * vertical scene transaction).
 *
 * Still a SCHEMATIC, not live pixels: the thumbnails are geometry truth (the
 * same honesty rule as the scenes gallery); live vertical pixels need the
 * preview host's surface-id split, deferred with the engine plan.
 */
export function VerticalLegMonitor(): ReactElement | null {
  const { captureConfig, isSessionActive, applySimulcastLeg } = useStudioCore()
  if (!simulcastArmed(captureConfig)) {
    return null
  }
  const hasCamera = Boolean(captureConfig.sources.cameraId)
  const hasScreen = Boolean(captureConfig.sources.screenId ?? captureConfig.sources.windowId)
  const streamingPreset = simulcastLegPreset(captureConfig)
  // Follow is steering the leg right now: the program's scene has a vertical
  // twin that differs from the scene the owner picked here.
  const followed =
    captureConfig.simulcastFollowsProgram && streamingPreset !== captureConfig.lastVerticalPreset
  const framing = captureConfig.simulcastScreenFraming

  return (
    <PanelSection
      action={
        isSessionActive ? (
          <Badge variant="success">Live</Badge>
        ) : (
          <Badge variant="outline">Armed</Badge>
        )
      }
      description={
        isSessionActive
          ? 'Changes here go live on the vertical stream only. Your horizontal stream is not touched.'
          : 'Goes live beside your horizontal stream when you start.'
      }
      icon={MobileIcon}
      title="Vertical stream"
    >
      <div
        className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(84px,1fr))]"
        data-slot="vertical-leg-scenes"
      >
        {VERTICAL_SCENES.map((scene) => {
          const disabled =
            (layoutPresetNeedsCamera(scene.id) && !hasCamera) ||
            (layoutPresetNeedsScreen(scene.id) && !hasScreen)
          const selected = captureConfig.lastVerticalPreset === scene.id
          const streaming = streamingPreset === scene.id
          return (
            <button
              key={scene.id}
              aria-pressed={selected}
              className={cn(
                'flex flex-col gap-1.5 rounded-row border p-2 text-left transition-colors',
                streaming ? 'border-primary bg-primary/5' : 'hover:bg-accent',
                disabled && 'cursor-not-allowed opacity-50'
              )}
              disabled={disabled}
              type="button"
              onClick={() => applySimulcastLeg({ lastVerticalPreset: scene.id })}
            >
              <LayoutThumb framing={framing} preset={scene.id} />
              <span className="flex items-center justify-between gap-1">
                <span className="truncate text-xs font-medium">{scene.label}</span>
                {streaming ? (
                  <CheckIcon className="size-3.5 shrink-0 text-primary" weight="bold" />
                ) : null}
              </span>
            </button>
          )
        })}
      </div>

      <ScreenFramingControl
        value={framing}
        onChange={(simulcastScreenFraming) => applySimulcastLeg({ simulcastScreenFraming })}
      />

      <div className="flex items-center justify-between gap-3" data-slot="vertical-leg-follow">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">Follow horizontal scene</span>
          <span className="text-xs text-muted-foreground">
            {followed
              ? 'Following now: your horizontal scene has a vertical twin, so that is what streams.'
              : 'Camera only and Screen only switch the vertical stream to the matching scene.'}
          </span>
        </div>
        <div
          aria-label="Follow horizontal scene"
          className="flex shrink-0 items-center overflow-hidden rounded-chip border"
          role="group"
        >
          {[
            { on: true, label: 'On' },
            { on: false, label: 'Off' }
          ].map((option) => (
            <Button
              key={option.label}
              aria-pressed={captureConfig.simulcastFollowsProgram === option.on}
              className={cn(
                'h-8 rounded-none px-3',
                captureConfig.simulcastFollowsProgram === option.on
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground'
              )}
              size="sm"
              variant="ghost"
              onClick={() => applySimulcastLeg({ simulcastFollowsProgram: option.on })}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    </PanelSection>
  )
}
