import { useEffect, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionMarker } from '@/lib/backend'
import { groupMarkerPins, markerPinLeft, type MarkerPinGroup } from '@/lib/session-player-view'
import { cn } from '@/lib/utils'
import { markerTime } from '../../../../shared/session-markers'

/** Grouping needs a width before the first measure (and where nothing lays out). */
const FALLBACK_TRACK_PX = 480

function markerName(marker: SessionMarker): string {
  return marker.label ?? 'Untitled marker'
}

function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return
    const measure = (): void => setWidth(element.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return width
}

/**
 * Markers on the recording's timeline (plan 174 S3.12, E-7). `overlay` lays
 * the pins over the player's scrubber, each exactly under the playhead at its
 * time; `timeline` draws its own track where there is no player. Nothing
 * shows until the duration is known. Each pin is a 2 px tick in a 24 px hit
 * area; pins closer than that merge into one that opens a chooser.
 */
export function MarkerPins({
  markers,
  durationMs,
  onSelect,
  variant = 'timeline'
}: {
  markers: readonly SessionMarker[]
  durationMs: number
  onSelect: (marker: SessionMarker) => void
  variant?: 'timeline' | 'overlay'
}): ReactElement | null {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const width = useElementWidth(element)
  if (!(durationMs > 0) || markers.length === 0) return null
  const groups = groupMarkerPins(markers, durationMs, width > 0 ? width : FALLBACK_TRACK_PX)
  return (
    <div
      ref={setElement}
      aria-label="Marker timeline"
      className={cn(
        variant === 'overlay' ? 'pointer-events-none absolute inset-0' : 'relative h-6 w-full'
      )}
      data-slot="marker-timeline"
      data-variant={variant}
      role="group"
    >
      {variant === 'timeline' ? (
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/15"
        />
      ) : null}
      {groups.map((group) =>
        group.markers.length === 1 ? (
          <MarkerPin key={group.key} group={group} onSelect={onSelect} />
        ) : (
          <MarkerPinChooser key={group.key} group={group} onSelect={onSelect} />
        )
      )}
    </div>
  )
}

/** The 24 px hit area, centred on the pin's time. */
const PIN_CLASS = 'pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2'

/** The 2 px tick a pin draws; a chooser's is twice as wide. */
function PinTick({ several = false }: { several?: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      className={cn('h-3 rounded-full bg-foreground', several ? 'w-1' : 'w-0.5')}
      data-slot="marker-pin-tick"
    />
  )
}

function MarkerPin({
  group,
  onSelect
}: {
  group: MarkerPinGroup<SessionMarker>
  onSelect: (marker: SessionMarker) => void
}): ReactElement {
  const marker = group.markers[0]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={`${markerName(marker)} · ${markerTime(marker.atSeconds)}`}
          className={PIN_CLASS}
          data-testid="marker-pin"
          size="icon-xs"
          style={{ left: markerPinLeft(group.fraction) }}
          type="button"
          variant="ghost"
          onClick={() => onSelect(marker)}
        >
          <PinTick />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {markerTime(marker.atSeconds)} · {markerName(marker)}
      </TooltipContent>
    </Tooltip>
  )
}

function MarkerPinChooser({
  group,
  onSelect
}: {
  group: MarkerPinGroup<SessionMarker>
  onSelect: (marker: SessionMarker) => void
}): ReactElement {
  const first = group.markers[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${group.markers.length} markers near ${markerTime(first.atSeconds)}`}
          className={PIN_CLASS}
          data-testid="marker-pin"
          size="icon-xs"
          style={{ left: markerPinLeft(group.fraction) }}
          type="button"
          variant="ghost"
        >
          <PinTick several />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top">
        <DropdownMenuGroup>
          {group.markers.map((marker) => (
            <DropdownMenuItem key={marker.id} onSelect={() => onSelect(marker)}>
              <span className="text-muted-foreground tabular-nums">
                {markerTime(marker.atSeconds)}
              </span>
              <span className="truncate">{markerName(marker)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
