import { useMemo, useState, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { CopyIcon, PreviewIcon, SendIcon, type AppIcon } from '@/components/icons'
import {
  AnnouncementIcon,
  FollowIcon,
  GiftIcon,
  RaidIcon,
  SupporterIcon,
  TipIcon
} from '@/components/stream-manager/activity-icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { StatusDot } from '@/components/status-dot'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { LiveChatProviderState, StreamPlatform } from '@/lib/backend'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import {
  ACTIVITY_FILTERS,
  filterActivity,
  formatActivitySummary,
  type ActivityFilter,
  type ActivityItem,
  type ActivityKind,
  type ActivityTotals
} from '@/lib/stream-activity'
import { cn } from '@/lib/utils'

// The Activity pane (plan 055, D4): structured events, never chat text.
// Follows, subs and gifts, tips, raids and announcements from the chat
// snapshot, and destination failures from the relayed dashboard.

const KIND_ICONS: Record<ActivityKind, AppIcon | null> = {
  follow: FollowIcon,
  subscription: SupporterIcon,
  membership: SupporterIcon,
  cheer: TipIcon,
  'super-chat': TipIcon,
  'super-sticker': TipIcon,
  raid: RaidIcon,
  announcement: AnnouncementIcon,
  'destination-failed': null,
  'destination-recovered': null
}

export function relativeTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** What Activity can never show for these platforms, said plainly. */
export function activityCapabilityNote(platforms: readonly StreamPlatform[]): string | null {
  const notes: string[] = []
  if (platforms.includes('x')) notes.push("X doesn't share follows or tips through its API.")
  if (platforms.some((platform) => ['tiktok', 'instagram', 'custom'].includes(platform))) {
    notes.push('TikTok, Instagram and custom RTMP have no public live API.')
  }
  return notes.length ? notes.join(' ') : null
}

function ActivityRow({
  item,
  nowMs,
  onShowOnStream,
  onThank
}: {
  item: ActivityItem
  nowMs: number
  onShowOnStream?: (item: ActivityItem) => void
  onThank?: (item: ActivityItem) => void
}): ReactElement {
  const Icon = item.gift ? GiftIcon : KIND_ICONS[item.kind]
  const destination = item.kind === 'destination-failed' || item.kind === 'destination-recovered'
  const actions: KebabMenuItem[] = [
    ...(onShowOnStream && item.messageId
      ? [
          {
            id: 'show',
            label: 'Show on stream',
            icon: PreviewIcon,
            onSelect: () => onShowOnStream(item)
          }
        ]
      : []),
    ...(onThank && !destination && item.kind !== 'announcement'
      ? [{ id: 'thank', label: 'Thank in chat', icon: SendIcon, onSelect: () => onThank(item) }]
      : []),
    {
      id: 'copy',
      label: 'Copy',
      icon: CopyIcon,
      onSelect: () =>
        void navigator.clipboard?.writeText(
          [item.name, item.line, item.message].filter(Boolean).join(' · ')
        )
    }
  ]
  return (
    <li
      className="flex items-start gap-2.5 px-3 py-2 hover:bg-accent"
      data-activity-id={item.id}
      data-kind={item.kind}
      data-slot="activity-row"
    >
      <span className="relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-chip bg-foreground/[0.06] text-muted-foreground">
        {Icon ? (
          <Icon aria-hidden className="size-4" weight="duotone" />
        ) : (
          <StatusDot tone={item.kind === 'destination-failed' ? 'error' : 'good'} />
        )}
        <ChatPlatformIcon
          className="absolute -right-1 -bottom-1 size-3"
          decorative
          platform={item.platform}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
          <time
            className="ml-auto shrink-0 text-[11px] text-subtle tabular-nums"
            dateTime={item.at}
          >
            {relativeTime(item.at, nowMs)}
          </time>
        </span>
        <span className="text-xs text-muted-foreground" data-slot="activity-line">
          {item.line}
        </span>
        {item.message ? (
          <span className="text-sm leading-snug break-words text-foreground select-text">
            {item.message}
          </span>
        ) : null}
      </span>
      <KebabMenu className="-mr-1 shrink-0" items={actions} label={`Actions for ${item.name}`} />
    </li>
  )
}

export function ActivityPane({
  items,
  totals,
  providers,
  nowMs,
  className,
  onShowOnStream,
  onThank
}: {
  items: readonly ActivityItem[]
  totals: ActivityTotals
  providers: readonly LiveChatProviderState[]
  nowMs: number
  className?: string
  onShowOnStream?: (item: ActivityItem) => void
  onThank?: (item: ActivityItem) => void
}): ReactElement {
  const [filter, setFilter] = useState<ActivityFilter | 'all'>('all')
  const [platform, setPlatform] = useState<StreamPlatform | 'all'>('all')
  const platforms = useMemo(
    () => [...new Set(providers.map((provider) => provider.platform))],
    [providers]
  )
  const shown = filterActivity(items, filter, platform)
  const summary = formatActivitySummary(totals)
  const note = activityCapabilityNote(platforms)

  return (
    <section
      aria-label="Activity"
      className={cn('min-h-0 flex-1 flex-col', className)}
      data-slot="activity-pane"
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2">
        <p className="truncate text-xs text-muted-foreground" data-slot="activity-summary">
          <span className="text-subtle">This stream:</span> {summary || 'nothing yet'}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <ToggleGroup
            aria-label="Filter activity"
            className="flex-wrap justify-start"
            size="sm"
            type="single"
            value={filter}
            onValueChange={(value) => setFilter((value || 'all') as ActivityFilter | 'all')}
          >
            <ToggleGroupItem className="h-6 px-2 text-xs" value="all">
              All
            </ToggleGroupItem>
            {ACTIVITY_FILTERS.map((option) => (
              <ToggleGroupItem
                key={option.id}
                className="h-6 px-2 text-xs"
                title={option.title}
                value={option.id}
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {platforms.length > 1 ? (
            <ToggleGroup
              aria-label="Filter activity by platform"
              size="sm"
              type="single"
              value={platform}
              onValueChange={(value) => setPlatform((value || 'all') as StreamPlatform | 'all')}
            >
              {platforms.map((option) => (
                <ToggleGroupItem
                  key={option}
                  aria-label={CHAT_PLATFORM_LABELS[option]}
                  className="h-6 min-w-6 px-1.5"
                  title={`Only ${CHAT_PLATFORM_LABELS[option]}`}
                  value={option}
                >
                  <ChatPlatformIcon decorative platform={option} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" type="scroll">
        {shown.length ? (
          <ol aria-label="Activity" className="flex flex-col divide-y divide-border">
            {shown.map((item) => (
              <ActivityRow
                key={item.id}
                item={item}
                nowMs={nowMs}
                onShowOnStream={onShowOnStream}
                onThank={onThank}
              />
            ))}
          </ol>
        ) : (
          <Empty className="border-0 p-6">
            <EmptyHeader>
              <EmptyDescription data-slot="activity-empty">
                {items.length
                  ? 'Nothing matches this filter.'
                  : 'Follows, subs, gifts, tips and raids appear here as they happen.'}
                {note ? <span className="mt-1 block text-subtle">{note}</span> : null}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </ScrollArea>
    </section>
  )
}
