import { useMemo, useState, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import {
  HighlightStatus,
  commentHighlightPresentationForMessage,
  highlightProblem,
  type CommentHighlightPresentation
} from '@/components/comment-row'
import {
  ChevronDownIcon,
  CopyIcon,
  LivestreamIcon,
  SendIcon,
  type AppIcon
} from '@/components/icons'
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
import {
  PlatformFilter,
  PlatformFilterMenuItems
} from '@/components/stream-manager/platform-filter'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  AudienceSnapshot,
  CommentHighlightState,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'
import { AvatarCircle } from '@/lib/chat-avatar'
import { copyChatText } from '@/lib/chat-link-actions'
import { formatRelativeTime } from '@/lib/format-time'
import { ABOVE_NARROW, NARROW_ONLY } from '@/lib/stream-manager-layout'
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
// Follows, subs and gifts, tips, raids, watch streaks and announcements from the chat
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
  // Always about one viewer, so the row shows their avatar and never a glyph
  // (plan 151, D5): no licensed icon is spent on it.
  'watch-streak': null,
  announcement: AnnouncementIcon,
  'power-up': TipIcon,
  // About one viewer, so the row shows their avatar (plan 162).
  redemption: null,
  'destination-failed': null,
  'destination-recovered': null
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

/** Twitch sends Power-ups and channel point redemptions only once the
 * account allows them (plan 162). */
export function twitchNeedsBitsPoints(
  platforms: readonly StreamPlatform[],
  audience?: AudienceSnapshot | null
): boolean {
  const twitch = audience?.platforms.find((entry) => entry.platform === 'twitch')
  return platforms.includes('twitch') && twitch?.bitsPointsScopes === false
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

/** The one label for every Twitch permission ask in the window (plan 174 H-14). */
export const TWITCH_RECONNECT_LABEL = 'Reconnect Twitch'

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
 * click does: Take off stream (plan 095, S2; plan 140 review: only removing
 * a chat message says "Remove"). */
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
            label: highlight.phase === 'live' ? 'Take off stream' : 'Show on stream',
            icon: LivestreamIcon,
            disabled: highlight.phase === 'applying',
            onSelect: () => onShowOnStream(item)
          }
        ]
      : []),
    ...(onThank && !destination && item.kind !== 'announcement'
      ? [{ id: 'thank', label: 'Thank in chat', icon: SendIcon, onSelect: () => onThank(item) }]
      : []),
    // A Twitch count without names: one click opens the reconnect that
    // grants the follow permission (plan 071, S2), under the one name every
    // Twitch permission ask carries (plan 174 H-14).
    ...(onShowFollowNames && item.unnamed && item.platform === 'twitch'
      ? [
          {
            id: 'follow-names',
            label: TWITCH_RECONNECT_LABEL,
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
        void copyChatText([item.name, item.line, item.message].filter(Boolean).join(' · '))
    }
  ]
}

function ActivityRow({
  item,
  nowMs,
  highlight,
  timestamps,
  onShowOnStream,
  onThank,
  onShowFollowNames
}: {
  item: ActivityItem
  nowMs: number
  highlight: CommentHighlightPresentation
  timestamps: 'always' | 'hover'
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
  // The full sentence, when it says more than the short fact.
  const sentence = item.short && item.line !== item.short ? item.line : null
  const problem = highlightProblem(highlight)
  // One row contract with chat (plan 174 S3.16a, H-19): no hover highlight on
  // a row that is not a button, the ⋯ waits for the pointer, and the time
  // does too while live.
  return (
    <li
      className={cn(
        'group/activity group/kebab-host flex items-start gap-2.5 px-3 py-2',
        highlight.phase === 'live' && 'bg-accent'
      )}
      data-activity-id={item.id}
      data-highlight-phase={item.messageId ? highlight.phase : undefined}
      data-kind={item.kind}
      data-slot="activity-row"
    >
      <span
        className={cn(
          'relative mt-0.5 flex size-9 shrink-0 items-center justify-center',
          !person && 'rounded-chip bg-foreground/[0.06] text-muted-foreground'
        )}
        data-slot={person ? 'activity-avatar' : 'activity-glyph'}
      >
        {person ? (
          <AvatarCircle avatarUrl={item.authorAvatarUrl} className="size-9" name={item.name} />
        ) : Icon ? (
          <Icon aria-hidden className="size-4" weight="duotone" />
        ) : (
          <StatusDot tone={item.kind === 'destination-failed' ? 'error' : 'good'} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          {/* Facts, not sentences (plan 057, D3): the sentence is the short
              fact's tooltip, or the name's when there is no fact, and what a
              screen reader hears (plan 174 S1.10). */}
          <SentenceHint line={item.short ? null : item.line}>
            <span className="max-w-[60%] shrink-0 truncate text-sm font-medium text-foreground">
              {item.name}
            </span>
          </SentenceHint>
          {item.short ? (
            <SentenceHint line={sentence}>
              <span
                aria-hidden={sentence ? true : undefined}
                className="min-w-0 truncate text-sm text-muted-foreground"
                data-slot="activity-line"
              >
                {item.short}
              </span>
            </SentenceHint>
          ) : null}
          {sentence || !item.short ? (
            <span className="sr-only" data-slot="activity-sentence">
              {item.line}
            </span>
          ) : null}
          {status ? (
            <span className="ml-auto shrink-0 pl-1" data-slot="activity-highlight">
              <HighlightStatus status={highlight} />
            </span>
          ) : null}
          <time
            className={cn(
              'shrink-0 pl-1 text-[11px] text-muted-foreground tabular-nums',
              !status && 'ml-auto',
              timestamps === 'hover' &&
                'opacity-0 group-focus-within/activity:opacity-100 group-hover/activity:opacity-100'
            )}
            dateTime={item.at}
          >
            {formatRelativeTime(item.at, nowMs)}
          </time>
          {/* The platform mark closes the row on the far right (owner call,
              plan 165): 20 px, never shrunk onto the avatar. */}
          <ChatPlatformIcon className="ml-1 mr-0 self-center" decorative platform={item.platform} />
        </span>
        {item.message ? (
          <span className="text-sm leading-snug break-words text-foreground select-text">
            {item.message}
          </span>
        ) : null}
        {problem ? (
          // Why it did not go on stream, while the badge says Failed (H-16).
          <span className="text-xs text-muted-foreground" data-testid="highlight-failed-reason">
            {problem}
          </span>
        ) : null}
      </span>
      <KebabMenu
        className="-mr-1 shrink-0"
        items={actions}
        label={`Actions for ${item.name}`}
        reveal="hover"
      />
    </li>
  )
}

/** An Activity row's full sentence on hover (plan 174 S1.10): never a
 * native `title`. Nothing to add, no tooltip. */
function SentenceHint({
  line,
  children
}: {
  line: string | null
  children: ReactElement
}): ReactElement {
  if (!line) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{line}</TooltipContent>
    </Tooltip>
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
  onShowFollowNames,
  autoShow = false,
  onAutoShowChange,
  timestamps = 'always'
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
  /** Reconnect Twitch with every optional permission: follow names (plan
   * 071, S2), Power-ups and channel points (plan 162). */
  onShowFollowNames?: () => void
  /** Auto-show celebrations on stream (plan 156): the one switch. */
  autoShow?: boolean
  onAutoShowChange?: (on: boolean) => void
  /** 'hover' keeps a row's time out of sight until the pointer is on it (live). */
  timestamps?: 'always' | 'hover'
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
  const shownFilters = ACTIVITY_FILTERS.filter(
    (option) => counts[option.id] > 0 || filter === option.id
  )
  const activeFilterCount = Number(filter !== 'all') + Number(platform !== 'all')
  const note = activityCapabilityNote(platforms, audience)

  return (
    <section
      aria-label="Activity"
      className={cn('min-h-0 flex-1 flex-col', className)}
      data-slot="activity-pane"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <div className={cn('min-w-0 flex-wrap items-center gap-1', 'flex', ABOVE_NARROW)}>
          <ToggleGroup
            aria-label="Filter activity"
            className="flex-wrap justify-start"
            type="single"
            value={filter}
            onValueChange={(value) => setFilter((value || 'all') as ActivityFilter | 'all')}
          >
            <ToggleGroupItem className="text-xs" value="all">
              All
            </ToggleGroupItem>
            {/* A chip shows once it has rows, with its count: the pane's
                old "This stream: …" sentence, where it can be clicked. */}
            {shownFilters.map((option) => (
              // ShortcutTooltip wraps the chip: a trigger's own data-state
              // would overwrite the item's on/off state.
              <ShortcutTooltip key={option.id} label={option.title}>
                <ToggleGroupItem className="gap-1 text-xs" value={option.id}>
                  {option.label}
                  <span className="text-muted-foreground tabular-nums">{counts[option.id]}</span>
                </ToggleGroupItem>
              </ShortcutTooltip>
            ))}
          </ToggleGroup>
          {/* The same platform filter as chat (plan 174 S3.16a, H-19). */}
          <PlatformFilter
            label="Show activity from"
            platforms={platforms}
            value={platform}
            onValueChange={setPlatform}
          />
        </div>
        {/* Below 640 px the same filters live in one menu, like chat's. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Activity filters"
              className={cn('shrink-0 gap-1 px-2 text-xs', NARROW_ONLY)}
              type="button"
              variant="ghost"
            >
              Filters
              {activeFilterCount > 0 ? (
                <Badge className="px-1.5" variant="outline">
                  {activeFilterCount}
                </Badge>
              ) : null}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => setFilter(value as ActivityFilter | 'all')}
            >
              <DropdownMenuRadioItem value="all">Everything</DropdownMenuRadioItem>
              {shownFilters.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                  <span className="ml-auto text-muted-foreground tabular-nums">
                    {counts[option.id]}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {platforms.length > 1 ? (
              <>
                <DropdownMenuSeparator />
                <PlatformFilterMenuItems
                  label="Show activity from"
                  platforms={platforms}
                  value={platform}
                  onValueChange={setPlatform}
                />
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Auto-show (plan 156): new follows, subs, gifts, tips, rewards,
            raids and streaks pop onto the stream as the highlight card, hands-free.
            Manual picks always win; the switch only feeds an idle slot. */}
        {onAutoShowChange ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="ml-auto flex h-6 shrink-0 items-center gap-1.5 text-xs text-muted-foreground select-none">
                Auto-show
                <Switch
                  aria-label="Automatically show new follows, subs, gifts, tips, rewards, raids and streaks on stream"
                  checked={autoShow}
                  data-testid="activity-auto-show"
                  size="sm"
                  onCheckedChange={onAutoShowChange}
                />
              </label>
            </TooltipTrigger>
            <TooltipContent>
              Shows new follows, subs, gifts, tips, rewards, raids and streaks on stream for a few
              seconds
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {/* Plan 162: Power-ups and redemptions arrive with no row of their own
          to carry the ask, so it stays in view until Twitch allows them. */}
      {onShowFollowNames && twitchNeedsBitsPoints(platforms, audience) ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5"
          data-slot="activity-bits-points"
        >
          <span className="text-xs text-muted-foreground">
            Power-ups and channel points need one more Twitch permission.
          </span>
          <Button className="shrink-0" size="xs" variant="outline" onClick={onShowFollowNames}>
            {TWITCH_RECONNECT_LABEL}
          </Button>
        </div>
      ) : null}
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
                timestamps={timestamps}
                onShowOnStream={onShowOnStream}
                onThank={onThank}
                onShowFollowNames={onShowFollowNames}
              />
            ))}
          </ol>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyDescription data-testid="activity-empty">
                {items.length
                  ? 'Nothing matches this filter.'
                  : 'Follows, subs, gifts, tips and raids appear here as they happen.'}
                {note ? <span className="mt-1 block text-muted-foreground">{note}</span> : null}
              </EmptyDescription>
              {onShowFollowNames && twitchNeedsFollowNames(platforms, audience) ? (
                <Button
                  className="mt-2"
                  data-testid="activity-follow-names"
                  variant="outline"
                  onClick={onShowFollowNames}
                >
                  {TWITCH_RECONNECT_LABEL}
                </Button>
              ) : null}
            </EmptyHeader>
          </Empty>
        )}
      </ScrollArea>
    </section>
  )
}
