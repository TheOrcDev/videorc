import { useMemo, useState, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import {
  HighlightStatus,
  commentHighlightPresentationForMessage,
  type CommentHighlightPresentation
} from '@/components/comment-row'
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
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type {
  AudienceSnapshot,
  CommentHighlightState,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'
import { AvatarCircle } from '@/lib/chat-avatar'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import {
  ACTIVITY_FILTERS,
  activityFilterCounts,
  filterActivity,
  type ActivityFilter,
  type ActivityItem,
  type ActivityKind
} from '@/lib/stream-activity'
import { cn } from '@/lib/utils'

// The Activity pane (plan 055, D4): structured events, never chat text.
// Follows, subs and gifts, tips, raids and announcements from the chat
// snapshot, and destination failures from the relayed dashboard. A row reads
// at a glance (plan 057, D3): the name and the short fact on one line, the
// viewer's own words below, the full sentence on hover. A row about one
// person shows that person (plan 071, S1): their avatar, or their initials
// until it loads, so the streamer can thank them by name.

const KIND_ICONS: Record<ActivityKind, AppIcon | null> = {
  follow: FollowIcon,
  subscription: SupporterIcon,
  membership: SupporterIcon,
  cheer: TipIcon,
  kicks: TipIcon,
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

/** A row about one named viewer or channel shows who, not what: follows,
 * subs, gifts, tips and raids. Unnamed follower counts, announcements and
 * destinations keep their glyph. */
export function activityRowShowsPerson(item: ActivityItem): boolean {
  if (item.unnamed) return false
  return (
    item.kind !== 'announcement' &&
    item.kind !== 'destination-failed' &&
    item.kind !== 'destination-recovered'
  )
}

/** Twitch counts followers without naming them until the account allows
 * the follow permission (plan 071, S2). */
export function twitchNeedsFollowNames(
  platforms: readonly StreamPlatform[],
  audience?: AudienceSnapshot | null
): boolean {
  const twitch = audience?.platforms.find((entry) => entry.platform === 'twitch')
  return platforms.includes('twitch') && twitch?.audienceScopes === false
}

/** What Activity can never show for these platforms, said plainly. */
export function activityCapabilityNote(
  platforms: readonly StreamPlatform[],
  audience?: AudienceSnapshot | null
): string | null {
  const notes: string[] = []
  if (platforms.includes('x')) {
    // X names each follower while its follow subscription is live (plan 071,
    // S4); it never shares tips.
    const x = audience?.platforms.find((entry) => entry.platform === 'x')
    const named = Boolean(x?.namedFollowsSince) && !x?.namedFollowsUntil
    notes.push(
      named ? "X doesn't share tips." : "X doesn't share tips. New X followers show as a count."
    )
  }
  if (platforms.includes('kick')) {
    notes.push("Kick shows each new follow but doesn't share a follower total.")
  }
  if (twitchNeedsFollowNames(platforms, audience)) {
    notes.push('Twitch names each follower once you allow it.')
  }
  if (platforms.some((platform) => ['tiktok', 'instagram', 'custom'].includes(platform))) {
    notes.push('TikTok, Instagram and custom RTMP have no public live API.')
  }
  return notes.length ? notes.join(' ') : null
}

const IDLE: CommentHighlightPresentation = { phase: 'idle' }

/** What the stream shows for this row (plan 095, S2): the same slot and id as
 * chat, so a row with a chat message behind it reads exactly like that chat
 * row. Rows without one (destinations, counts) are never on stream. */
export function activityHighlight(
  item: ActivityItem,
  slot: {
    liveHighlightId?: string | null
    highlightState?: CommentHighlightState
    highlightApplyingId?: string | null
    highlightFailure?: { messageId: string; reason: string } | null
  }
): CommentHighlightPresentation {
  if (!item.messageId) return IDLE
  return commentHighlightPresentationForMessage({
    messageId: item.messageId,
    highlightedId: slot.liveHighlightId,
    state: slot.highlightState,
    applyingId: slot.highlightApplyingId,
    failure: slot.highlightFailure
  })
}

/** The row's ⋯ menu. Show on stream toggles, so on a live row it says what a
 * click does: Remove from stream (plan 095, S2). */
export function activityRowActions(
  item: ActivityItem,
  highlight: CommentHighlightPresentation,
  {
    onShowOnStream,
    onThank,
    onShowFollowNames
  }: {
    onShowOnStream?: (item: ActivityItem) => void
    onThank?: (item: ActivityItem) => void
    onShowFollowNames?: () => void
  }
): KebabMenuItem[] {
  const destination = item.kind === 'destination-failed' || item.kind === 'destination-recovered'
  return [
    ...(onShowOnStream && item.messageId
      ? [
          {
            id: 'show',
            label: highlight.phase === 'live' ? 'Remove from stream' : 'Show on stream',
            icon: PreviewIcon,
            disabled: highlight.phase === 'applying',
            onSelect: () => onShowOnStream(item)
          }
        ]
      : []),
    ...(onThank && !destination && item.kind !== 'announcement'
      ? [{ id: 'thank', label: 'Thank in chat', icon: SendIcon, onSelect: () => onThank(item) }]
      : []),
    // A Twitch count without names: one click opens the reconnect that
    // grants the follow permission (plan 071, S2).
    ...(onShowFollowNames && item.unnamed && item.platform === 'twitch'
      ? [
          {
            id: 'follow-names',
            label: 'Show who followed',
            icon: FollowIcon,
            onSelect: onShowFollowNames
          }
        ]
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
}

function ActivityRow({
  item,
  nowMs,
  highlight,
  onShowOnStream,
  onThank,
  onShowFollowNames
}: {
  item: ActivityItem
  nowMs: number
  highlight: CommentHighlightPresentation
  onShowOnStream?: (item: ActivityItem) => void
  onThank?: (item: ActivityItem) => void
  onShowFollowNames?: () => void
}): ReactElement {
  const Icon = item.gift ? GiftIcon : KIND_ICONS[item.kind]
  const person = activityRowShowsPerson(item)
  const actions = activityRowActions(item, highlight, {
    onShowOnStream,
    onThank,
    onShowFollowNames
  })
  const status = highlight.phase !== 'idle'
  return (
    <li
      className={cn(
        'flex items-start gap-2.5 px-3 py-2 hover:bg-accent',
        highlight.phase === 'live' && 'bg-accent'
      )}
      data-activity-id={item.id}
      data-highlight-phase={item.messageId ? highlight.phase : undefined}
      data-kind={item.kind}
      data-slot="activity-row"
    >
      <span
        className={cn(
          'relative mt-0.5 flex size-7 shrink-0 items-center justify-center',
          !person && 'rounded-chip bg-foreground/[0.06] text-muted-foreground'
        )}
        data-slot={person ? 'activity-avatar' : 'activity-glyph'}
      >
        {person ? (
          <AvatarCircle avatarUrl={item.authorAvatarUrl} className="size-7" name={item.name} />
        ) : Icon ? (
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
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className="max-w-[60%] shrink-0 truncate text-sm font-medium text-foreground"
            title={item.short ? undefined : item.line}
          >
            {item.name}
          </span>
          <span
            className="min-w-0 truncate text-sm text-muted-foreground"
            data-slot="activity-line"
            title={item.line}
          >
            {item.short}
          </span>
          {status ? (
            <span className="ml-auto shrink-0 pl-1" data-slot="activity-highlight">
              <HighlightStatus status={highlight} />
            </span>
          ) : null}
          <time
            className={cn(
              'shrink-0 pl-1 text-[11px] text-subtle tabular-nums',
              !status && 'ml-auto'
            )}
            dateTime={item.at}
          >
            {relativeTime(item.at, nowMs)}
          </time>
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
  audience,
  providers,
  nowMs,
  className,
  liveHighlightId = null,
  highlightState,
  highlightApplyingId = null,
  highlightFailure = null,
  onShowOnStream,
  onThank,
  onShowFollowNames
}: {
  items: readonly ActivityItem[]
  audience?: AudienceSnapshot | null
  providers: readonly LiveChatProviderState[]
  nowMs: number
  className?: string
  /** The message on stream now (plan 095, S2): Activity shares chat's slot. */
  liveHighlightId?: string | null
  highlightState?: CommentHighlightState
  highlightApplyingId?: string | null
  highlightFailure?: { messageId: string; reason: string } | null
  onShowOnStream?: (item: ActivityItem) => void
  onThank?: (item: ActivityItem) => void
  /** Reconnect Twitch with its follow permission (plan 071, S2). */
  onShowFollowNames?: () => void
}): ReactElement {
  const [filter, setFilter] = useState<ActivityFilter | 'all'>('all')
  const [platform, setPlatform] = useState<StreamPlatform | 'all'>('all')
  const platforms = useMemo(
    () => [...new Set(providers.map((provider) => provider.platform))],
    [providers]
  )
  const shown = filterActivity(items, filter, platform)
  // Counts follow the platform pick: a chip says what a click would show.
  const counts = activityFilterCounts(filterActivity(items, 'all', platform))
  const note = activityCapabilityNote(platforms, audience)

  return (
    <section
      aria-label="Activity"
      className={cn('min-h-0 flex-1 flex-col', className)}
      data-slot="activity-pane"
    >
      <div className="flex shrink-0 items-center border-b border-border px-2 py-1.5">
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
            {/* A chip shows once it has rows, with its count: the pane's
                old "This stream: …" sentence, where it can be clicked. */}
            {ACTIVITY_FILTERS.filter((option) => counts[option.id] > 0 || filter === option.id).map(
              (option) => (
                <ToggleGroupItem
                  key={option.id}
                  className="h-6 gap-1 px-2 text-xs"
                  title={option.title}
                  value={option.id}
                >
                  {option.label}
                  <span className="text-muted-foreground tabular-nums">{counts[option.id]}</span>
                </ToggleGroupItem>
              )
            )}
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
                highlight={activityHighlight(item, {
                  liveHighlightId,
                  highlightState,
                  highlightApplyingId,
                  highlightFailure
                })}
                item={item}
                nowMs={nowMs}
                onShowOnStream={onShowOnStream}
                onThank={onThank}
                onShowFollowNames={onShowFollowNames}
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
              {onShowFollowNames && twitchNeedsFollowNames(platforms, audience) ? (
                <Button
                  className="mt-2"
                  data-slot="activity-follow-names"
                  size="sm"
                  variant="outline"
                  onClick={onShowFollowNames}
                >
                  Show who followed
                </Button>
              ) : null}
            </EmptyHeader>
          </Empty>
        )}
      </ScrollArea>
    </section>
  )
}
