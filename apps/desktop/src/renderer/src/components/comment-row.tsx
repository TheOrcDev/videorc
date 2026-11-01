import {
  Fragment,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'

import { gifTitle } from '../../../shared/chat-gif'

import {
  CHAT_PLATFORM_LABELS,
  commentCanHighlight,
  commentRowTint,
  type CommentRowTint
} from '@/lib/live-chat-view'
export { commentCanHighlight } from '@/lib/live-chat-view'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import {
  CopyIcon,
  DeleteIcon,
  ExternalLinkIcon,
  LivestreamIcon,
  MicrophoneIcon,
  SendIcon,
  SparkleIcon
} from '@/components/icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { CHROME_ROW_CLASS } from '@/components/ui/chrome-row'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  CohostFlag,
  CommentHighlightState,
  LiveChatAuthorAffiliation,
  LiveChatAuthorVerified,
  LiveChatMessage,
  LiveChatMessageFragment
} from '@/lib/backend'
import { monogramInitials, useCachedAvatar } from '@/lib/chat-avatar'
import { clickSelectsText } from '@/lib/chat-list-keys'
import { REMOVE_FROM_CHAT_LABEL, type RemovalStatusView } from '@/lib/chat-removal-view'
import { groupEmoteOverlays } from '@/lib/chat-emotes'
import { isGifFragment, splitGifFragments, useChatGifMode } from '@/lib/chat-gifs'
import { copyChatLink, copyChatText, openChatLink } from '@/lib/chat-link-actions'
import { chatLinksIn, splitLinks, type ChatLinkPiece } from '@/lib/chat-links'
import { noticeViewerWords } from '@/lib/chat-notice'
import { cohostFlagActionLabel, cohostFlagChipLabel, cohostFlagDetail } from '@/lib/cohost-view'
import { cn } from '@/lib/utils'
import { X_VERIFIED_LABEL, X_VERIFIED_URL } from '@/lib/x-mark'

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

/**
 * A chip's explanation, on hover (plan 174 S1.10): never a native `title`.
 * The chip stays plain text inside its row; the words it stands for are the
 * tooltip.
 */
function ChipHint({ hint, children }: { hint: string; children: ReactElement }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Why a highlight did not land, in words (plan 174 S1.10, H-16): a failed
 * show's reason, or the failed action on a message already on stream. It is
 * the row's visible secondary line while the badge says Failed, never hover
 * text. Null when nothing failed or no reason came back.
 */
export function highlightProblem(status: CommentHighlightPresentation): string | null {
  if (status.phase === 'failed') return status.reason?.trim() || null
  if (status.phase === 'live') return status.commandError?.trim() || null
  return null
}

/**
 * What a removal did when it did not simply remove (plan 174 S1.10, H-16):
 * hidden only in Videorc, not removed, or unconfirmed, as the row's visible
 * secondary line. A plain removal says "Removed" and keeps its outcome on
 * the chip's hover.
 */
export function removalOutcomeLine(status: RemovalStatusView | null | undefined): string | null {
  if (!status || status.kind === 'removing' || status.kind === 'removed') return null
  return status.detail?.trim() || null
}

/** A row's outcome lines under its text: a failed highlight, then a removal. */
function RowOutcomes({
  highlight,
  removal
}: {
  highlight: CommentHighlightPresentation
  removal?: RemovalStatusView | null
}): ReactElement | null {
  const problem = highlightProblem(highlight)
  const removed = removalOutcomeLine(removal)
  if (!problem && !removed) return null
  return (
    <>
      {problem ? (
        <span
          className="text-left text-xs text-muted-foreground"
          data-slot="highlight-problem"
          data-testid="highlight-failed-reason"
        >
          {problem}
        </span>
      ) : null}
      {removed ? (
        <span
          className="text-left text-xs text-muted-foreground"
          data-slot="removal-outcome"
          data-testid="removal-outcome"
        >
          {removed}
        </span>
      ) : null}
    </>
  )
}

/** The on-stream badge, shared by chat and Activity rows (plan 095, S2). The
 * reason for a failure is the row's own line (`highlightProblem`). */
export function HighlightStatus({
  status
}: {
  status: CommentHighlightPresentation
}): ReactElement | null {
  switch (status.phase) {
    case 'applying':
      return <Badge>Applying…</Badge>
    case 'live':
      return (
        <span className="flex items-center gap-1">
          <Badge variant="chrome">On stream</Badge>
          {status.commandError ? <Badge variant="destructive">Action failed</Badge> : null}
        </span>
      )
    case 'failed':
      return (
        <Badge data-testid="highlight-failed" variant="destructive">
          Failed
        </Badge>
      )
    case 'idle':
      return null
  }
}

/**
 * A removal's state on its row (plan 140, S6): "Removing…" while it runs,
 * then "Removed" or "Hidden in Videorc", or a quiet "Not removed" /
 * "Unconfirmed". Anything but a plain removal says what happened on the row's
 * own line (`removalOutcomeLine`); "Removed" keeps its outcome on hover.
 * Outside the struck-through text, so it stays readable.
 */
export function RemovalStatus({
  status
}: {
  status: RemovalStatusView | null | undefined
}): ReactElement | null {
  if (!status) return null
  if (status.kind === 'removing') {
    return (
      <Badge data-removal={status.kind} data-testid="removal-status">
        <Spinner aria-hidden data-icon="inline-start" weight="bold" />
        {status.label}
      </Badge>
    )
  }
  const chip = (
    <Badge
      className="shrink-0"
      data-removal={status.kind}
      data-testid="removal-status"
      variant="outline"
    >
      {status.label}
    </Badge>
  )
  return status.kind === 'removed' && status.detail ? (
    <ChipHint hint={status.detail}>{chip}</ChipHint>
  ) : (
    chip
  )
}

/**
 * What Buddy says about this comment. A flag names its kind (plus who it is
 * aimed at, or the chat rule it broke) and, at most, LABELS a suggested
 * action: the flag itself never moderates; only the streamer's "Remove from
 * chat" does. "Suggested" marks a comment worth showing; it sits inside the
 * row's own show-on-stream button, so activating it is the same manual
 * highlight as any other row. Nothing goes on stream by itself.
 */
function CohostMarks({
  flag,
  suggested,
  spotlight
}: {
  flag?: CohostFlag
  suggested: boolean
  spotlight: boolean
}): ReactElement | null {
  if (flag) {
    const action = cohostFlagActionLabel(flag)
    return (
      <span className="flex min-w-0 items-center gap-1" data-slot="cohost-comment-flag">
        <ChipHint hint={cohostFlagDetail(flag)}>
          <Badge
            className="max-w-40"
            variant={flag.severity === 'high' ? 'destructive' : 'outline'}
          >
            <span className="truncate">{cohostFlagChipLabel(flag)}</span>
          </Badge>
        </ChipHint>
        {action ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{action}</span>
        ) : null}
      </span>
    )
  }
  if (spotlight) {
    // Pull-up (plan 060): private to the streamer, never on stream by itself.
    return (
      <ChipHint hint="Buddy heard you talking about this message">
        <Badge data-testid="cohost-comment-spotlight" variant="outline">
          <MicrophoneIcon aria-hidden data-icon="inline-start" weight="fill" />
          Talking about this
        </Badge>
      </ChipHint>
    )
  }
  if (!suggested) return null
  return (
    <ChipHint hint="Buddy suggests showing this message on the stream">
      <Badge data-testid="cohost-comment-suggested" variant="outline">
        <SparkleIcon aria-hidden data-icon="inline-start" weight="fill" />
        Suggested
      </Badge>
    </ChipHint>
  )
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Host',
  moderator: 'Mod',
  vip: 'VIP',
  member: 'Member'
}

/**
 * Row backgrounds (plan 154, D2, D3): one tint per row, never two. A paid
 * row is a fill and a hairline ring; a member's row is one notch quieter,
 * a chrome plate with the member hue as its edge (plan 0011), so a member's
 * Super Chat still reads louder.
 */
export const COMMENT_ROW_TINT_CLASS: Record<Exclude<CommentRowTint, null>, string> = {
  paid: 'bg-warning/10 ring-1 ring-warning/30',
  spotlight: 'bg-accent',
  member: CHROME_ROW_CLASS.member
}

/** A row's one background: the chrome plate while on stream (plan 0011),
 * which no tint shares, else its tint. */
export function commentRowClass(tint: CommentRowTint, onStream: boolean): string | null {
  if (onStream) return CHROME_ROW_CLASS.live
  return tint ? COMMENT_ROW_TINT_CLASS[tint] : null
}

/** Role tags (owner, moderator, VIP, member) as glass tag chips (plan 055, D3);
 * Member is a chrome plate (plan 0011). */
function RoleTags({ roles }: { roles: readonly string[] }): ReactElement | null {
  const labels = [...new Set(roles.map((role) => ROLE_LABELS[role]).filter(Boolean))]
  if (labels.length === 0) return null
  return (
    <>
      {labels.map((label) => (
        <Badge
          key={label}
          className="shrink-0"
          data-testid="comment-role"
          variant={label === ROLE_LABELS.member ? 'plate' : 'outline'}
        >
          {label}
        </Badge>
      ))}
    </>
  )
}

/**
 * The author's organization badge (X affiliation, plan 086): the company logo
 * X shows beside an affiliated name. Nothing until main's cache resolves it.
 */
function AffiliationBadge({
  affiliation
}: {
  affiliation: LiveChatAuthorAffiliation
}): ReactElement | null {
  const localUrl = useCachedAvatar(affiliation.badgeUrl)
  if (!localUrl) return null
  const label = affiliation.description ?? 'Affiliated organization'
  return (
    <ChipHint hint={label}>
      <img
        alt={label}
        className="size-4 shrink-0 rounded-chip object-cover"
        data-slot="comment-affiliation"
        draggable={false}
        src={localUrl}
      />
    </ChipHint>
  )
}

/**
 * The author's verified check (plan 167): X's own Premium, Verified
 * Organization or government check, as X's file, never tinted. It sits right
 * after the name, before the organization logo, in X's order.
 */
function VerifiedCheck({ verified }: { verified: LiveChatAuthorVerified }): ReactElement {
  const label = X_VERIFIED_LABEL[verified]
  return (
    <ChipHint hint={label}>
      <img
        alt={label}
        className="size-4 shrink-0"
        data-slot="comment-verified"
        data-verified={verified}
        draggable={false}
        src={X_VERIFIED_URL[verified]}
      />
    </ChipHint>
  )
}

/**
 * An emote image through main's allowlisted avatar cache; its text until then.
 * Text height, natural width: 7TV has many wide emotes (plan 089). A stacked
 * zero-width overlay shows nothing until its image is cached.
 */
function Emote({
  url,
  text,
  stacked = 'no'
}: {
  url: string
  text: string
  stacked?: 'no' | 'base' | 'overlay'
}): ReactElement | null {
  const localUrl = useCachedAvatar(url)
  if (!localUrl) {
    if (stacked === 'overlay') return null
    return <span className={cn(stacked === 'base' && 'col-start-1 row-start-1')}>{text}</span>
  }
  return (
    <img
      alt={text}
      className={cn(
        'inline-block h-5 w-auto max-w-24 object-contain align-text-bottom',
        stacked !== 'no' && 'col-start-1 row-start-1'
      )}
      data-slot="comment-emote"
      draggable={false}
      src={localUrl}
      title={stacked === 'no' ? text : undefined}
    />
  )
}

/**
 * A Twitch GIF Keyboard GIF (plan 155, D5): its own block under the text,
 * at a fixed height so the virtualized list never re-measures when the image
 * lands. Until main's cache resolves it (and whenever it refuses it) the
 * block shows the GIF's title with a "GIF" tag; the row never changes
 * height. Still draws the first frame only; Off never asks for the image.
 */
function ChatGif({
  fragment,
  density
}: {
  fragment: LiveChatMessageFragment
  density: 'compact' | 'comfortable'
}): ReactElement {
  const mode = useChatGifMode()
  const title = gifTitle(fragment.text)
  const localUrl = useCachedAvatar(mode === 'off' ? null : fragment.imageUrl, 'gif')
  const height = density === 'comfortable' ? 'h-24' : 'h-16'
  const image =
    localUrl && mode === 'animated' ? (
      <img
        alt={title}
        className="h-full w-auto max-w-full rounded-chip object-contain"
        data-slot="comment-gif-image"
        draggable={false}
        src={localUrl}
      />
    ) : localUrl && mode === 'still' ? (
      <StillFrame alt={title} src={localUrl} />
    ) : null
  return (
    <span
      className={cn('mt-1 flex items-center gap-1.5 text-left', height)}
      data-gif-mode={mode}
      data-slot="comment-gif"
      title={title}
    >
      {image ?? (
        <span
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          data-slot="comment-gif-title"
        >
          <Badge className="shrink-0" variant="outline">
            GIF
          </Badge>
          <span className="truncate">{title}</span>
        </span>
      )}
    </span>
  )
}

/** One frame of an animated image: drawn to a canvas as soon as it loads,
 * so the file's later frames never play (Still, or reduced motion). */
function StillFrame({ alt, src }: { alt: string; src: string }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (cancelled) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      canvas.getContext('2d')?.drawImage(image, 0, 0)
    }
    image.src = src
    return () => {
      cancelled = true
      image.onload = null
    }
  }, [src])
  return (
    <canvas
      aria-label={alt}
      className="h-full w-auto max-w-full rounded-chip object-contain"
      data-slot="comment-gif-still"
      ref={canvasRef}
      role="img"
    />
  )
}

/** Text with emotes inline when the platform sent them (Twitch, Kick) or
 * the backend matched them (7TV), zero-width 7TV emotes stacked on the emote
 * before them. A Twitch GIF (plan 155) is its own block after the text it
 * came with. Without an emote or GIF it is `text` as is. */
function FragmentText({
  text,
  fragments,
  links,
  density = 'compact'
}: {
  text: string
  fragments: readonly LiveChatMessageFragment[]
  /** Viewer-written text: its links get Open link and Copy link. */
  links: boolean
  density?: 'compact' | 'comfortable'
}): ReactNode {
  if (!fragments.some((fragment) => fragment.imageUrl)) {
    return links ? <LinkedText text={text} /> : text
  }
  if (fragments.some(isGifFragment)) {
    return splitGifFragments(fragments).map((part, index) =>
      part.kind === 'gif' ? (
        <ChatGif density={density} fragment={part.fragment} key={index} />
      ) : (
        <Fragment key={index}>
          <EmoteText fragments={part.fragments} links={links} />
        </Fragment>
      )
    )
  }
  return <EmoteText fragments={fragments} links={links} />
}

/** A run of text and emotes, zero-width 7TV emotes stacked. */
function EmoteText({
  fragments,
  links
}: {
  fragments: readonly LiveChatMessageFragment[]
  links: boolean
}): ReactNode {
  return groupEmoteOverlays(fragments).map((piece, index) => {
    if (piece.kind === 'text') {
      return <span key={index}>{links ? <LinkedText text={piece.text} /> : piece.text}</span>
    }
    if (piece.overlays.length === 0) {
      return <Emote key={index} text={piece.emote.text} url={piece.emote.url} />
    }
    return (
      <span
        className="inline-grid place-items-center align-text-bottom"
        data-slot="comment-emote-stack"
        key={index}
        title={[piece.emote, ...piece.overlays].map((emote) => emote.text).join(' ')}
      >
        <Emote stacked="base" text={piece.emote.text} url={piece.emote.url} />
        {piece.overlays.map((overlay, layer) => (
          <Emote key={layer} stacked="overlay" text={overlay.text} url={overlay.url} />
        ))}
      </span>
    )
  })
}

/**
 * A link in a viewer's message (plan 151, D9–D11): underlined, never blue,
 * and inert to a left click, which still belongs to the row (Show on
 * stream). A right click offers Open link and Copy link under its host.
 * A span, not an anchor: the row is a button, and nothing here navigates.
 */
function ChatLink({ link }: { link: ChatLinkPiece }): ReactElement {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <span
            className="underline decoration-muted-foreground/50 underline-offset-2"
            data-slot="comment-link"
            title={link.href}
          />
        }
      >
        {link.text}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56" data-testid="comment-link-menu">
        <ContextMenuLabel className="truncate font-normal text-subtle">
          {link.host}
        </ContextMenuLabel>
        <ContextMenuItem onClick={() => void openChatLink(link.href)}>
          <ExternalLinkIcon aria-hidden />
          Open link
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyChatLink(link.href)}>
          <CopyIcon aria-hidden />
          Copy link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function LinkedText({ text }: { text: string }): ReactNode {
  const pieces = splitLinks(text)
  if (!pieces.some((piece) => piece.kind === 'link')) return text
  return pieces.map((piece, index) =>
    piece.kind === 'link' ? (
      <ChatLink key={index} link={piece} />
    ) : (
      <Fragment key={index}>{piece.text}</Fragment>
    )
  )
}

/** Whether a row's text is the viewer's own: only that gets links. Twitch's
 * sentences, moderation rows and removed messages never do (plan 151, D8). */
function viewerWrote(message: LiveChatMessage): boolean {
  return !message.isDeleted && (message.eventType === 'message' || message.eventType === 'paid')
}

/** The viewer-written text of a row whose links Open and Copy can reach. */
export function commentLinkText(message: LiveChatMessage): string | undefined {
  if (message.isDeleted) return undefined
  const noticeWords = noticeViewerWords(message)
  if (noticeWords) return noticeWords
  return viewerWrote(message) ? message.messageText : undefined
}

/** The message body. A Twitch notice the viewer wrote something with shows
 * Twitch's sentence, then the viewer's own words below it (plan 151, D3). */
function MessageBody({
  message,
  noticeWords,
  density
}: {
  message: LiveChatMessage
  noticeWords: string | undefined
  density: 'compact' | 'comfortable'
}): ReactNode {
  if (!noticeWords) {
    return (
      <FragmentText
        density={density}
        fragments={message.fragments}
        links={viewerWrote(message)}
        text={message.messageText}
      />
    )
  }
  return (
    <>
      <span className="block italic text-muted-foreground" data-slot="comment-notice">
        {message.messageText}
      </span>
      <span className="block" data-slot="comment-notice-words">
        <FragmentText fragments={message.fragments} links={!message.isDeleted} text={noticeWords} />
      </span>
    </>
  )
}

/**
 * A message's words as a chat row shows them: emotes, GIFs and inert links,
 * and a notice's sentence over the viewer's own words. For rows outside
 * `CommentRow`, like the Studio's Chat section (plan 204).
 */
export function CommentMessageBody({
  message,
  density
}: {
  message: LiveChatMessage
  density: 'compact' | 'comfortable'
}): ReactNode {
  return (
    <MessageBody density={density} message={message} noticeWords={noticeViewerWords(message)} />
  )
}

/** True when the message names one of the streamer's own accounts. */
export function commentMentions(
  message: Pick<LiveChatMessage, 'eventType' | 'messageText'>,
  names: readonly string[]
): boolean {
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
    return <Badge variant="plate">Member</Badge>
  }
  if (message.eventType === 'moderation') {
    return <Badge>Moderation</Badge>
  }
  if (message.eventType === 'system') {
    return <Badge>System</Badge>
  }
  return null
}

/** The parts a highlightable row's button is named by: who, where, what. */
type CommentNameIds = { author: string; platform: string; text: string }

function CommentContent({
  message,
  density,
  highlight,
  removal,
  flag,
  suggested,
  spotlight,
  mentioned,
  timestamps,
  nameIds
}: {
  message: LiveChatMessage
  density: 'compact' | 'comfortable'
  highlight: CommentHighlightPresentation
  removal?: RemovalStatusView | null
  flag?: CohostFlag
  suggested: boolean
  spotlight: boolean
  mentioned: boolean
  timestamps: CommentTimestamps
  nameIds?: CommentNameIds
}): ReactElement {
  const avatarUrl = useCachedAvatar(message.authorAvatarUrl)
  const time = formatCommentTime(message.receivedAt)
  const noticeWords = noticeViewerWords(message)

  return (
    <>
      {/* Sized with the 20 px platform marks (plan 165): 32 px in the compact
          rail, 40 px (both lines) in the Stream Manager. */}
      <Avatar aria-hidden className="mt-0.5" size={density === 'comfortable' ? 'lg' : 'default'}>
        {avatarUrl ? <AvatarImage alt="" src={avatarUrl} /> : null}
        <AvatarFallback>{monogramInitials(message.authorName)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {/* text-left: a highlightable row is a Button, whose centred text
              would otherwise float the name mid-row, away from the avatar. */}
          <span
            className="min-w-0 truncate text-left font-medium text-foreground"
            id={nameIds?.author}
          >
            {message.authorName}
          </span>
          {message.authorVerified ? <VerifiedCheck verified={message.authorVerified} /> : null}
          {message.authorAffiliation ? (
            <AffiliationBadge affiliation={message.authorAffiliation} />
          ) : null}
          <RoleTags roles={message.authorRoles} />
          {message.firstMessage ? (
            <Badge className="shrink-0" data-testid="comment-first-message" variant="outline">
              <SparkleIcon aria-hidden data-icon="inline-start" weight="fill" />
              First chat
            </Badge>
          ) : null}
          {mentioned ? (
            <ChipHint hint="Mentions you">
              <Badge className="shrink-0" data-testid="comment-mention">
                @you
              </Badge>
            </ChipHint>
          ) : null}
          <span className="flex-1" />
          <EventStatus message={message} />
          <CohostMarks flag={flag} spotlight={spotlight} suggested={suggested} />
          <HighlightStatus status={highlight} />
          <RemovalStatus status={removal} />
          {time ? (
            // While live the time waits for the pointer, like the row's ⋯:
            // a clock on every row is noise mid-stream (plan 057, D3).
            <time
              className={cn(
                'ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground',
                timestamps === 'hover' &&
                  'opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100'
              )}
              dateTime={message.receivedAt}
            >
              {time}
            </time>
          ) : null}
          {/* The platform mark closes the row on the far right (owner call,
              plan 165): 20 px, YouTube's official icon, clear of the name. */}
          <ChatPlatformIcon className="ml-1 mr-0" decorative platform={message.platform} />
          {nameIds ? (
            // The mark's words, for the row button's name only ("Ada on
            // YouTube: Ship it!"): a hidden node still counts when
            // aria-labelledby points at it.
            <span hidden id={nameIds.platform}>
              {`on ${CHAT_PLATFORM_LABELS[message.platform]}:`}
            </span>
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
            message.eventType === 'system' && !noticeWords && 'italic text-muted-foreground',
            message.eventType === 'moderation' && 'italic text-muted-foreground',
            message.isDeleted && 'text-muted-foreground line-through'
          )}
          id={nameIds?.text}
        >
          <MessageBody density={density} message={message} noticeWords={noticeWords} />
        </span>
        <RowOutcomes highlight={highlight} removal={removal} />
      </span>
    </>
  )
}

/**
 * What a highlightable row's button does, then any outcome its own lines
 * show (plan 174 S1.10): the visible lines sit inside the button, whose name
 * is only who said what, so a screen reader hears them here.
 */
export function commentRowDescription(
  highlight: CommentHighlightPresentation,
  removal: RemovalStatusView | null | undefined,
  suggested: boolean
): string {
  const action =
    highlight.phase === 'live'
      ? 'Takes it off the stream'
      : suggested
        ? 'Shows it on stream. Buddy suggests it'
        : 'Shows it on stream'
  const outcomes = [highlightProblem(highlight), removalOutcomeLine(removal)].filter(Boolean)
  return outcomes.length > 0 ? `${action}. ${outcomes.join(' ')}` : action
}

/** The most links one row's ⋯ menu offers (plan 151, D12). */
const MAX_MENU_LINKS = 3

/**
 * The keyboard path to a row's links (plan 151, D12): the row button holds
 * focus, not the link, so ⋯ offers Open and Copy too. One link reads "Open
 * link"; several name their host.
 */
function commentLinkMenuItems(message: LiveChatMessage): KebabMenuItem[] {
  const text = commentLinkText(message)
  const links = text ? chatLinksIn(text).slice(0, MAX_MENU_LINKS) : []
  const named = links.length > 1
  return links.flatMap((link, index) => [
    {
      id: `open-link-${index}`,
      label: named ? `Open ${link.host}` : 'Open link',
      icon: ExternalLinkIcon,
      onSelect: () => void openChatLink(link.href)
    },
    {
      id: `copy-link-${index}`,
      label: named ? `Copy ${link.host} link` : 'Copy link',
      icon: CopyIcon,
      onSelect: () => void copyChatLink(link.href)
    }
  ])
}

/**
 * The row's ⋯ menu: show on (or take off) stream, reply, a link's Open and
 * Copy (plan 151), copy, and, for a row that can be removed, "Remove from
 * chat" (destructive: it sorts last, below a separator, in the destructive
 * tone). The stream toggle says "Take off
 * stream", never "Remove": only the irreversible item may say remove.
 * Copy and the links stay in History too (plan 174 S3.16a, H-30); a row the
 * account cannot remove on its platform keeps the item, disabled with the
 * fix (H-11).
 */
export function commentRowMenu({
  message,
  highlightable,
  highlightPhase,
  onHighlight,
  onReply,
  onRemoveFromChat,
  removeFromChatReason = null
}: {
  message: LiveChatMessage
  highlightable: boolean
  highlightPhase: CommentHighlightPhase
  onHighlight?: (message: LiveChatMessage) => void
  onReply?: (message: LiveChatMessage) => void
  onRemoveFromChat?: (message: LiveChatMessage) => void
  /** Why the row cannot be removed right now: the item is offered disabled. */
  removeFromChatReason?: string | null
}): KebabMenuItem[] {
  return [
    ...(highlightable
      ? [
          {
            id: 'show',
            label: highlightPhase === 'live' ? 'Take off stream' : 'Show on stream',
            icon: LivestreamIcon,
            onSelect: () => onHighlight?.(message)
          }
        ]
      : []),
    ...(onReply && (message.eventType === 'message' || message.eventType === 'paid')
      ? [{ id: 'reply', label: 'Reply', icon: SendIcon, onSelect: () => onReply(message) }]
      : []),
    ...commentLinkMenuItems(message),
    {
      id: 'copy',
      label: 'Copy',
      icon: CopyIcon,
      onSelect: () => void copyChatText(`${message.authorName}: ${message.messageText}`)
    },
    ...(onRemoveFromChat || removeFromChatReason
      ? [
          {
            id: 'remove-from-chat',
            label: REMOVE_FROM_CHAT_LABEL,
            icon: DeleteIcon,
            destructive: true,
            disabled: !onRemoveFromChat,
            disabledReason: removeFromChatReason,
            onSelect: () => onRemoveFromChat?.(message)
          }
        ]
      : [])
  ]
}

export function CommentRow({
  message,
  density = 'compact',
  timestamps = 'always',
  highlight = { phase: 'idle' },
  removal,
  cohostFlag,
  cohostSuggested = false,
  cohostSpotlight = false,
  mentionNames = [],
  onHighlight,
  onReply,
  onRemoveFromChat,
  removeFromChatReason = null,
  tabIndex = 0,
  ref,
  style,
  index
}: {
  message: LiveChatMessage
  density?: 'compact' | 'comfortable'
  /** 'hover' keeps the time out of sight until the pointer is on the row. */
  timestamps?: CommentTimestamps
  highlight?: CommentHighlightPresentation
  /** The removal chip (plan 140, S6), from `removalStatusView`. */
  removal?: RemovalStatusView | null
  /** The co-host's flag for this message, already filtered by Sensitivity. */
  cohostFlag?: CohostFlag
  /** The co-host suggests showing this comment (`cohost.state.highlights`). */
  cohostSuggested?: boolean
  /** The streamer is talking about this comment (`cohost.state.spotlight`). */
  cohostSpotlight?: boolean
  /** The streamer's own account names: a message naming one is a mention. */
  mentionNames?: readonly string[]
  onHighlight?: (message: LiveChatMessage) => void
  /** The Stream Manager's ⋯ Reply: prefills the composer with @name. */
  onReply?: (message: LiveChatMessage) => void
  /** ⋯ Remove from chat (plan 140, S6). Pass it only for a row that can be
   * removed now (`removeFromChatAvailable`); the backend re-checks. */
  onRemoveFromChat?: (message: LiveChatMessage) => void
  /** Why Remove from chat is off for this row (plan 174 H-11): the item
   * stays, disabled, with the fix on hover. */
  removeFromChatReason?: string | null
  /** The list's roving focus (plan 174 S3.16a, H-7): 0 on the active row,
   * -1 on every other. The row's ⋯ follows it. */
  tabIndex?: number
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
  const tint = commentRowTint(message, {
    spotlight: cohostSpotlight,
    onStream: highlight.phase === 'live'
  })
  const rowId = useId()
  const nameIds: CommentNameIds = {
    author: `${rowId}-author`,
    platform: `${rowId}-platform`,
    text: `${rowId}-text`
  }
  const content = (
    <CommentContent
      density={density}
      flag={cohostFlag}
      highlight={highlight}
      mentioned={mentioned}
      message={message}
      nameIds={highlightable ? nameIds : undefined}
      removal={removal}
      spotlight={cohostSpotlight && !cohostFlag}
      suggested={suggested}
      timestamps={timestamps}
    />
  )
  const menu = commentRowMenu({
    message,
    highlightable,
    highlightPhase: highlight.phase,
    onHighlight,
    onReply,
    onRemoveFromChat,
    removeFromChatReason
  })

  return (
    <li
      ref={ref}
      className={cn(
        'group/comment group/kebab-host flex items-start gap-0.5',
        !highlightable && 'rounded-row outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
      data-highlight-phase={highlight.phase}
      data-index={index}
      data-member={tint === 'member' || undefined}
      data-mention={mentioned || undefined}
      data-message-id={message.id}
      data-row-tint={tint ?? undefined}
      data-spotlight={cohostSpotlight || undefined}
      style={style}
      // A row with no button of its own still takes the list's focus, so the
      // arrows pass through it and C copies it.
      tabIndex={highlightable ? undefined : tabIndex}
    >
      {highlightable ? (
        // One button, and a click on it shows the message on stream or takes
        // it off (owner call, plan 174 D10). Its name is what the row says,
        // so a screen reader reads the chat (S0.5, H-2): author, platform,
        // message. aria-pressed says on stream; the action is the description.
        <Button
          aria-description={commentRowDescription(highlight, removal, suggested)}
          aria-labelledby={`${nameIds.author} ${nameIds.platform} ${nameIds.text}`}
          aria-pressed={highlight.phase === 'live'}
          disabled={highlight.phase === 'applying'}
          className={cn(
            'h-auto w-full min-w-0 flex-1 items-start justify-start gap-2 whitespace-normal px-2 py-1.5',
            commentRowClass(tint, highlight.phase === 'live')
          )}
          tabIndex={tabIndex}
          type="button"
          variant="ghost"
          onClick={(event) => {
            // Only a mouse drag that ends with words selected in this row is
            // not a click (owner call, D10): copying text never shows it on
            // stream. A keyboard click (detail 0) never carries a drag.
            if (event.detail > 0 && clickSelectsText(window.getSelection(), event.currentTarget))
              return
            onHighlight?.(message)
          }}
        >
          {content}
        </Button>
      ) : (
        <div
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 rounded-row px-2 py-1.5',
            commentRowClass(tint, highlight.phase === 'live')
          )}
        >
          {content}
        </div>
      )}
      <KebabMenu
        className="mt-1 shrink-0"
        items={menu}
        label={`Actions for ${message.authorName}'s message`}
        reveal="hover"
        tabIndex={tabIndex}
      />
    </li>
  )
}
