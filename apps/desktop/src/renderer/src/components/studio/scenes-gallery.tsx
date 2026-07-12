import { Check } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset } from '@/lib/backend'
import { layoutPresetNeedsCamera, layoutPresetNeedsScreen } from '@/lib/capture'
import { cn } from '@/lib/utils'

// SD3 ships the REAL layout presets as the selectable "scenes" — not the
// mockup's invented "Main Camera / Presentation / Interview" names (no saved
// scenes exist yet). OBS-style named scenes are a Phase-2 backend feature (F2),
// so "Add scene" is shown disabled rather than faked.
const SCENE_PRESETS: { id: LayoutPreset; label: string }[] = [
  { id: 'screen-camera', label: 'Screen + Cam' },
  { id: 'screen-only', label: 'Screen' },
  { id: 'camera-only', label: 'Camera' },
  { id: 'side-by-side', label: 'Side by side' },
  { id: 'vertical', label: 'Vertical' }
]

export function ScenesGallery(): ReactElement {
  const { captureConfig, applyCameraPreset, layoutSwitchPending, isSessionActive } = useStudioCore()
  const { openStudioPanel } = useWorkspaceNav()
  const hasCamera = Boolean(captureConfig.sources.cameraId)
  const hasScreen = Boolean(captureConfig.sources.screenId ?? captureConfig.sources.windowId)
  const activePreset = captureConfig.layout.layoutPreset

  return (
    <PanelSection
      title="Scenes"
      description="Switch the program layout."
      action={
        <Button size="sm" variant="ghost" onClick={() => openStudioPanel('layouts')}>
          Edit scene
        </Button>
      }
    >
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(104px,1fr))]">
        {SCENE_PRESETS.map((preset) => {
          // Vertical changes the canvas orientation and the encoder canvas is
          // fixed at session start — switching INTO it mid-session is refused
          // (backend enforces this too). Every other scene stays live-safe.
          const verticalBlockedLive =
            preset.id === 'vertical' && isSessionActive && activePreset !== 'vertical'
          const disabled =
            (layoutPresetNeedsCamera(preset.id) && !hasCamera) ||
            (layoutPresetNeedsScreen(preset.id) && !hasScreen) ||
            verticalBlockedLive
          const active = activePreset === preset.id
          return (
            <button
              key={preset.id}
              aria-pressed={active}
              className={cn(
                'group flex flex-col gap-2 rounded-row border p-2 text-left transition-colors',
                active ? 'border-primary bg-primary/5' : 'hover:bg-accent',
                disabled && 'cursor-not-allowed opacity-50'
              )}
              disabled={disabled}
              title={
                verticalBlockedLive
                  ? 'Vertical changes the canvas orientation — stop the session to switch.'
                  : undefined
              }
              type="button"
              onClick={() => applyCameraPreset({ layoutPreset: preset.id })}
            >
              <LayoutThumb preset={preset.id} />
              <span className="flex items-center justify-between gap-1.5">
                <span className="truncate text-sm font-medium">
                  {layoutSwitchPending === preset.id ? 'Switching…' : preset.label}
                </span>
                {active ? <Check className="size-4 shrink-0 text-primary" weight="bold" /> : null}
              </span>
            </button>
          )
        })}
      </div>
    </PanelSection>
  )
}

// A small diagram of each preset's arrangement — clearer (and more honest) than
// a generic icon, and it never claims to be a live thumbnail of the program.
function LayoutThumb({ preset }: { preset: LayoutPreset }): ReactElement {
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
      {preset === 'vertical' ? (
        // 9:16 mini-canvas centered in the 16:9 thumb: camera band on top,
        // screen below — the short-form arrangement, honest about pillarbox.
        <div className="absolute inset-y-1 left-1/2 aspect-[9/16] -translate-x-1/2 overflow-hidden rounded-[3px] border border-background/60 bg-background/40">
          <div className="absolute inset-x-0.5 top-0.5 h-[38%] rounded-[2px] bg-foreground/30" />
          <div className="absolute inset-x-0.5 bottom-0.5 h-[56%] rounded-[2px] bg-foreground/10" />
        </div>
      ) : null}
    </div>
  )
}
