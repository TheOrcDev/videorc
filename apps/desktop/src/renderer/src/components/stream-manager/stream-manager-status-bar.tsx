import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { HIGHLIGHT_ANCHOR_LABELS, HighlightAnchorOptions } from '@/components/comments-header'
import { providerBadgeTitle } from '@/components/comments-destination-status'
import { FrameIcon, MoreIcon, PinIcon, PreviewIcon } from '@/components/icons'
import { StatusBar } from '@/components/status-bar'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { AudienceSnapshot, CommentHighlightAnchor, LiveChatProviderState } from '@/lib/backend'
import { ABOVE_NARROW, COMPACT_LABEL, NARROW_ONLY } from '@/lib/stream-manager-layout'
import { cn } from '@/lib/utils'

// The Stream Manager's status bar (plan 055, D6): each provider's chat state
// on the left, the window's quiet controls on the right. The title row keeps
// the title only (owner call, 2026-09-23: no buttons in the top-right corner).
// Below 640 px the controls fold into one ⋯ menu so none is ever clipped.
// Quiet when fine (plan 057, D3): a platform that reads and sends is its icon
// and a green dot, and the controls are icons with their names on hover.

const ACTION_CLASS =
  'flex h-5 shrink-0 items-center gap-1 rounded-chip px-1.5 text-[11px] text-subtle transition-colors duration-100 hover:bg-accent hover:text-foreground aria-pressed:text-foreground [&_svg]:size-3.5'

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
 * so a healthy platform is just its icon and dot.
 */
export function providerCapabilityLabel(provider: LiveChatProviderState): string {
  if (provider.state === 'failed') return 'failed'
  if (provider.state === 'ended') return 'ended'
  if (provider.read === 'unavailable' || provider.state === 'unsupported') return 'off'
  if (
    provider.state === 'connecting' ||
    provider.state === 'reconnecting' ||
    provider.state === 'waiting'
  ) {
    return provider.state
  }
  if (provider.write === 'ready') return ''
  if (provider.write === 'missing-scope') return 'reconnect to send'
  return 'read-only'
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
      'Follow alerts and the sub count need one more Twitch permission: Reconnect Twitch in Livestream → Setup.'
    )
  }
  return lines.filter(Boolean).join('\n')
}

export function StreamManagerStatusBar({
  providers,
  audience,
  alwaysOnTop,
  highlightAnchor,
  onToggleAlwaysOnTop,
  onHighlightAnchorChange,
  onClear,
  onOpenPreview
}: {
  providers: readonly LiveChatProviderState[]
  audience: AudienceSnapshot | null
  alwaysOnTop: boolean
  highlightAnchor?: CommentHighlightAnchor
  onToggleAlwaysOnTop?: () => void
  onHighlightAnchorChange?: (anchor: CommentHighlightAnchor) => void
  onClear?: () => void
  onOpenPreview?: () => void
}): ReactElement {
  const anchorControl =
    highlightAnchor && onHighlightAnchorChange
      ? { anchor: highlightAnchor, onChange: onHighlightAnchorChange }
      : null
  return (
    <StatusBar
      className="gap-2"
      leading={
        <span className="flex min-w-0 items-center gap-3 overflow-hidden" data-slot="chat-states">
          {providers.map((provider) => {
            const label = providerCapabilityLabel(provider)
            const title = providerCapabilityTitle(provider, audience)
            return (
              <span
                key={provider.id}
                aria-label={title.split('\n')[0]}
                className="flex min-w-0 shrink items-center gap-1.5"
                data-slot="chat-state"
                role="img"
                title={title}
              >
                <ChatPlatformIcon decorative platform={provider.platform} />
                <StatusDot tone={providerTone(provider)} />
                {label ? (
                  <span className={cn('truncate', ABOVE_NARROW, COMPACT_LABEL)}>
                    {CHAT_PLATFORM_LABELS[provider.platform]} {label}
                  </span>
                ) : null}
              </span>
            )
          })}
        </span>
      }
    >
      <div
        className={cn('items-center gap-0.5 [-webkit-app-region:no-drag]', 'flex', ABOVE_NARROW)}
        data-slot="stream-manager-actions"
      >
        {onToggleAlwaysOnTop ? (
          <button
            aria-label="Keep this window on top"
            aria-pressed={alwaysOnTop}
            className={ACTION_CLASS}
            title="Keep on top"
            type="button"
            onClick={onToggleAlwaysOnTop}
          >
            <PinIcon aria-hidden weight={alwaysOnTop ? 'fill' : 'regular'} />
          </button>
        ) : null}
        {anchorControl ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Highlight position"
                className={ACTION_CLASS}
                title={`Highlight position: ${HIGHLIGHT_ANCHOR_LABELS[anchorControl.anchor]}`}
                type="button"
              >
                <FrameIcon aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <HighlightAnchorOptions {...anchorControl} />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {onClear ? (
          <button
            aria-label="Clear view"
            className={ACTION_CLASS}
            title="Clear view (keeps Library history)"
            type="button"
            onClick={onClear}
          >
            Clear
          </button>
        ) : null}
        {onOpenPreview ? (
          <button
            aria-label="Open Preview"
            className={ACTION_CLASS}
            title="Open Preview"
            type="button"
            onClick={onOpenPreview}
          >
            <PreviewIcon aria-hidden />
          </button>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More Stream Manager actions"
            className={cn('size-6', NARROW_ONLY)}
            size="icon-xs"
            title="More Stream Manager actions"
            type="button"
            variant="ghost"
          >
            <MoreIcon data-icon="inline-start" weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56" side="top">
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
                Keep on top
              </DropdownMenuCheckboxItem>
            ) : null}
            {onOpenPreview ? (
              <DropdownMenuItem onSelect={onOpenPreview}>
                <PreviewIcon />
                Open Preview
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
          {onClear ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onClear}>
                <span className="flex flex-col">
                  <span>Clear view</span>
                  <span className="text-[11px] text-muted-foreground">Keeps Library history.</span>
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </StatusBar>
  )
}
