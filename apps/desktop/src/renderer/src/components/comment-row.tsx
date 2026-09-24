import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react'

import { commentCanHighlight } from '@/lib/live-chat-view'
export { commentCanHighlight } from '@/lib/live-chat-view'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { CopyIcon, PreviewIcon, SendIcon, SparkleIcon } from '@/components/icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type {
  CohostFlag,
  CommentHighlightState,
  LiveChatMessage,
  LiveChatMessageFragment
} from '@/lib/backend'
import { monogramInitials, useCachedAvatar } from '@/lib/chat-avatar'
import { cohostFlagActionLabel, cohostFlagChipLabel, cohostFlagDetail } from '@/lib/cohost-view'
import { cn } from '@/lib/utils'

export type CommentHighlightPhase = 'idle' | 'applying' | 'live' | 'failed'
export type CommentTimestamps = 'always' | 'hover'

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

/**
 * What the co-host says about this comment. A flag names its kind (plus who it
 * is aimed at, or the chat rule it broke) and, at most, LABELS a suggested
 * action — the row never moderates. "Suggested" marks a comment worth showing;
 * it sits inside the row's own show-on-stream button, so activating it is the
 * same manual highlight as any other row. Nothing goes on stream by itself.
 */
function CohostMarks({
  flag,
  suggested
}: {
  flag?: CohostFlag
  suggested: boolean
}): ReactElement | null {
  if (flag) {
    const action = cohostFlagActionLabel(flag)
    return (
      <span className="flex min-w-0 items-center gap-1" data-slot="cohost-comment-flag">
        <Badge
          className={cn('max-w-40', flag.severity !== 'high' && 'text-subtle')}
          title={cohostFlagDetail(flag)}
          variant={flag.severity === 'high' ? 'destructive' : 'outline'}
        >
          <span className="truncate">{cohostFlagChipLabel(flag)}</span>
        </Badge>
        {action ? <span className="shrink-0 text-[10px] text-subtle">{action}</span> : null}
      </span>
    )
  }
  if (!suggested) return null
  return (
    <Badge
      data-slot="cohost-comment-suggested"
      title="Orcle suggests showing this message on the stream"
      variant="outline"
    >
      <SparkleIcon aria-hidden data-icon="inline-start" weight="fill" />
      Suggested
    </Badge>
  )
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Host',
  moderator: 'Mod',
  vip: 'VIP',
  member: 'Member'
}

/** Role tags (owner, moderator, VIP, member) as glass tag chips (plan 055, D3). */
function RoleTags({ roles }: { roles: readonly string[] }): ReactElement | null {
  const labels = [...new Set(roles.map((role) => ROLE_LABELS[role]).filter(Boolean))]
  if (labels.length === 0) return null
  return (
    <>
      {labels.map((label) => (
        <Badge key={label} className="shrink-0" data-slot="comment-role" variant="outline">
          {label}
        </Badge>
      ))}
    </>
  )
}

/** An emote image through main's allowlisted avatar cache; its text until then. */
function Emote({ url, text }: { url: string; text: string }): ReactElement {
  const localUrl = useCachedAvatar(url)
  if (!localUrl) return <span>{text}</span>
  return (
    <img
      alt={text}
      className="inline-block size-5 align-text-bottom"
      data-slot="comment-emote"
      draggable={false}
      src={localUrl}
      title={text}
    />
  )
}

/** The message body: emotes inline when the platform sent them (Twitch). */
function MessageBody({
  message,
  fragments
}: {
  message: LiveChatMessage
  fragments: readonly LiveChatMessageFragment[]
}): ReactNode {
  if (!fragments.some((fragment) => fragment.imageUrl)) return message.messageText
  return fragments.map((fragment, index) =>
    fragment.imageUrl ? (
      <Emote key={index} text={fragment.text} url={fragment.imageUrl} />
    ) : (
      <span key={index}>{fragment.text}</span>
    )
  )
}

/** True when the message names one of the streamer's own accounts. */
export function commentMentions(message: LiveChatMessage, names: readonly string[]): boolean {
  if (names.length === 0 || message.eventType !== 'message') return false
  const text = message.messageText.toLowerCase()
  return names.some((name) => {
    const handle = name.trim().toLowerCase().replace(/^@/, '')
    return handle.length > 1 && text.includes(`@${handle}`)
  })
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
  highlight,
  flag,
  suggested,
  mentioned,
  timestamps
}: {
  message: LiveChatMessage
  density: 'compact' | 'comfortable'
  highlight: CommentHighlightPresentation
  flag?: CohostFlag
  suggested: boolean
  mentioned: boolean
  timestamps: CommentTimestamps
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
          {/* text-left: a highlightable row is a Button, whose centred text
              would otherwise float the name mid-row, away from the avatar. */}
          <span className="min-w-0 truncate text-left font-medium text-foreground">
            {message.authorName}
          </span>
          <RoleTags roles={message.authorRoles} />
          {message.firstMessage ? (
            <Badge className="shrink-0" data-slot="comment-first-message" variant="outline">
              <SparkleIcon aria-hidden data-icon="inline-start" weight="fill" />
              First chat
            </Badge>
          ) : null}
          {mentioned ? (
            <Badge
              className="shrink-0"
              data-slot="comment-mention"
              title="Mentions you"
              variant="secondary"
            >
              @you
            </Badge>
          ) : null}
          <span className="flex-1" />
          <EventStatus message={message} />
          <CohostMarks flag={flag} suggested={suggested} />
          <HighlightStatus status={highlight} />
          {time ? (
            // While live the time waits for the pointer, like the row's ⋯:
            // a clock on every row is noise mid-stream (plan 057, D3).
            <time
              className={cn(
                'ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground',
                timestamps === 'hover' &&
                  'opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100'
              )}
              dateTime={message.receivedAt}
            >
              {time}
            </time>
          ) : null}
        </span>
        {message.reply ? (
          <span
            className="truncate text-left text-xs text-muted-foreground"
            data-slot="comment-reply"
            title={`${message.reply.parentAuthorName}: ${message.reply.parentText}`}
          >
            ↳ @{message.reply.parentAuthorName}: {message.reply.parentText}
          </span>
        ) : null}
        <span
          className={cn(
            'text-left break-words text-foreground select-text',
            density === 'comfortable' ? 'text-[15px] leading-snug' : 'text-xs leading-relaxed',
            message.eventType === 'system' && 'italic text-muted-foreground',
            message.eventType === 'moderation' && 'italic text-muted-foreground',
            message.isDeleted && 'text-muted-foreground line-through'
          )}
        >
          <MessageBody fragments={message.fragments} message={message} />
        </span>
      </span>
    </>
  )
}

export function CommentRow({
  message,
  density = 'compact',
  timestamps = 'always',
  highlight = { phase: 'idle' },
  cohostFlag,
  cohostSuggested = false,
  mentionNames = [],
  onHighlight,
  onReply,
  ref,
  style,
  index
}: {
  message: LiveChatMessage
  density?: 'compact' | 'comfortable'
  /** 'hover' keeps the time out of sight until the pointer is on the row. */
  timestamps?: CommentTimestamps
  highlight?: CommentHighlightPresentation
  /** The co-host's flag for this message, already filtered by Sensitivity. */
  cohostFlag?: CohostFlag
  /** The co-host suggests showing this comment (`cohost.state.highlights`). */
  cohostSuggested?: boolean
  /** The streamer's own account names: a message naming one is a mention. */
  mentionNames?: readonly string[]
  onHighlight?: (message: LiveChatMessage) => void
  /** The Stream Manager's ⋯ Reply: prefills the composer with @name. */
  onReply?: (message: LiveChatMessage) => void
  /** Virtualized lists measure and place the row (plan 055, S10). */
  ref?: Ref<HTMLLIElement>
  style?: CSSProperties
  index?: number
}): ReactElement {
  const highlightable = Boolean(onHighlight) && commentCanHighlight(message)
  // A suggestion is only offered where tapping the row can act on it, and
  // never once the comment is already on (or on its way to) the stream.
  const suggested = cohostSuggested && highlightable && highlight.phase === 'idle'
  const mentioned = commentMentions(message, mentionNames)
  const content = (
    <CommentContent
      density={density}
      flag={cohostFlag}
      highlight={highlight}
      mentioned={mentioned}
      message={message}
      suggested={suggested}
      timestamps={timestamps}
    />
  )
  const menu: KebabMenuItem[] = onReply
    ? [
        ...(highlightable
          ? [
              {
                id: 'show',
                label: highlight.phase === 'live' ? 'Remove from stream' : 'Show on stream',
                icon: PreviewIcon,
                onSelect: () => onHighlight?.(message)
              }
            ]
          : []),
        ...(message.eventType === 'message' || message.eventType === 'paid'
          ? [{ id: 'reply', label: 'Reply', icon: SendIcon, onSelect: () => onReply(message) }]
          : []),
        {
          id: 'copy',
          label: 'Copy',
          icon: CopyIcon,
          onSelect: () =>
            void navigator.clipboard?.writeText(`${message.authorName}: ${message.messageText}`)
        }
      ]
    : []

  return (
    <li
      ref={ref}
      className={cn('group/comment', menu.length > 0 && 'flex items-start gap-0.5')}
      data-highlight-phase={highlight.phase}
      data-index={index}
      data-mention={mentioned || undefined}
      data-message-id={message.id}
      style={style}
    >
      {highlightable ? (
        <Button
          aria-label={
            highlight.phase === 'live'
              ? `Remove ${message.authorName}'s message from the stream`
              : suggested
                ? `Show ${message.authorName}'s message on the stream (Orcle suggestion)`
                : `Show ${message.authorName}'s message on the stream`
          }
          aria-pressed={highlight.phase === 'live'}
          disabled={highlight.phase === 'applying'}
          className={cn(
            'h-auto w-full min-w-0 flex-1 items-start justify-start gap-2 whitespace-normal px-2 py-1.5',
            message.amountText && 'bg-warning/10 ring-1 ring-warning/30'
          )}
          title={
            highlight.phase === 'live' ? 'Remove from stream' : 'Show this message on the stream'
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
            'flex min-w-0 flex-1 items-start gap-2 rounded-row px-2 py-1.5',
            message.amountText && 'bg-warning/10 ring-1 ring-warning/30'
          )}
        >
          {content}
        </div>
      )}
      {menu.length > 0 ? (
        <KebabMenu
          className="mt-1 shrink-0 opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          items={menu}
          label={`Actions for ${message.authorName}'s message`}
        />
      ) : null}
    </li>
  )
}
