import type { ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CommentHighlightState, LiveChatMessage } from '@/lib/backend'
import { monogramInitials, useCachedAvatar } from '@/lib/chat-avatar'
import { cn } from '@/lib/utils'

export type CommentHighlightPhase = 'idle' | 'applying' | 'live' | 'failed'

export interface CommentHighlightPresentation {
  phase: CommentHighlightPhase
  reason?: string
  commandError?: string
}

export function commentHighlightPresentationForMessage({
  messageId,
  highlightedId = null,
  state,
  applyingId = null,
  failure = null
}: {
  messageId: string
  highlightedId?: string | null
  state?: CommentHighlightState
  applyingId?: string | null
  failure?: { messageId: string; reason: string } | null
}): CommentHighlightPresentation {
  if (messageId === applyingId) return { phase: 'applying' }
  const authoritativeId = state?.messageId ?? highlightedId
  if (messageId === authoritativeId && (state?.phase === 'live' || highlightedId === messageId)) {
    return {
      phase: 'live',
      reason: state?.reason,
      commandError: messageId === failure?.messageId ? failure.reason : undefined
    }
  }
  if (messageId === failure?.messageId) return { phase: 'failed', reason: failure.reason }
  if (messageId !== authoritativeId) return { phase: 'idle' }
  return {
    phase:
      state?.phase === 'failed'
        ? 'failed'
        : state?.phase === 'live' || highlightedId === messageId
          ? 'live'
          : 'idle',
    reason: state?.reason
  }
}

export function formatCommentTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function commentCanHighlight(message: LiveChatMessage): boolean {
  return (
    !message.isDeleted &&
    message.eventType !== 'deleted' &&
    message.eventType !== 'system' &&
    message.eventType !== 'moderation' &&
    message.eventType !== 'membership'
  )
}

function HighlightStatus({
  status
}: {
  status: CommentHighlightPresentation
}): ReactElement | null {
  switch (status.phase) {
    case 'applying':
      return <Badge variant="secondary">Applying…</Badge>
    case 'live':
      return (
        <span className="flex items-center gap-1">
          <Badge variant="success">On stream</Badge>
          {status.commandError ? (
            <Badge title={status.commandError} variant="destructive">
              Action failed
            </Badge>
          ) : null}
        </span>
      )
    case 'failed':
      return (
        <Badge title={status.reason} variant="destructive">
          Failed
        </Badge>
      )
    case 'idle':
      return null
  }
}

function EventStatus({ message }: { message: LiveChatMessage }): ReactElement | null {
  if (message.amountText) {
    return <Badge variant="warning">{message.amountText}</Badge>
  }
  if (message.eventType === 'membership') {
    return <Badge variant="secondary">Member</Badge>
  }
  if (message.eventType === 'moderation') {
    return <Badge variant="secondary">Moderation</Badge>
  }
  if (message.eventType === 'system') {
    return <Badge variant="secondary">System</Badge>
  }
  return null
}

function CommentContent({
  message,
  density,
  highlight
}: {
  message: LiveChatMessage
  density: 'compact' | 'comfortable'
  highlight: CommentHighlightPresentation
}): ReactElement {
  const avatarUrl = useCachedAvatar(message.authorAvatarUrl)
  const time = formatCommentTime(message.receivedAt)

  return (
    <>
      <Avatar aria-hidden className="mt-0.5" size="sm">
        {avatarUrl ? <AvatarImage alt="" src={avatarUrl} /> : null}
        <AvatarFallback>{monogramInitials(message.authorName)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChatPlatformIcon decorative platform={message.platform} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {message.authorName}
          </span>
          <EventStatus message={message} />
          <HighlightStatus status={highlight} />
          {time ? (
            <time
              className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground"
              dateTime={message.receivedAt}
            >
              {time}
            </time>
          ) : null}
        </span>
        <span
          className={cn(
            'text-left text-foreground',
            density === 'comfortable' ? 'text-[15px] leading-snug' : 'text-xs leading-relaxed',
            message.eventType === 'system' && 'italic text-muted-foreground',
            message.eventType === 'moderation' && 'italic text-muted-foreground',
            message.isDeleted && 'text-muted-foreground line-through'
          )}
        >
          {message.messageText}
        </span>
      </span>
    </>
  )
}

export function CommentRow({
  message,
  density = 'compact',
  highlight = { phase: 'idle' },
  onHighlight
}: {
  message: LiveChatMessage
  density?: 'compact' | 'comfortable'
  highlight?: CommentHighlightPresentation
  onHighlight?: (message: LiveChatMessage) => void
}): ReactElement {
  const highlightable = Boolean(onHighlight) && commentCanHighlight(message)
  const content = <CommentContent density={density} highlight={highlight} message={message} />

  return (
    <li data-highlight-phase={highlight.phase} data-message-id={message.id}>
      {highlightable ? (
        <Button
          aria-label={
            highlight.phase === 'live'
              ? `Remove ${message.authorName}'s comment from the stream`
              : `Show ${message.authorName}'s comment on the stream`
          }
          aria-pressed={highlight.phase === 'live'}
          disabled={highlight.phase === 'applying'}
          className={cn(
            'h-auto w-full items-start justify-start gap-2 whitespace-normal px-2 py-1.5',
            message.amountText && 'bg-warning/10 ring-1 ring-warning/30'
          )}
          title={
            highlight.phase === 'live' ? 'Remove from stream' : 'Show this comment on the stream'
          }
          type="button"
          variant={highlight.phase === 'live' ? 'secondary' : 'ghost'}
          onClick={() => onHighlight?.(message)}
        >
          {content}
        </Button>
      ) : (
        <div
          className={cn(
            'flex items-start gap-2 rounded-row px-2 py-1.5',
            message.amountText && 'bg-warning/10 ring-1 ring-warning/30'
          )}
        >
          {content}
        </div>
      )}
    </li>
  )
}
