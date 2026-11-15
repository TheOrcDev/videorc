import { useEffect, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useStudioPreview } from '@/hooks/use-studio'
import type { SourceSelection } from '@/lib/backend'
import { previewStartupSources } from '@/lib/preview-startup'
import {
  PREVIEW_STARTUP_STALL_MS,
  PREVIEW_STARTUP_STEPS,
  type PreviewStartupStep,
  type PreviewStartupView,
  previewStartupStep,
  previewStartupView
} from '../../../shared/preview-startup'

export const OPEN_SOURCES_LABEL = 'Open Sources'

type SegmentState = 'done' | 'current' | 'stalled' | 'next'

export function previewStartupSegmentState(
  segment: PreviewStartupStep,
  view: Pick<PreviewStartupView, 'step' | 'stalled'>
): SegmentState {
  if (segment < view.step) {
    return 'done'
  }
  if (segment > view.step) {
    return 'next'
  }
  return view.stalled ? 'stalled' : 'current'
}

/**
 * True once `step` has run past the stall budget (D3 a). The clock restarts
 * whenever the step changes and runs while the card is mounted.
 */
export function usePreviewStartupStalled(step: PreviewStartupStep): boolean {
  const [stalledStep, setStalledStep] = useState<PreviewStartupStep | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setStalledStep(step), PREVIEW_STARTUP_STALL_MS)
    return () => clearTimeout(timer)
  }, [step])
  return stalledStep === step
}

/**
 * The docked Studio slot's startup card. It reads the live preview statuses
 * itself, so their frequent updates re-render this card and not the stage.
 */
export function DockedPreviewStartup({
  engineConnected,
  captureSources,
  onOpenSources
}: {
  engineConnected: boolean
  captureSources: SourceSelection
  onOpenSources?: () => void
}): ReactElement {
  const { previewScreenStatus, previewCameraStatus } = useStudioPreview()
  const sources = previewStartupSources(captureSources, previewScreenStatus, previewCameraStatus)
  const stalled = usePreviewStartupStalled(previewStartupStep(engineConnected, sources))
  return (
    <PreviewStartupCard
      view={previewStartupView({ engineConnected, sources, stalled })}
      onOpenSources={onOpenSources}
    />
  )
}

/**
 * Plan 238 S2: what the stage says until the first real frame, under the
 * Preview surface (which paints nothing of its own until then). A title, the
 * step in plain words, three short segments and, when a step is stuck, the
 * one fix that applies. The stage is a dark video ground in both themes, so
 * the card scopes the dark tokens to itself.
 */
export function PreviewStartupCard({
  view,
  onOpenSources
}: {
  view: PreviewStartupView
  onOpenSources?: () => void
}): ReactElement {
  return (
    <div
      className="dark flex max-w-full flex-col items-center gap-3 px-6 text-center"
      data-videorc-preview-startup
      data-step={view.step}
      data-stalled={view.stalled ? 'true' : undefined}
    >
      <div aria-live="polite" className="flex max-w-full flex-col items-center gap-1" role="status">
        <span className="text-sm font-medium text-video-ground-foreground">{view.title}</span>
        <span className="max-w-full truncate text-xs text-video-ground-muted">{view.detail}</span>
        <span className="sr-only">
          Step {view.step} of {PREVIEW_STARTUP_STEPS.length}
        </span>
      </div>
      <div aria-hidden className="flex items-center gap-1.5">
        {PREVIEW_STARTUP_STEPS.map((segment) => {
          const state = previewStartupSegmentState(segment, view)
          return (
            <Progress
              className="w-10 [&_[data-slot=progress-track]]:h-0.5"
              data-preview-startup-segment={state}
              key={segment}
              value={state === 'next' ? 0 : 100}
            />
          )
        })}
      </div>
      {view.action === 'open-sources' && onOpenSources ? (
        <Button variant="outline" onClick={onOpenSources}>
          {OPEN_SOURCES_LABEL}
        </Button>
      ) : null}
    </div>
  )
}
