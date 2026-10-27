import {
  useId,
  useMemo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type Ref
} from 'react'

import { ChatJumpChip } from '@/components/chat-jump-chip'
import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import {
  COMMENT_ROW_TINT_CLASS,
  CommentMessageBody,
  HighlightStatus,
  commentHighlightPresentationForMessage,
  commentRowDescription,
  highlightProblem,
  type CommentHighlightPresentation
} from '@/components/comment-row'
import { CloseIcon } from '@/components/icons'
import { PanelSection } from '@/components/panel-section'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { useStudioChat, useStudioCore, useStudioShell } from '@/hooks/use-studio'
import { useChatList } from '@/hooks/use-chat-list'
import type { LiveChatMessage } from '@/lib/backend'
import { monogramInitials, useCachedAvatar } from '@/lib/chat-avatar'
import { copyChatText } from '@/lib/chat-link-actions'
import { chatRowAfterMove, chatRowKeyCommand, clickSelectsText } from '@/lib/chat-list-keys'
import { noticeViewerWords } from '@/lib/chat-notice'
import { CHAT_PLATFORM_LABELS, commentCanHighlight, commentRowTint } from '@/lib/live-chat-view'
import { shortcutAccelerator } from '@/lib/shortcuts'
import {
  studioChatBody,
  studioChatCountsAsArrival,
  studioChatMessages,
  studioChatNotice
} from '@/lib/studio-chat-view'
import { TOAST_WITH_DESCRIPTION_MS, toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { WINDOW_NAMES } from '../../../../shared/window-names'

// Chat in Studio (plan 204, owner 2026-10-27): "just a small window where we
// have comments and things like username and which platform", with a click
// that puts a message on stream. The livestream's chat under Session while on
// air, less detailed than the Stream Manager's: each row is a small avatar,
// the name, the words and the platform mark. It reads the same snapshot and
// the same highlight the Stream Manager mirrors, so a row lit in one is lit
// in the other. Its own chunk: the Studio tab keeps only the gate
// (`lib/studio-chat.ts`).

/** The list area's height (D8): about seven one-line messages, fixed, so the inspector never jumps. */
export const STUDIO_CHAT_LIST_HEIGHT = 'h-64'

/** The one id for the hide toast, so a second hide replaces the first. */
const HIDDEN_TOAST_ID = 'studio-chat-hidden'

/** The section's label everywhere it is named: the hide button, the toast. */
export const HIDE_STUDIO_CHAT_LABEL = 'Hide chat in Studio'

export function StudioChatSection(): ReactElement {
  const { liveChatSnapshot } = useStudioChat()
  const {
    setSettings,
    highlightedCommentId,
    commentHighlightState,
    commentHighlightApplyingId,
    commentHighlightFailure,
    toggleCommentHighlight
  } = useStudioCore()
  const { openCommentsWindow, runtimeInfo } = useStudioShell()
  const { providers } = liveChatSnapshot
  const body = studioChatBody(providers)
  const notice = studioChatNotice(providers)
  const live = Boolean(liveChatSnapshot.sessionId)

  // Hiding is cheap to undo, so it never asks (Confirm and undo): the section
  // goes, and one toast says where it went, because nothing on screen does.
  const hide = (): void => {
    setSettings((current) => ({ ...current, studioChat: false }))
    toast.info('Chat hidden in Studio', {
      id: HIDDEN_TOAST_ID,
      description: 'Turn it back on in Settings → General.',
      // Undo is a moment's offer, not a state still true: it goes on its own.
      duration: TOAST_WITH_DESCRIPTION_MS,
      action: {
        label: 'Undo',
        onClick: () => setSettings((current) => ({ ...current, studioChat: true }))
      }
    })
  }

  return (
    <PanelSection
      action={
        <>
          {/* The full chat (filters, search, the composer, replies, removals
              and Buddy) is the Stream Manager's; this is its door. */}
          {runtimeInfo?.commentsWindowEnabled !== false ? (
            <ShortcutTooltip
              accelerator={shortcutAccelerator('comments-window')}
              label={`Open ${WINDOW_NAMES.streamManager}`}
            >
              <Button
                data-testid="studio-chat-open-stream-manager"
                type="button"
                variant="ghost"
                onClick={() => void openCommentsWindow()}
              >
                Open {WINDOW_NAMES.streamManager}
              </Button>
            </ShortcutTooltip>
          ) : null}
          <ShortcutTooltip label={HIDE_STUDIO_CHAT_LABEL}>
            <Button
              aria-label={HIDE_STUDIO_CHAT_LABEL}
              data-testid="studio-chat-hide"
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={hide}
            >
              <CloseIcon />
            </Button>
          </ShortcutTooltip>
        </>
      }
      data-testid="studio-chat"
      title="Chat"
    >
      {notice ? (
        // Quiet when fine, specific when not (D9): the destination whose chat
        // needs the streamer, in the Stream Manager's own words.
        <p className="text-meta text-muted-foreground" data-testid="studio-chat-notice">
          {notice}
        </p>
      ) : null}
      {body.kind === 'no-chat' ? (
        <p className="text-meta text-muted-foreground" data-testid="studio-chat-empty">
          {body.text}
        </p>
      ) : (
        <StudioChatList
          delivery={liveChatSnapshot.delivery}
          arrivalKey={liveChatSnapshot.sessionId}
          emptyText={body.emptyText}
          messages={liveChatSnapshot.messages}
          // A message goes on stream only during the livestream it came from.
          onHighlight={live ? toggleCommentHighlight : undefined}
          presentation={(message) =>
            commentHighlightPresentationForMessage({
              messageId: message.id,
              highlightedId: highlightedCommentId,
              state: commentHighlightState,
              applyingId: commentHighlightApplyingId,
              failure: commentHighlightFailure
            })
          }
        />
      )}
    </PanelSection>
  )
}

/**
 * The rows, newest at the bottom and followed (owner call, 2026-10-21): only
 * the streamer's own scroll up stops it, and the jump chip comes back. One
 * tab stop: ↑, ↓, Home and End move, C copies, and Enter and Space are the
 * row's own click.
 */
export function StudioChatList({
  messages,
  delivery,
  arrivalKey,
  emptyText,
  onHighlight,
  presentation
}: {
  messages: readonly LiveChatMessage[]
  delivery?: Parameters<typeof useChatList>[0]['delivery']
  arrivalKey?: string
  emptyText: string
  onHighlight?: (message: LiveChatMessage) => void
  presentation: (message: LiveChatMessage) => CommentHighlightPresentation
}): ReactElement {
  const shown = useMemo(() => studioChatMessages(messages), [messages])
  const {
    rootRef,
    virtualizer,
    pinned,
    follow,
    unread,
    incomplete,
    activeIndex,
    setActiveId,
    focusRow
  } = useChatList({
    shown,
    delivery,
    arrivalKey,
    countsAsArrival: studioChatCountsAsArrival,
    estimateSize: 36
  })

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLOListElement>): void => {
    const row = event.target instanceof Element ? event.target.closest('[data-message-id]') : null
    const command = chatRowKeyCommand(event.nativeEvent, row)
    if (!command || !row) return
    const id = row.getAttribute('data-message-id')
    const index = shown.findIndex((message) => message.id === id)
    const message = shown[index]
    if (!message) return
    // No composer and no removal here: Reply, Remove from chat and Esc are
    // the Stream Manager's.
    if (command.kind === 'move') {
      const next = chatRowAfterMove(shown.length, index, command.move)
      if (next === null) return
      event.preventDefault()
      focusRow(next)
      return
    }
    if (command.kind === 'copy') {
      event.preventDefault()
      void copyChatText(`${message.authorName}: ${message.messageText}`)
    }
  }

  return (
    <div className="relative flex flex-col">
      {/* The follow owns this scroll position, so the browser's own scroll
          anchoring stays out of it. */}
      <ScrollArea
        ref={rootRef}
        className={cn(STUDIO_CHAT_LIST_HEIGHT, '-mx-2')}
        viewportClassName="[overflow-anchor:none]"
      >
        {shown.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyDescription data-testid="studio-chat-empty">{emptyText}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol
            aria-label="Chat messages"
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
            onFocusCapture={(event) => {
              // A click or a Tab onto a row makes it the active one.
              const id = event.target.closest('[data-message-id]')?.getAttribute('data-message-id')
              if (id) setActiveId(id)
            }}
            onKeyDown={handleListKeyDown}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const message = shown[item.index]
              if (!message) return null
              return (
                <StudioChatRow
                  key={item.key}
                  ref={virtualizer.measureElement}
                  highlight={presentation(message)}
                  index={item.index}
                  message={message}
                  tabIndex={item.index === activeIndex ? 0 : -1}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                    paddingBottom: 2
                  }}
                  onHighlight={onHighlight}
                />
              )
            })}
          </ol>
        )}
      </ScrollArea>
      {!pinned ? <ChatJumpChip incomplete={incomplete} unread={unread} onFollow={follow} /> : null}
    </div>
  )
}

/**
 * One message (D5): a small avatar, the name and the words on one wrapping
 * line, and the platform mark closing the row on the far right (owner call,
 * plan 165). A click shows it on stream, and a click on the live row takes it
 * off (owner call, D10): the same contract and the same names as the Stream
 * Manager's `CommentRow`, without its chips, time or ⋯ menu.
 */
export function StudioChatRow({
  message,
  highlight,
  onHighlight,
  tabIndex = 0,
  ref,
  style,
  index
}: {
  message: LiveChatMessage
  highlight: CommentHighlightPresentation
  /** Absent off air: the row is a fact, not a button. */
  onHighlight?: (message: LiveChatMessage) => void
  tabIndex?: number
  ref?: Ref<HTMLLIElement>
  style?: CSSProperties
  index?: number
}): ReactElement {
  const highlightable = Boolean(onHighlight) && commentCanHighlight(message)
  const tint = commentRowTint(message, { spotlight: false, onStream: highlight.phase === 'live' })
  const rowId = useId()
  const ids = {
    author: `${rowId}-author`,
    platform: `${rowId}-platform`,
    text: `${rowId}-text`
  }
  const content = <StudioChatRowContent highlight={highlight} ids={ids} message={message} />

  return (
    <li
      ref={ref}
      className={cn(
        'flex min-w-0',
        !highlightable && 'rounded-row outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
      data-highlight-phase={highlight.phase}
      data-index={index}
      data-message-id={message.id}
      data-row-tint={tint ?? undefined}
      style={style}
      // A row with no button of its own still takes the list's focus, so the
      // arrows pass through it and C copies it.
      tabIndex={highlightable ? undefined : tabIndex}
    >
      {highlightable ? (
        // One button: its name is who said what where ("Ada on YouTube: Ship
        // it!"), aria-pressed says on stream, and the description says what
        // a click does (plan 174 S0.5, H-2).
        <Button
          aria-description={commentRowDescription(highlight, null, false)}
          aria-labelledby={`${ids.author} ${ids.platform} ${ids.text}`}
          aria-pressed={highlight.phase === 'live'}
          className={cn(
            'h-auto w-full min-w-0 flex-1 items-start justify-start gap-2 px-2 py-1 font-normal whitespace-normal',
            tint && COMMENT_ROW_TINT_CLASS[tint]
          )}
          disabled={highlight.phase === 'applying'}
          tabIndex={tabIndex}
          type="button"
          variant={highlight.phase === 'live' ? 'secondary' : 'ghost'}
          onClick={(event) => {
            // A mouse drag that ends with words selected is not a click
            // (owner call, D10): copying text never shows it on stream.
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
            'flex min-w-0 flex-1 items-start gap-2 rounded-row px-2 py-1 text-sm',
            tint && COMMENT_ROW_TINT_CLASS[tint]
          )}
        >
          {content}
        </div>
      )}
    </li>
  )
}

function StudioChatRowContent({
  message,
  highlight,
  ids
}: {
  message: LiveChatMessage
  highlight: CommentHighlightPresentation
  ids: { author: string; platform: string; text: string }
}): ReactElement {
  const avatarUrl = useCachedAvatar(message.authorAvatarUrl)
  const problem = highlightProblem(highlight)
  // Plain system text and moderation lines read as notices. A Twitch notice
  // with the viewer's own words shows its sentence in italics itself.
  const notice =
    (message.eventType === 'system' && !noticeViewerWords(message)) ||
    message.eventType === 'moderation'

  return (
    <>
      <Avatar aria-hidden className="mt-px" size="sm">
        {avatarUrl ? <AvatarImage alt="" src={avatarUrl} /> : null}
        <AvatarFallback>{monogramInitials(message.authorName)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The name and the words on one line that wraps, chat style. */}
        <span className="min-w-0 text-left text-sm leading-snug break-words text-foreground">
          <span className="font-semibold" id={ids.author}>
            {message.authorName}
          </span>{' '}
          <span
            className={cn(
              'select-text',
              notice && 'text-muted-foreground italic',
              message.isDeleted && 'text-muted-foreground line-through'
            )}
            id={ids.text}
          >
            <CommentMessageBody density="compact" message={message} />
          </span>
        </span>
        {problem ? (
          <span
            className="text-left text-xs text-muted-foreground"
            data-testid="highlight-failed-reason"
          >
            {problem}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {message.amountText ? <Badge variant="warning">{message.amountText}</Badge> : null}
        <HighlightStatus status={highlight} />
        <ChatPlatformIcon className="mr-0" decorative platform={message.platform} />
        {/* The mark's words, for the row button's name only: a hidden node
            still counts when aria-labelledby points at it. */}
        <span hidden id={ids.platform}>
          {`on ${CHAT_PLATFORM_LABELS[message.platform]}:`}
        </span>
      </span>
    </>
  )
}
