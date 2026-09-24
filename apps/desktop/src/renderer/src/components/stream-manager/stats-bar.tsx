import { useState, type DragEvent, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { ViewersIcon } from '@/components/stream-manager/activity-icons'
import { Sparkline } from '@/components/stream-manager/sparkline'
import { Badge } from '@/components/ui/badge'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  DEFAULT_STAT_ORDER,
  type StatId,
  type StatItemModel,
  type StatTone
} from '@/lib/stream-manager-stats'
import {
  arrangeStats,
  DEFAULT_STATS_LAYOUT,
  LOCKED_STATS,
  moveStat,
  setStatHidden,
  type StatsLayout
} from '@/lib/stream-manager-stats-layout'
import { cn } from '@/lib/utils'

// The stats bar (plan 057, D1): one 32 px row at every width, flush under the
// title row. The main slots (by default the clock, viewers and health) sit
// together at the leading edge and are never clipped. The rest follow after a
// hairline and wrap onto a clipped second line when they do not fit, so a
// stat drops off the end whole and nothing measures the window. Numbers stay
// monochrome and tabular; tone lives in the dot and the chip. Every detail is
// one hover away. Drag a stat to move it; right-click the bar to show or
// hide stats (plan 057, D2).

/** The right-click menu's names for the stats a streamer can hide. */
const STAT_NAMES: Record<StatId, string> = {
  session: 'Clock',
  viewers: 'Viewers',
  health: 'Stream health',
  followers: 'Followers',
  supporters: 'Subs and members',
  tips: 'Tips',
  chat: 'Chat pace'
}

interface StatDrag {
  dragging: boolean
  dropTarget: boolean
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

const HEALTH_DOTS: Record<StatTone, StatusDotTone> = {
  good: 'good',
  warning: 'warn',
  error: 'error',
  neutral: 'neutral',
  subtle: 'neutral'
}

function SessionChip({ badge }: { badge: StatItemModel['badge'] }): ReactElement | null {
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

function StatLead({ item }: { item: StatItemModel }): ReactElement | null {
  switch (item.id) {
    case 'session':
      return <SessionChip badge={item.badge} />
    case 'viewers':
      return <ViewersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    case 'health':
      return <StatusDot className="shrink-0" tone={HEALTH_DOTS[item.tone]} />
    default:
      return null
  }
}

function StatDetails({ item }: { item: StatItemModel }): ReactElement {
  return (
    <HoverCardContent align="start" className="w-64 p-2" data-slot="stat-details">
      <div className="px-1 pb-1 text-[11px] font-semibold text-subtle">{item.label}</div>
      <div className="flex flex-col">
        {item.details.map((row, index) => (
          <div
            key={`${row.label}:${index}`}
            className="flex items-center gap-2 rounded-chip px-1 py-1 text-xs"
          >
            {row.platform ? <ChatPlatformIcon decorative platform={row.platform} /> : null}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
            <span className="flex shrink-0 flex-col items-end">
              <span className="flex items-center gap-1.5 font-medium text-foreground tabular-nums">
                {row.dot ? <StatusDot tone={row.dot} /> : null}
                {row.value}
              </span>
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
  )
}

function StatCell({
  item,
  main,
  drag
}: {
  item: StatItemModel
  main: boolean
  drag?: StatDrag
}): ReactElement {
  const trouble = item.tone === 'warning' || item.tone === 'error'
  // Health is the one main value that can grow ("YouTube Vertical failed"):
  // it truncates rather than push the bar past a 320 px window.
  const shrinks = main && item.id === 'health'
  const cell = (
    <span
      aria-label={item.description}
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-chip whitespace-nowrap',
        shrinks ? 'min-w-0' : 'shrink-0',
        drag?.dragging && 'opacity-50',
        drag?.dropTarget && 'bg-accent'
      )}
      data-group={main ? 'main' : 'more'}
      data-slot="stat-item"
      data-stat={item.id}
      data-tone={item.tone}
      draggable={drag ? true : undefined}
      role="img"
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDragStart={drag?.onDragStart}
      onDrop={drag?.onDrop}
    >
      <StatLead item={item} />
      <span
        className={cn(
          'tabular-nums',
          main ? 'text-[15px] leading-none font-semibold' : 'text-[13px] font-medium',
          item.tone === 'subtle' ? 'text-subtle' : 'text-foreground',
          shrinks && 'min-w-0 truncate'
        )}
        data-slot="stat-value"
      >
        {item.value}
      </span>
      {item.unit ? (
        <span className={cn('text-muted-foreground', main ? 'text-xs' : 'text-[13px]')}>
          {item.unit}
        </span>
      ) : null}
      {item.delta ? (
        <span className="text-xs text-muted-foreground tabular-nums">{item.delta}</span>
      ) : null}
      {main && item.spark && item.spark.length > 1 ? (
        // Sparklines are a Wide luxury; below it the number is the reading.
        <span className="hidden w-12 shrink-0 @min-[1040px]/stream-manager:block">
          <Sparkline
            className="h-4"
            label={item.label}
            points={item.spark}
            size={{ width: 48, height: 16 }}
            tone={trouble ? 'warning' : 'neutral'}
          />
        </span>
      ) : null}
    </span>
  )
  if (item.details.length === 0) return cell
  return (
    <HoverCard closeDelay={80} openDelay={400}>
      <HoverCardTrigger asChild>{cell}</HoverCardTrigger>
      <StatDetails item={item} />
    </HoverCard>
  )
}

export function StatsBar({
  items,
  layout = DEFAULT_STATS_LAYOUT,
  onLayoutChange
}: {
  items: readonly StatItemModel[]
  layout?: StatsLayout
  /** Absent: the order is fixed (tests, previews). */
  onLayoutChange?: (layout: StatsLayout) => void
}): ReactElement {
  const { main, more } = arrangeStats(items, layout)
  const [dragging, setDragging] = useState<StatId | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: StatId; after: boolean } | null>(null)
  const [menuTarget, setMenuTarget] = useState<StatId | null>(null)
  const shown = [...main, ...more].map((item) => item.id)

  /** `id` moved next to `neighbor`, or the same layout when that is refused. */
  const placed = (id: StatId, neighbor: StatId, after: boolean): StatsLayout => {
    const without = layout.order.filter((candidate) => candidate !== id)
    return moveStat(layout, id, without.indexOf(neighbor) + (after ? 1 : 0))
  }
  const change = (next: StatsLayout): void => {
    if (next !== layout) onLayoutChange?.(next)
  }

  const drag = (id: StatId): StatDrag | undefined =>
    onLayoutChange
      ? {
          dragging: dragging === id,
          dropTarget: dropTarget?.id === id && dragging !== id,
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', id)
            setDragging(id)
          },
          onDragOver: (event) => {
            if (!dragging || dragging === id) return
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            const after = event.clientX > box.left + box.width / 2
            if (dropTarget?.id !== id || dropTarget.after !== after) setDropTarget({ id, after })
          },
          onDrop: (event) => {
            event.preventDefault()
            if (dragging && dropTarget && dragging !== dropTarget.id) {
              change(placed(dragging, dropTarget.id, dropTarget.after))
            }
            setDragging(null)
            setDropTarget(null)
          },
          onDragEnd: () => {
            setDragging(null)
            setDropTarget(null)
          }
        }
      : undefined

  // "Move left" and "Move right" step past the neighbouring shown stat.
  const position = menuTarget ? shown.indexOf(menuTarget) : -1
  const moveLeft =
    menuTarget && position > 0 ? placed(menuTarget, shown[position - 1], false) : layout
  const moveRight =
    menuTarget && position >= 0 && position < shown.length - 1
      ? placed(menuTarget, shown[position + 1], true)
      : layout
  const isDefault =
    layout.hidden.length === 0 &&
    layout.order.every((id, index) => id === DEFAULT_STATS_LAYOUT.order[index])

  const bar = (
    <section
      aria-label="Stream stats"
      className="flex shrink-0 items-center overflow-hidden border-b border-border px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      data-slot="stats-bar"
      tabIndex={onLayoutChange ? 0 : undefined}
      onContextMenu={(event) => {
        const stat = (event.target as HTMLElement).closest('[data-stat]')
        setMenuTarget((stat?.getAttribute('data-stat') as StatId | null) ?? null)
      }}
    >
      <div className="flex min-w-0 items-center gap-4" data-slot="stats-main">
        {main.map((item) => (
          <StatCell key={item.id} drag={drag(item.id)} item={item} main />
        ))}
      </div>
      {more.length > 0 ? (
        // A fixed-height, clipped, wrapping row: a stat that does not fit
        // wraps out of sight whole. The zero-width lead lets even the first
        // stat wrap instead of showing half of itself.
        <div
          className="flex h-8 min-w-0 flex-1 flex-wrap content-start items-center overflow-hidden"
          data-slot="stats-more"
        >
          <span aria-hidden className="h-8 w-0" />
          {more.map((item, index) => (
            <span key={item.id} className="flex h-8 shrink-0 items-center">
              {index === 0 ? (
                <span aria-hidden className="mx-3 h-4 w-px bg-border" />
              ) : (
                <span aria-hidden className="mx-2 text-subtle">
                  ·
                </span>
              )}
              <StatCell drag={drag(item.id)} item={item} main={false} />
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
  if (!onLayoutChange) return bar
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{bar}</ContextMenuTrigger>
      <ContextMenuContent className="w-52" data-slot="stats-bar-menu">
        <ContextMenuLabel>Stats</ContextMenuLabel>
        {DEFAULT_STAT_ORDER.filter((id) => !LOCKED_STATS.has(id)).map((id) => (
          <ContextMenuCheckboxItem
            key={id}
            checked={!layout.hidden.includes(id)}
            onCheckedChange={(checked) => change(setStatHidden(layout, id, checked !== true))}
            onSelect={(event) => event.preventDefault()}
          >
            {STAT_NAMES[id]}
          </ContextMenuCheckboxItem>
        ))}
        {menuTarget ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={moveLeft === layout} onSelect={() => change(moveLeft)}>
              Move {STAT_NAMES[menuTarget]} left
            </ContextMenuItem>
            <ContextMenuItem disabled={moveRight === layout} onSelect={() => change(moveRight)}>
              Move {STAT_NAMES[menuTarget]} right
            </ContextMenuItem>
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={isDefault} onSelect={() => change(DEFAULT_STATS_LAYOUT)}>
          Reset stats
        </ContextMenuItem>
        <ContextMenuLabel className="text-subtle">Drag a stat to move it.</ContextMenuLabel>
      </ContextMenuContent>
    </ContextMenu>
  )
}
