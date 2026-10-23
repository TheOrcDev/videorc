import { lazy, Suspense, useRef, useState, type ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { HIGHLIGHT_ANCHOR_LABELS, HighlightAnchorOptions } from '@/components/comments-header'
import { providerBadgeTitle } from '@/components/comments-destination-status'
import { ClipIcon, FrameIcon, MoreIcon, PreviewIcon } from '@/components/icons'
import { PIN_WINDOW_LABEL, PinWindowButton } from '@/components/pin-window-button'
import { StatusBar, StatusBarHint } from '@/components/status-bar'
import { StatusBarAction } from '@/components/status-bar-action'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { STAT_NAMES } from '@/components/stream-manager/stats-bar'
import type { AudienceSnapshot, CommentHighlightAnchor, LiveChatProviderState } from '@/lib/backend'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { ABOVE_NARROW, COMPACT_LABEL, NARROW_ONLY } from '@/lib/stream-manager-layout'
import { chatStateLabel } from '@/lib/state-labels'
import { DEFAULT_STAT_ORDER } from '@/lib/stream-manager-stats'
import {
  DEFAULT_STATS_LAYOUT,
  LOCKED_STATS,
  setStatHidden,
  type StatsLayout
} from '@/lib/stream-manager-stats-layout'
import { waitingProviderMessage } from '@/lib/youtube-quota-copy'
import { WINDOW_NAMES } from '../../../../shared/window-names'
import type { BannerRelayAction, BannerSummary } from '../../../../shared/banner-commands'
import type { SoundRelayAction, SoundboardSummary } from '../../../../shared/sound-commands'
import { cn } from '@/lib/utils'

// The Sounds popover's pads (plan 189 S9): audiocn's pad loads with the first open.
const SoundsPopoverBody = lazy(() => import('@/components/stream-manager/sounds-popover'))

// The Stream Manager's status bar (plan 055, D6): each provider's chat state
// on the left, the window's quiet controls on the right. The title row keeps
// the title only (owner call, 2026-09-23: no buttons in the top-right corner).
// Below 640 px the controls fold into one ⋯ menu so none is ever clipped.
// Quiet when fine (plan 057, D3): a platform that reads and sends is its icon
// and a green dot, and the controls are icons with their names on hover.

function providerTone(provider: LiveChatProviderState): StatusDotTone {
  switch (provider.state) {
    case 'connected':
      return 'good'
    case 'connecting':
    case 'reconnecting':
    case 'waiting':
      return 'warn'
    case 'failed':
      return 'error'
    default:
      return 'neutral'
  }
}

/**
 * What chat cannot do on this platform right now, in a word or two:
 * "read-only", "reconnect to send", "failed". Empty when it reads and sends,
 * so a healthy platform is just its icon and dot. The words are the chat
 * vocabulary every window shares (`chatStateLabel`, plan 174 H-13), set
 * inline after the platform's icon.
 */
export function providerCapabilityLabel(provider: LiveChatProviderState): string {
  const label = chatStateLabel(provider)
  return label === 'Connected' ? '' : label.toLowerCase()
}

/**
 * The provider's own words when chat is stuck or has stopped ("Kick chat
 * can't connect: Videorc's chat relay is down…"), shown inline instead of a
 * bare "waiting" (plan 066). Empty otherwise: healthy stays quiet.
 */
export function providerProblem(provider: LiveChatProviderState): string {
  if (provider.state !== 'waiting' && provider.state !== 'failed') return ''
  // Plan 094: a parked connector says until when, in local time.
  return waitingProviderMessage(provider)
}

/** The hover text: what chat can do, the provider's own words, audience notes. */
export function providerCapabilityTitle(
  provider: LiveChatProviderState,
  audience: AudienceSnapshot | null
): string {
  const capability = providerCapabilityLabel(provider) || 'reads and sends'
  const lines = [
    `${CHAT_PLATFORM_LABELS[provider.platform]} chat: ${capability}`,
    providerBadgeTitle(provider)
  ]
  const entry = audience?.platforms.find((candidate) => candidate.platform === provider.platform)
  if (entry?.message && entry.capability !== 'available') lines.push(entry.message)
  if (entry?.capability === 'delta-only') {
    lines.push('Kick shows new follows only, not a follower total.')
  }
  if (provider.platform === 'twitch' && entry?.audienceScopes === false) {
    lines.push(
      'Follow alerts and the sub count need one more Twitch permission. Reconnect Twitch from Activity or Livestream → Setup.'
    )
  }
  if (provider.platform === 'twitch' && entry?.bitsPointsScopes === false) {
    lines.push(
      'Power-ups and channel points need one more Twitch permission. Reconnect Twitch from Activity or Livestream → Setup.'
    )
  }
  return lines.filter(Boolean).join('\n')
}

/**
 * The Banners menu's items (plan 186 S7), in Assets order: one check per
 * banner (checked while it shows), then Hide all banners. Each choice asks
 * Studio, and the check moves when the list comes back, so the menu stays
 * open for the next one. Before the list loads, and with none, one line says
 * so.
 */
function BannerMenuItems({
  banners,
  onBanner
}: {
  banners: readonly BannerSummary[] | null
  onBanner: (action: BannerRelayAction) => void
}): ReactElement {
  if (!banners?.length) {
    return (
      <DropdownMenuItem disabled>
        {banners ? 'Import banners in Assets' : 'Loading banners…'}
      </DropdownMenuItem>
    )
  }
  return (
    <>
      <DropdownMenuGroup>
        {banners.map((banner) => (
          <DropdownMenuCheckboxItem
            key={banner.id}
            checked={banner.shown}
            onCheckedChange={(checked) =>
              onBanner({ action: checked === true ? 'show' : 'hide', id: banner.id })
            }
            onSelect={(event) => event.preventDefault()}
          >
            <span className="truncate">{banner.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={!banners.some((banner) => banner.shown)}
        onSelect={() => onBanner({ action: 'hideAll' })}
      >
        Hide all banners
      </DropdownMenuItem>
    </>
  )
}

export function StreamManagerStatusBar({
  providers,
  audience,
  alwaysOnTop,
  highlightAnchor,
  onToggleAlwaysOnTop,
  onHighlightAnchorChange,
  onClear,
  onMarkClip,
  banners = null,
  onBanner,
  sounds = null,
  onSound,
  onOpenPreview,
  onSearchChat,
  onFocusComposer,
  onFocusBuddy,
  statsLayout,
  onStatsLayoutChange
}: {
  providers: readonly LiveChatProviderState[]
  audience: AudienceSnapshot | null
  alwaysOnTop: boolean
  highlightAnchor?: CommentHighlightAnchor
  onToggleAlwaysOnTop?: () => void
  onHighlightAnchorChange?: (anchor: CommentHighlightAnchor) => void
  onClear?: () => void
  /** Plan 068 D6: present only while on air. Word and icon: mid-stream there
   * is no time to hover. */
  onMarkClip?: () => void
  /** Plan 186 S7: the Banners menu, on air or not (banners matter in
   * recordings too). `banners` is null until Studio has read the list. */
  banners?: readonly BannerSummary[] | null
  onBanner?: (action: BannerRelayAction) => unknown
  /** Plan 189 S9: the Sounds popover, on air or not (sounds matter in
   * recordings too). `sounds` is null until Studio has read the board. */
  sounds?: SoundboardSummary | null
  onSound?: (action: SoundRelayAction) => unknown
  onOpenPreview?: () => void
  /** The window's keyboard hints (plan 174 S3.16a, H-7): ⌘F, ⌘L, ⌘J. Each
   * is still clickable; below 800 px only the key shows, below 640 px they
   * sit in the ⋯ menu. */
  onSearchChat?: () => void
  onFocusComposer?: () => void
  onFocusBuddy?: () => void
  /** The stats bar's right-click choices, reachable from the ⋯ menu too
   * (plan 174 H-15): show or hide a stat, reset. */
  statsLayout?: StatsLayout
  onStatsLayoutChange?: (layout: StatsLayout) => void
}): ReactElement {
  const anchorControl =
    highlightAnchor && onHighlightAnchorChange
      ? { anchor: highlightAnchor, onChange: onHighlightAnchorChange }
      : null
  // Plan 174 S0.3 (H-6): Clear empties chat and Activity for this window and
  // cannot be undone, so both its homes (the button, the ⋯ menu) ask first.
  const [confirmingClear, setConfirmingClear] = useState(false)
  const requestClear = onClear ? () => setConfirmingClear(true) : undefined
  // One Sounds popover for both homes: the action above 640 px, the ⋯ menu's
  // Sounds… below it. It anchors on the controls, which are always on screen.
  const [soundsOpen, setSoundsOpen] = useState(false)
  // The ⋯ menu's Sounds… opens the popover once the menu has let the focus
  // go, so the menu's focus return never dismisses what it opened.
  const soundsAfterMenu = useRef(false)
  const bannerItems = onBanner ? (
    <BannerMenuItems banners={banners} onBanner={(action) => void onBanner(action)} />
  ) : null
  const hints = [
    ...(onSearchChat
      ? [
          {
            id: 'chat-search' as const,
            label: 'Search',
            menuLabel: 'Search chat',
            run: onSearchChat
          }
        ]
      : []),
    ...(onFocusComposer
      ? [
          {
            id: 'chat-composer' as const,
            label: 'Write',
            menuLabel: 'Write in chat',
            run: onFocusComposer
          }
        ]
      : []),
    ...(onFocusBuddy
      ? [
          {
            id: 'cohost-focus' as const,
            label: 'Buddy',
            menuLabel: 'Focus Buddy',
            run: onFocusBuddy
          }
        ]
      : [])
  ]
  return (
    <>
      {/* 32 px, not the shared 26: the platform icons are 20 px (YouTube's
        minimum, plan 165) and need room above and below inside the border. */}
      <StatusBar
        className="h-8 gap-2"
        leading={
          // The clip keeps chips that cannot shrink off the controls at narrow
          // widths. The padding (cancelled by the negative margin) is the status
          // dot's 2 px halo and 8 px glow, which paint outside its box: without
          // it the last dot is cut flat on the right.
          <span
            className="-my-1 -mr-2 flex min-w-0 items-center gap-3 overflow-hidden py-1 pr-2"
            data-slot="chat-states"
          >
            {providers.map((provider) => {
              const label = providerCapabilityLabel(provider)
              const problem = providerProblem(provider)
              const tone = providerTone(provider)
              const lines = providerCapabilityTitle(provider, audience).split('\n')
              // The details open on hover and on focus (plan 174 H-15), and
              // below 640 px a dot that is not green keeps a word beside it.
              return (
                <HoverCard key={provider.id} closeDelay={80} openDelay={400}>
                  <HoverCardTrigger asChild>
                    <button
                      aria-label={lines[0]}
                      className="-mx-1 flex min-w-0 shrink items-center gap-1.5 rounded-chip px-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                      data-slot="chat-state"
                      type="button"
                    >
                      <ChatPlatformIcon decorative platform={provider.platform} />
                      <StatusDot tone={tone} />
                      {problem ? (
                        <span
                          className={cn('max-w-[32rem] truncate', ABOVE_NARROW)}
                          data-slot="chat-state-problem"
                        >
                          {problem}
                        </span>
                      ) : label ? (
                        <span className={cn('truncate', ABOVE_NARROW, COMPACT_LABEL)}>
                          {CHAT_PLATFORM_LABELS[provider.platform]} {label}
                        </span>
                      ) : null}
                      {tone !== 'good' && label ? (
                        <span className={cn('truncate', NARROW_ONLY)} data-slot="chat-state-word">
                          {label}
                        </span>
                      ) : null}
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent align="start" className="w-64 p-2" side="top">
                    <div className="flex flex-col gap-1 text-xs">
                      {lines.map((line, index) => (
                        <p
                          key={`${line}:${index}`}
                          className={
                            index === 0 ? 'font-medium text-foreground' : 'text-muted-foreground'
                          }
                        >
                          {line}
                        </p>
                      ))}
                    </div>
                  </HoverCardContent>
                </HoverCard>
              )
            })}
          </span>
        }
      >
        <Popover open={soundsOpen} onOpenChange={setSoundsOpen}>
          <PopoverAnchor asChild>
            <div className="flex min-w-0 items-center" data-slot="stream-manager-controls">
              <div
                className={cn(
                  'items-center gap-0.5 [-webkit-app-region:no-drag]',
                  'flex',
                  ABOVE_NARROW
                )}
                data-slot="stream-manager-actions"
              >
                {hints.map((hint) => (
                  <StatusBarHint
                    key={hint.id}
                    accelerator={shortcutAccelerator(hint.id)}
                    label={hint.label}
                    labelClassName={COMPACT_LABEL}
                    onClick={hint.run}
                  />
                ))}
                {onToggleAlwaysOnTop ? (
                  <PinWindowButton
                    pinned={alwaysOnTop}
                    variant="status-bar"
                    onPinnedChange={() => onToggleAlwaysOnTop()}
                  />
                ) : null}
                {anchorControl ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <StatusBarAction
                        hint={`Highlight position: ${HIGHLIGHT_ANCHOR_LABELS[anchorControl.anchor]}`}
                        icon={<FrameIcon aria-hidden />}
                        label="Highlight position"
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="top">
                      <HighlightAnchorOptions {...anchorControl} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {onMarkClip ? (
                  <StatusBarAction
                    hint="Mark this moment for a clip (or say “clip that”)"
                    icon={<ClipIcon aria-hidden />}
                    label="Mark clip"
                    text="Mark clip"
                    onClick={onMarkClip}
                  />
                ) : null}
                {bannerItems ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      {/* The word alone, like Clear: no icon glyph rides into this
                    window's bundle for it. */}
                      <StatusBarAction
                        hint="Show or hide your banners (or type /banner)"
                        label="Banners"
                        text="Banners"
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56" side="top">
                      {bannerItems}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {onSound ? (
                  <PopoverTrigger asChild>
                    {/* The word alone, like Banners. */}
                    <StatusBarAction
                      hint="Play a sound (or type /sound)"
                      label="Sounds"
                      text="Sounds"
                    />
                  </PopoverTrigger>
                ) : null}
                {requestClear ? (
                  <StatusBarAction
                    hint="Clear view (keeps Library history)"
                    label="Clear view"
                    text="Clear"
                    onClick={requestClear}
                  />
                ) : null}
                {onOpenPreview ? (
                  <StatusBarAction
                    icon={<PreviewIcon aria-hidden />}
                    label={`Open ${WINDOW_NAMES.preview}`}
                    onClick={onOpenPreview}
                  />
                ) : null}
              </div>
              <DropdownMenu>
                {/* The menu's trigger outside the tooltip's: the menu's open state
              is the one the button carries. */}
                <Tooltip>
                  <DropdownMenuTrigger asChild>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="More Stream Manager actions"
                        className={NARROW_ONLY}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <MoreIcon data-icon="inline-start" weight="bold" />
                      </Button>
                    </TooltipTrigger>
                  </DropdownMenuTrigger>
                  <TooltipContent side="top">More Stream Manager actions</TooltipContent>
                </Tooltip>
                <DropdownMenuContent
                  align="end"
                  className="w-56"
                  side="top"
                  onCloseAutoFocus={(event) => {
                    if (!soundsAfterMenu.current) return
                    soundsAfterMenu.current = false
                    event.preventDefault()
                    setSoundsOpen(true)
                  }}
                >
                  {hints.length > 0 ? (
                    <>
                      <DropdownMenuGroup>
                        {hints.map((hint) => (
                          <DropdownMenuItem key={hint.id} onSelect={hint.run}>
                            {hint.menuLabel}
                            <DropdownMenuShortcut>
                              <ShortcutKeys
                                accelerator={shortcutAccelerator(hint.id)}
                                variant="text"
                              />
                            </DropdownMenuShortcut>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuGroup>
                    {anchorControl ? (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <FrameIcon />
                          Highlight position
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <HighlightAnchorOptions {...anchorControl} />
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : null}
                    {onToggleAlwaysOnTop ? (
                      <DropdownMenuCheckboxItem
                        checked={alwaysOnTop}
                        onCheckedChange={() => onToggleAlwaysOnTop()}
                      >
                        {PIN_WINDOW_LABEL}
                      </DropdownMenuCheckboxItem>
                    ) : null}
                    {onMarkClip ? (
                      <DropdownMenuItem onSelect={onMarkClip}>
                        <ClipIcon />
                        Mark clip
                      </DropdownMenuItem>
                    ) : null}
                    {bannerItems ? (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Banners</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-56">
                          {bannerItems}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : null}
                    {onSound ? (
                      <DropdownMenuItem
                        onSelect={() => {
                          soundsAfterMenu.current = true
                        }}
                      >
                        Sounds…
                      </DropdownMenuItem>
                    ) : null}
                    {onOpenPreview ? (
                      <DropdownMenuItem onSelect={onOpenPreview}>
                        <PreviewIcon />
                        {`Open ${WINDOW_NAMES.preview}`}
                      </DropdownMenuItem>
                    ) : null}
                    {statsLayout && onStatsLayoutChange ? (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Show or hide stats</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {DEFAULT_STAT_ORDER.filter((id) => !LOCKED_STATS.has(id)).map((id) => (
                            <DropdownMenuCheckboxItem
                              key={id}
                              checked={!statsLayout.hidden.includes(id)}
                              onCheckedChange={(checked) =>
                                onStatsLayoutChange(
                                  setStatHidden(statsLayout, id, checked !== true)
                                )
                              }
                              onSelect={(event) => event.preventDefault()}
                            >
                              {STAT_NAMES[id]}
                            </DropdownMenuCheckboxItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={
                              statsLayout.hidden.length === 0 &&
                              statsLayout.order.every(
                                (id, index) => id === DEFAULT_STATS_LAYOUT.order[index]
                              )
                            }
                            onSelect={() => onStatsLayoutChange(DEFAULT_STATS_LAYOUT)}
                          >
                            Reset stats
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : null}
                  </DropdownMenuGroup>
                  {requestClear ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={requestClear}>
                        <span className="flex flex-col">
                          <span>Clear view</span>
                          <span className="text-[11px] text-muted-foreground">
                            Keeps Library history.
                          </span>
                        </span>
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </PopoverAnchor>
          {onSound ? (
            <PopoverContent
              align="end"
              className="w-[26rem] max-w-[calc(100vw-1rem)]"
              data-testid="stream-manager-sounds"
              side="top"
            >
              <Suspense fallback={<p className="text-xs text-muted-foreground">Loading sounds…</p>}>
                {soundsOpen ? (
                  <SoundsPopoverBody board={sounds} onSound={(action) => void onSound(action)} />
                ) : null}
              </Suspense>
            </PopoverContent>
          ) : null}
        </Popover>
      </StatusBar>
      <ConfirmDialog
        confirmLabel="Clear view"
        description="Chat and Activity in this window are emptied and the messages per minute start over. The Library keeps the history."
        open={confirmingClear}
        testId="stream-manager-clear"
        title="Clear the view?"
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          setConfirmingClear(false)
          onClear?.()
        }}
      />
    </>
  )
}
