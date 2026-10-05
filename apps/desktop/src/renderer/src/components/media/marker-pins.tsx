import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionMarker } from '@/lib/backend'
import { markerTime } from '../../../../shared/session-markers'
export function MarkerPins({
  markers,
  durationMs,
  onSelect
}: {
  markers: readonly SessionMarker[]
  durationMs: number
  onSelect: (marker: SessionMarker) => void
}): ReactElement {
  return (
    <div className="relative h-6 w-full" aria-label="Marker timeline" data-slot="marker-timeline">
      <div className="absolute inset-x-0 top-3 border-t border-border" />
      {markers.map((marker) => (
        <Tooltip key={marker.id}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-0 h-6 w-4 -translate-x-1/2 px-0"
              style={{
                left: `${Math.min(100, (100 * marker.atSeconds * 1000) / Math.max(1, durationMs))}%`
              }}
              aria-label={`${marker.label ?? 'Untitled marker'} · ${markerTime(marker.atSeconds)}`}
              onClick={() => onSelect(marker)}
            >
              │
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {markerTime(marker.atSeconds)} · {marker.label ?? 'Untitled marker'}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
