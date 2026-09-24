import type { ReactElement, ReactNode } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Sparkline } from '@/components/stream-manager/sparkline'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { StatTileModel } from '@/lib/stream-manager-stats'
import { ABOVE_NARROW, NARROW_ONLY } from '@/lib/stream-manager-layout'
import { cn } from '@/lib/utils'

// The stats strip (plan 053, D2): flush cells split by hairlines, never cards
// inside the window. Tone lives only in dots and chips; the numbers stay
// monochrome and tabular. Below 640 px the strip becomes one summary line.

const DESTINATION_TONE: Record<string, StatusDotTone> = {
  live: 'good',
  connecting: 'warn',
  warning: 'warn',
  failed: 'error'
}

function SessionChip({ badge }: { badge: StatTileModel['badge'] }): ReactElement | null {
  switch (badge) {
    case 'live':
      return (
        <Badge data-slot="session-on-air" variant="live">
          On air
        </Badge>
      )
    case 'recording':
      return <Badge variant="secondary">Recording</Badge>
    case 'history':
      return <Badge variant="secondary">History</Badge>
    default:
      return null
  }
}

function SplitCard({ tile, children }: { tile: StatTileModel; children: ReactNode }): ReactElement {
  if (!tile.split?.length) return <>{children}</>
  return (
    <HoverCard closeDelay={80} openDelay={400}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent align="start" className="w-64 p-2" data-slot="stat-split">
        <div className="px-1 pb-1 text-[11px] font-semibold text-subtle">{tile.label}</div>
        <div className="flex flex-col">
          {tile.split.map((row) => (
            <div
              key={`${row.platform}:${row.label}`}
              className="flex items-center gap-2 rounded-chip px-1 py-1 text-xs"
            >
              <ChatPlatformIcon decorative platform={row.platform} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
              <span className="flex shrink-0 flex-col items-end">
                <span className="font-medium text-foreground tabular-nums">{row.value}</span>
                {row.note ? (
                  <span className="max-w-40 truncate text-[11px] text-subtle" title={row.note}>
                    {row.note}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

/** A compact strip below Wide keeps the tiles a glance needs (D1): the pace
 * and support tiles return with the Activity pane's own summary. */
const WIDE_ONLY_TILES = new Set<StatTileModel['id']>(['supporters', 'tips', 'chat'])

function StatTile({ tile }: { tile: StatTileModel }): ReactElement {
  return (
    <SplitCard tile={tile}>
      <div
        className={cn(
          'flex min-w-0 flex-col gap-0.5 border-r border-b border-border px-3 py-2',
          WIDE_ONLY_TILES.has(tile.id) && '@max-[1039px]/stream-manager:hidden'
        )}
        data-slot="stat-tile"
        data-tile={tile.id}
        data-tone={tile.tone}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-semibold text-subtle">{tile.label}</span>
          {tile.tone === 'warning' ? <StatusDot className="ml-auto" tone="warn" /> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <SessionChip badge={tile.badge} />
          <span
            className={cn(
              'truncate text-base leading-tight font-semibold tabular-nums',
              tile.tone === 'subtle' ? 'text-subtle' : 'text-foreground'
            )}
            data-slot="stat-value"
          >
            {tile.value}
          </span>
        </span>
        {tile.detail ? (
          <span className="truncate text-xs text-muted-foreground" title={tile.detail}>
            {tile.detail}
          </span>
        ) : null}
        {tile.destinations?.length ? (
          <span className="flex min-w-0 flex-wrap items-center gap-2 pt-0.5">
            {tile.destinations.map((destination) => (
              <span
                key={destination.targetId}
                data-slot="stat-destination"
                title={
                  destination.message
                    ? `${destination.label}: ${destination.message}`
                    : `${destination.label}: ${destination.state}`
                }
              >
                <StatusDot
                  label={destination.label}
                  tone={DESTINATION_TONE[destination.state] ?? 'neutral'}
                />
              </span>
            ))}
          </span>
        ) : null}
        {tile.spark && tile.spark.length > 1 ? (
          <Sparkline
            className="mt-auto pt-1"
            label={tile.label}
            points={tile.spark}
            tone={tile.tone === 'warning' ? 'warning' : 'neutral'}
          />
        ) : null}
      </div>
    </SplitCard>
  )
}

export function StatsStrip({ tiles }: { tiles: readonly StatTileModel[] }): ReactElement {
  // History names its session in the History bar already.
  const summary = tiles.filter(
    (tile) =>
      (tile.id === 'session' && tile.badge !== 'history') ||
      tile.id === 'viewers' ||
      tile.id === 'followers'
  )
  return (
    <>
      <section
        aria-label="Stream stats"
        className={cn('shrink-0 overflow-hidden', ABOVE_NARROW)}
        data-slot="stats-strip"
      >
        {/* The outer hairlines are clipped: tiles draw right and bottom
            rules, the strip hides the last ones. */}
        <div className="-mr-px -mb-px grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))]">
          {tiles.map((tile) => (
            <StatTile key={tile.id} tile={tile} />
          ))}
        </div>
      </section>
      <section
        aria-label="Stream summary"
        className={cn(
          'h-8 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-3 text-xs',
          summary.length > 0 ? NARROW_ONLY : 'hidden'
        )}
        data-slot="stats-summary"
      >
        {summary.map((tile, index) => (
          <span
            key={tile.id}
            className="flex min-w-0 shrink-0 items-center gap-1.5 last:shrink"
            data-summary={tile.id}
          >
            {index > 0 ? <span className="text-subtle">·</span> : null}
            <SessionChip badge={tile.badge} />
            <span
              className={cn(
                'truncate font-medium tabular-nums',
                tile.tone === 'subtle' ? 'text-subtle' : 'text-foreground'
              )}
            >
              {tile.value}
            </span>
            {tile.id === 'viewers' ? (
              <span className="text-muted-foreground">
                {tile.label === 'Viewers' ? 'watching' : 'peak'}
              </span>
            ) : tile.id === 'followers' ? (
              <span className="truncate text-muted-foreground">followers</span>
            ) : null}
          </span>
        ))}
      </section>
    </>
  )
}
