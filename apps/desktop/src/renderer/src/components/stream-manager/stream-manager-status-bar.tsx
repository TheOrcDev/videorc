import { useState, type ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { HIGHLIGHT_ANCHOR_LABELS, HighlightAnchorOptions } from '@/components/comments-header'
import { providerBadgeTitle } from '@/components/comments-destination-status'
import { ClipIcon, FrameIcon, MoreIcon, PreviewIcon } from '@/components/icons'
import { PIN_WINDOW_LABEL, PinWindowButton } from '@/components/pin-window-button'
import { StatusBar, StatusBarAction } from '@/components/status-bar'
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
import { chatStateLabel } from '@/lib/state-labels'
import { waitingProviderMessage } from '@/lib/youtube-quota-copy'
import { cn } from '@/lib/utils'

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
      'Follow alerts and the sub count need one more Twitch permission: Reconnect Twitch in Livestream → Setup.'
    )
  }
  if (provider.platform === 'twitch' && entry?.bitsPointsScopes === false) {
    lines.push(
      'Power-ups and channel points need one more Twitch permission: Reconnect Twitch in Livestream → Setup.'
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
  onMarkClip,
  onOpenPreview
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
  onOpenPreview?: () => void
}): ReactElement {
  const anchorControl =
    highlightAnchor && onHighlightAnchorChange
      ? { anchor: highlightAnchor, onChange: onHighlightAnchorChange }
      : null
  // Plan 174 S0.3 (H-6): Clear empties chat and Activity for this window and
  // cannot be undone, so both its homes (the button, the ⋯ menu) ask first.
  const [confirmingClear, setConfirmingClear] = useState(false)
  const requestClear = onClear ? () => setConfirmingClear(true) : undefined
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
              label="Open Preview"
              onClick={onOpenPreview}
            />
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
                  {PIN_WINDOW_LABEL}
                </DropdownMenuCheckboxItem>
              ) : null}
              {onMarkClip ? (
                <DropdownMenuItem onSelect={onMarkClip}>
                  <ClipIcon />
                  Mark clip
                </DropdownMenuItem>
              ) : null}
              {onOpenPreview ? (
                <DropdownMenuItem onSelect={onOpenPreview}>
                  <PreviewIcon />
                  Open Preview
                </DropdownMenuItem>
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
