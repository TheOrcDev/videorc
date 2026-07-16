import { DeviceMobile } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import { useStudioCore } from '@/hooks/use-studio'
import { simulcastArmed } from '@/lib/capture'

/**
 * The vertical leg's view-only monitor (dual-orientation simulcast). Phase 1
 * shows the SCENE SCHEMATIC, not live pixels: the schematic is geometry truth
 * (the same honesty rule as the scenes gallery), while live vertical pixels
 * need the preview host's surface-id split — deferred with the engine plan's
 * fallback posture. The preview window keeps showing the horizontal program.
 */
export function VerticalLegMonitor(): ReactElement | null {
  const { captureConfig, isSessionActive } = useStudioCore()
  if (!simulcastArmed(captureConfig)) {
    return null
  }
  const verticalPreset = captureConfig.lastVerticalPreset
  return (
    <section
      className="flex items-center gap-3 rounded-panel border border-border p-3"
      data-slot="vertical-leg-monitor"
    >
      <div className="w-14 shrink-0">
        <LayoutThumb preset={verticalPreset} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <DeviceMobile className="size-4 text-muted-foreground" />
          Vertical stream
          {isSessionActive ? (
            <Badge variant="success">Live</Badge>
          ) : (
            <Badge variant="outline">Armed</Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {isSessionActive
            ? 'Streaming your saved vertical scene beside the horizontal program.'
            : 'Goes live with your vertical scene when you start streaming. Edit it in the vertical Studio mode.'}
        </span>
      </div>
    </section>
  )
}
