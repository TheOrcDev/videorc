import {
  chatDeliveryProgress,
  deliveryCursor,
  type ChatDelivery
} from '../../../../shared/chat-delivery'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'

import { classifyComposerDraft, markerTime } from '../../../../shared/session-markers'
import type { MarkerContext, SessionMarker } from '@/lib/backend'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { ChatPlatformIcon, CHAT_PLATFORM_LABELS } from '@/components/chat-platform-icon'
import { CohostNudge } from '@/components/cohost-nudge'
import { CommentRow, commentHighlightPresentationForMessage } from '@/components/comment-row'
import { CommentsDestinationStatus } from '@/components/comments-destination-status'
import {
  PlatformFilter,
  PlatformFilterMenuItems
} from '@/components/stream-manager/platform-filter'
import { AlertIcon, ChevronDownIcon, SearchIcon, SendIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type {
  CohostFlag,
  CommentHighlightState,
  CommentsSendOperation,
  LiveChatMessage,
  LiveChatProviderState,
  ModerationOperation
} from '@/lib/backend'
import { copyChatText } from '@/lib/chat-link-actions'
import { chatRowAfterMove, chatRowKeyCommand } from '@/lib/chat-list-keys'
import {
  removalStatusView,
  removeFromChatAvailable,
  removeFromChatBlockedReason
} from '@/lib/chat-removal-view'
import {
  chatDraftMaxChars,
  chatSendRetryPlan,
  validateChatDraft,
  type ChatSendFailure
} from '@/lib/chat-send'
import {
  chatPaneMessages,
  followChatOnResize,
  pickedSendProviders,
  spotlightScrollAllowed,
  writableProviders,
  type ChatPaneFilter
} from '@/lib/stream-manager-chat'
import { liveChatEmptyMessage } from '@/lib/live-chat-view'
import { ABOVE_NARROW, NARROW_ONLY } from '@/lib/stream-manager-layout'
import { cn } from '@/lib/utils'

const BOTTOM_THRESHOLD_PX = 64
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

export interface ChatPrefill {
  seq: number
  text: string
  /** A reply to a Buddy question: a real send marks it answered. */
  questionId?: string
}

export interface ChatSendOptions {
  inReplyToQuestionId?: string
  destinationIds?: string[]
}

export function ChatPane({
  messages,
  delivery,
  arrivalKey,
  providers,
  live,
  className,
  highlightedId = null,
  highlightState,
  highlightApplyingId = null,
  highlightFailure = null,
  cohostFlags,
  cohostSuggested,
  cohostSpotlight = null,
  questionMessageIds,
  mentionNames,
  onHighlight,
  removals,
  removalRequestIds,
  onRemoveFromChat,
  sendPending = false,
  sendOperation = null,
  sendFailures = [],
  onSend,
  markerContext,
  onMarker,
  onUndoMarker,
  prefill = null,
  cohostNudge = false,
  onCohostNudgeTurnOn,
  onCohostNudgeDismiss,
  jumpTo = null,
  searchFocusSignal = 0,
  composerFocusSignal = 0
}: {
  delivery?: ChatDelivery
  arrivalKey?: string
  messages: readonly LiveChatMessage[]
  providers: readonly LiveChatProviderState[]
  /** A live session: the composer, highlights and row actions are available. */
  live: boolean
  className?: string
  highlightedId?: string | null
  highlightState?: CommentHighlightState
  highlightApplyingId?: string | null
  highlightFailure?: { messageId: string; reason: string } | null
  cohostFlags?: ReadonlyMap<string, CohostFlag>
  cohostSuggested?: ReadonlySet<string>
  /** The message the streamer is talking about: marked, and pulled into view. */
  cohostSpotlight?: string | null
  /** Messages behind Buddy's open questions (the Questions filter). */
  questionMessageIds: ReadonlySet<string>
  /** The streamer's own account names (the Mentions filter). */
  mentionNames: readonly string[]
  onHighlight?: (message: LiveChatMessage) => void
  /** Each message's newest removal (plan 140, S6), for its row chip. */
  removals?: ReadonlyMap<string, ModerationOperation>
  /** "Remove from chat" asked for, before any operation answered. */
  removalRequestIds?: ReadonlySet<string>
  /** ⋯ Remove from chat on a removable row; only while live. */
  onRemoveFromChat?: (message: LiveChatMessage) => void
  sendPending?: boolean
  sendOperation?: CommentsSendOperation | null
  sendFailures?: ChatSendFailure[]
  markerContext?: MarkerContext | null
  onMarker?: (label?: string) => Promise<SessionMarker>
  onUndoMarker?: (marker: SessionMarker) => Promise<void>
  onSend?: (text: string, options?: ChatSendOptions) => void
  prefill?: ChatPrefill | null
  cohostNudge?: boolean
  onCohostNudgeTurnOn?: () => void
  onCohostNudgeDismiss?: () => void
  /** Buddy "jump to message": scroll there and stop following new chat. */
  jumpTo?: { messageId: string; seq: number } | null
  /** Bumped by ⌘F in the window. */
  searchFocusSignal?: number
  /** Bumped by ⌘L in the window (plan 174 S3.16a). */
  composerFocusSignal?: number
}): ReactElement {
  const [filter, setFilter] = useState<ChatPaneFilter>({
    platform: 'all',
    questions: false,
    mentions: false,
    search: ''
  })
  // One prefill stream for the composer: the window's (Buddy Reply, Thank in
  // chat) and a row's ⋯ Reply, in the order they were asked for.
  const [composerPrefill, setComposerPrefill] = useState<ChatPrefill | null>(null)
  const prefillSeqRef = useRef(0)
  const pushPrefill = useCallback((text: string, questionId?: string): void => {
    prefillSeqRef.current += 1
    setComposerPrefill({
      seq: prefillSeqRef.current,
      text,
      ...(questionId ? { questionId } : {})
    })
  }, [])
  const appliedExternalSeqRef = useRef<number | null>(null)
  useEffect(() => {
    if (!prefill || prefill.seq === appliedExternalSeqRef.current) return
    appliedExternalSeqRef.current = prefill.seq
    pushPrefill(prefill.text, prefill.questionId)
  }, [prefill, pushPrefill])
  const platforms = useMemo(
    () => [
      ...new Set([
        ...providers.map((provider) => provider.platform),
        ...messages.map((message) => message.platform)
      ])
    ],
    [messages, providers]
  )
  const shown = useMemo(
    () => chatPaneMessages(messages, filter, { questionMessageIds, mentionNames }),
    [filter, mentionNames, messages, questionMessageIds]
  )
  const activeFilterCount =
    Number(filter.platform !== 'all') + Number(filter.questions) + Number(filter.mentions)
  const filtering = activeFilterCount > 0 || filter.search.trim() !== ''

  const rootRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    setViewport(
      rootRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
    )
  }, [])
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => viewport,
    estimateSize: () => 58,
    overscan: 10,
    getItemKey: (index) => shown[index]?.id ?? index
  })

  const [pinned, setPinned] = useState(true)
  const [unread, setUnread] = useState(0)
  const pinnedRef = useRef(true)
  const [incomplete, setIncomplete] = useState(false)
  const arrivalRef = useRef({ key: arrivalKey, cursor: deliveryCursor(delivery) })
  // When the streamer last scrolled by hand (wheel, touch, keys, the
  // scrollbar); programmatic follow and jump scrolls never count.
  const lastUserScrollAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (!viewport) return
    const onScroll = (): void => {
      const atBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX
      pinnedRef.current = atBottom
      setPinned(atBottom)
      if (atBottom) {
        setUnread(0)
        setIncomplete(false)
      }
    }
    const onUserScroll = (): void => {
      lastUserScrollAtRef.current = Date.now()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(event.key)) onUserScroll()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if ((event.target as Element | null)?.closest?.('[data-slot="scroll-area-scrollbar"]')) {
        onUserScroll()
      }
    }
    const root = rootRef.current
    viewport.addEventListener('scroll', onScroll, { passive: true })
    viewport.addEventListener('wheel', onUserScroll, { passive: true })
    viewport.addEventListener('touchmove', onUserScroll, { passive: true })
    viewport.addEventListener('keydown', onKeyDown)
    root?.addEventListener('pointerdown', onPointerDown)
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      viewport.removeEventListener('wheel', onUserScroll)
      viewport.removeEventListener('touchmove', onUserScroll)
      viewport.removeEventListener('keydown', onKeyDown)
      root?.removeEventListener('pointerdown', onPointerDown)
    }
  }, [viewport])

  // A resize (the window, the composer's notes, a row whose emotes loaded)
  // keeps a pinned chat on its newest row (plan 057, P4).
  useEffect(() => {
    if (!viewport || typeof ResizeObserver === 'undefined') return
    return followChatOnResize(viewport, () => pinnedRef.current)
  }, [viewport])

  // Paint retention and filter refreshes are not delivery evidence.
  useEffect(() => {
    const prior = arrivalRef.current
    const progress = chatDeliveryProgress(
      delivery,
      prior.key === arrivalKey ? prior.cursor : null,
      (message) =>
        chatPaneMessages([message], filter, { questionMessageIds, mentionNames }).length > 0
    )
    arrivalRef.current = { key: arrivalKey, cursor: progress.cursor }
    if (progress.reset || pinnedRef.current) {
      setUnread(0)
      setIncomplete(false)
    } else {
      setUnread((value) => value + progress.count)
      if (progress.incomplete) setIncomplete(true)
    }
  }, [arrivalKey, delivery, filter, mentionNames, questionMessageIds])
  const newestId = shown.at(-1)?.id
  useEffect(() => {
    if (pinnedRef.current && shown.length > 0)
      virtualizer.scrollToIndex(shown.length - 1, { align: 'end' })
  }, [newestId, shown.length, virtualizer])

  const jumpToLatest = useCallback((): void => {
    pinnedRef.current = true
    setPinned(true)
    setUnread(0)
    setIncomplete(false)
    if (shown.length > 0) virtualizer.scrollToIndex(shown.length - 1, { align: 'end' })
  }, [shown.length, virtualizer])

  // Buddy's "jump to message": clear filters that hide it, then scroll there.
  const handledJumpSeqRef = useRef<number | null>(null)
  useEffect(() => {
    if (!jumpTo || handledJumpSeqRef.current === jumpTo.seq) return
    const index = shown.findIndex((message) => message.id === jumpTo.messageId)
    if (index < 0) {
      if (filtering) {
        setFilter({ platform: 'all', questions: false, mentions: false, search: '' })
      } else {
        handledJumpSeqRef.current = jumpTo.seq
      }
      return
    }
    handledJumpSeqRef.current = jumpTo.seq
    pinnedRef.current = false
    setPinned(false)
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [filtering, jumpTo, shown, virtualizer])

  // Buddy's pull-up: scroll the comment being talked about into view once per
  // spotlight, unless the streamer is reading back (spotlightScrollAllowed).
  // If it took them away from the latest, they go back there when it ends,
  // unless they scrolled in the meantime.
  const handledSpotlightRef = useRef<string | null>(null)
  const spotlightLeftLatestAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (!cohostSpotlight) {
      handledSpotlightRef.current = null
      const leftAt = spotlightLeftLatestAtRef.current
      spotlightLeftLatestAtRef.current = null
      if (leftAt !== null && (lastUserScrollAtRef.current ?? 0) < leftAt) jumpToLatest()
      return
    }
    if (handledSpotlightRef.current === cohostSpotlight) return
    const index = shown.findIndex((message) => message.id === cohostSpotlight)
    if (index < 0) return
    handledSpotlightRef.current = cohostSpotlight
    const nowMs = Date.now()
    if (
      !spotlightScrollAllowed({
        pinned: pinnedRef.current,
        lastUserScrollAtMs: lastUserScrollAtRef.current,
        nowMs
      })
    ) {
      return
    }
    if (pinnedRef.current) spotlightLeftLatestAtRef.current = nowMs
    pinnedRef.current = false
    setPinned(false)
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [cohostSpotlight, jumpToLatest, shown, virtualizer])

  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchFocusSignal > 0) searchRef.current?.focus()
  }, [searchFocusSignal])

  const composerVisible = Boolean(onSend) && (live || Boolean(markerContext))
  // Esc on a row returns to the composer; ⌘L comes from the window.
  const [composerFocus, setComposerFocus] = useState(0)

  // One tab stop with roving focus (plan 174 S3.16a, H-7): the active row
  // (the newest until one is chosen) holds tabIndex 0, every other -1. A
  // focused row answers ↑/↓, Home, End, R, C, ⇧⌫ and Esc; Enter and Space
  // are its button's own click. A row that has scrolled out of the
  // virtualized window is focused once it is rendered again.
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIndex = useMemo(() => {
    const index = activeId ? shown.findIndex((message) => message.id === activeId) : -1
    return index >= 0 ? index : shown.length - 1
  }, [activeId, shown])
  const pendingFocusRef = useRef<string | null>(null)
  const focusPendingRow = useCallback((): void => {
    const id = pendingFocusRef.current
    if (!id || typeof CSS === 'undefined') return
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    const target = row?.matches('[tabindex]')
      ? row
      : row?.querySelector<HTMLElement>(':scope > button')
    if (!target) return
    pendingFocusRef.current = null
    target.focus({ preventScroll: true })
  }, [])
  useEffect(focusPendingRow)
  const focusRow = (index: number): void => {
    const message = shown[index]
    if (!message) return
    setActiveId(message.id)
    pendingFocusRef.current = message.id
    virtualizer.scrollToIndex(index, { align: 'auto' })
    focusPendingRow()
  }
  /** The row's Remove from chat: the action, or why it is off (H-11). */
  const rowRemoval = (
    message: LiveChatMessage
  ): { onRemove: ((message: LiveChatMessage) => void) | undefined; reason: string | null } => {
    const available =
      live &&
      onRemoveFromChat &&
      removeFromChatAvailable(
        message,
        removals?.get(message.id),
        removalRequestIds?.has(message.id) ?? false
      )
    if (!available) return { onRemove: undefined, reason: null }
    const reason = removeFromChatBlockedReason(message, providers)
    return { onRemove: reason ? undefined : onRemoveFromChat, reason }
  }
  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLOListElement>): void => {
    const row = event.target instanceof Element ? event.target.closest('[data-message-id]') : null
    const command = chatRowKeyCommand(event.nativeEvent, row)
    if (!command || !row) return
    const id = row.getAttribute('data-message-id')
    const index = shown.findIndex((message) => message.id === id)
    const message = shown[index]
    if (!message) return
    switch (command.kind) {
      case 'move': {
        const next = chatRowAfterMove(shown.length, index, command.move)
        if (next === null) return
        event.preventDefault()
        focusRow(next)
        return
      }
      case 'reply':
        if (!composerVisible || (message.eventType !== 'message' && message.eventType !== 'paid'))
          return
        event.preventDefault()
        pushPrefill(`@${message.authorName} `)
        return
      case 'copy':
        event.preventDefault()
        void copyChatText(`${message.authorName}: ${message.messageText}`)
        return
      case 'remove': {
        const { onRemove } = rowRemoval(message)
        if (!onRemove) return
        event.preventDefault()
        onRemove(message)
        return
      }
      case 'composer':
        if (!composerVisible) return
        event.preventDefault()
        setComposerFocus((value) => value + 1)
        return
    }
  }

  return (
    <section
      aria-label="Chat"
      className={cn('min-h-0 flex-1 flex-col', className)}
      data-slot="chat-pane"
    >
      <div
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5"
        data-slot="chat-filters"
      >
        <div className={cn('flex-wrap items-center gap-1.5', 'flex', ABOVE_NARROW)}>
          <PlatformFilter
            label="Show chat from"
            platforms={platforms}
            value={filter.platform}
            onValueChange={(platform) => setFilter((current) => ({ ...current, platform }))}
          />
          <ToggleGroup
            aria-label="Chat filters"
            size="sm"
            type="multiple"
            value={[
              ...(filter.questions ? ['questions'] : []),
              ...(filter.mentions ? ['mentions'] : [])
            ]}
            onValueChange={(values) =>
              setFilter((current) => ({
                ...current,
                questions: values.includes('questions'),
                mentions: values.includes('mentions')
              }))
            }
          >
            {questionMessageIds.size > 0 || filter.questions ? (
              <ToggleGroupItem
                className="h-6 px-2 text-xs"
                title="Messages behind Buddy's open questions"
                value="questions"
              >
                Questions
              </ToggleGroupItem>
            ) : null}
            <ToggleGroupItem
              className="h-6 px-2 text-xs"
              title="Messages that @mention your channel"
              value="mentions"
            >
              Mentions
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {/* Below 640 px the same filters live in one menu. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Chat filters"
              className={cn('h-7 shrink-0 gap-1 px-2 text-xs', NARROW_ONLY)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Filters
              {activeFilterCount > 0 ? (
                <Badge className="h-4 px-1.5" variant="outline">
                  {activeFilterCount}
                </Badge>
              ) : null}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {platforms.length > 1 ? (
              <>
                <PlatformFilterMenuItems
                  label="Show chat from"
                  platforms={platforms}
                  value={filter.platform}
                  onValueChange={(platform) => setFilter((current) => ({ ...current, platform }))}
                />
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuGroup>
              {questionMessageIds.size > 0 || filter.questions ? (
                <DropdownMenuCheckboxItem
                  checked={filter.questions}
                  onCheckedChange={(checked) =>
                    setFilter((current) => ({ ...current, questions: checked === true }))
                  }
                >
                  Questions
                </DropdownMenuCheckboxItem>
              ) : null}
              <DropdownMenuCheckboxItem
                checked={filter.mentions}
                onCheckedChange={(checked) =>
                  setFilter((current) => ({ ...current, mentions: checked === true }))
                }
              >
                Mentions
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <InputGroup className="h-7 min-w-28 flex-1 basis-40" data-testid="chat-search">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            aria-label="Search chat"
            placeholder="Search"
            value={filter.search}
            onChange={(event) =>
              setFilter((current) => ({ ...current, search: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setFilter((current) => ({ ...current, search: '' }))
                event.currentTarget.blur()
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <ShortcutKeys accelerator="CmdOrCtrl+F" />
          </InputGroupAddon>
        </InputGroup>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea ref={rootRef} className="min-h-0 flex-1 px-2 py-1">
          {shown.length === 0 ? (
            filtering ? (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyDescription>No messages match these filters.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <OffAir providers={providers} />
            )
          ) : (
            <ol
              aria-label="Chat messages"
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
              onFocusCapture={(event) => {
                // A click or a Tab onto a row makes it the active one.
                const id = event.target
                  .closest('[data-message-id]')
                  ?.getAttribute('data-message-id')
                if (id) setActiveId(id)
              }}
              onKeyDown={handleListKeyDown}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const message = shown[item.index]
                if (!message) return null
                const removal = removals?.get(message.id)
                const requesting = removalRequestIds?.has(message.id) ?? false
                const { onRemove, reason } = rowRemoval(message)
                return (
                  <CommentRow
                    key={item.key}
                    ref={virtualizer.measureElement}
                    cohostFlag={cohostFlags?.get(message.id)}
                    cohostSpotlight={cohostSpotlight === message.id}
                    cohostSuggested={cohostSuggested?.has(message.id) ?? false}
                    density="comfortable"
                    timestamps={live ? 'hover' : 'always'}
                    highlight={commentHighlightPresentationForMessage({
                      messageId: message.id,
                      highlightedId,
                      state: highlightState,
                      applyingId: highlightApplyingId,
                      failure: highlightFailure
                    })}
                    index={item.index}
                    mentionNames={mentionNames}
                    message={message}
                    removal={removalStatusView(message, removal, requesting)}
                    removeFromChatReason={reason}
                    tabIndex={item.index === activeIndex ? 0 : -1}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                      paddingBottom: 4
                    }}
                    onHighlight={live ? onHighlight : undefined}
                    onRemoveFromChat={onRemove}
                    onReply={
                      composerVisible
                        ? (target) => pushPrefill(`@${target.authorName} `)
                        : undefined
                    }
                  />
                )
              })}
            </ol>
          )}
        </ScrollArea>
        {!pinned && (unread > 0 || incomplete) ? (
          <Button
            aria-label={`Chat paused: ${incomplete ? 'New chat' : `${unread} new`}. Jump to the newest`}
            className="absolute inset-x-0 bottom-2 mx-auto h-6 w-fit rounded-full px-2.5 text-xs text-foreground glass-chip hover:text-foreground"
            data-testid="chat-paused"
            size="sm"
            type="button"
            variant="ghost"
            onClick={jumpToLatest}
          >
            {incomplete ? 'New chat' : `${unread} new`} ↓
          </Button>
        ) : null}
      </div>

      {composerVisible && onSend ? (
        <Composer
          markerContext={markerContext}
          onMarker={onMarker}
          onUndoMarker={onUndoMarker}
          cohostNudge={cohostNudge}
          failures={sendFailures}
          focusSignal={composerFocusSignal + composerFocus}
          operation={sendOperation}
          pending={sendPending}
          prefill={composerPrefill}
          providers={providers}
          onCohostNudgeDismiss={onCohostNudgeDismiss}
          onCohostNudgeTurnOn={onCohostNudgeTurnOn}
          onSend={onSend}
        />
      ) : null}
    </section>
  )
}

export function Composer({
  providers,
  pending,
  failures,
  operation,
  prefill,
  focusSignal = 0,
  cohostNudge,
  onCohostNudgeTurnOn,
  onCohostNudgeDismiss,
  onSend,
  markerContext,
  onMarker,
  onUndoMarker
}: {
  markerContext?: MarkerContext | null
  onMarker?: (label?: string) => Promise<SessionMarker>
  onUndoMarker?: (marker: SessionMarker) => Promise<void>
  providers: readonly LiveChatProviderState[]
  pending: boolean
  failures: ChatSendFailure[]
  operation: CommentsSendOperation | null
  prefill: ChatPrefill | null
  /** Bumped to put the caret in the composer (⌘L, Esc on a row). */
  focusSignal?: number
  cohostNudge: boolean
  onCohostNudgeTurnOn?: () => void
  onCohostNudgeDismiss?: () => void
  onSend: (text: string, options?: ChatSendOptions) => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [localPending, setLocalPending] = useState(false)
  const localPendingRef = useRef(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [savedMarker, setSavedMarker] = useState<SessionMarker | null>(null)
  const [completionDismissed, setCompletionDismissed] = useState(false)
  const [completionIndex, setCompletionIndex] = useState(0)
  const heardMarkerId = useRef<string | null>(null)
  const heardMarkerRevision = useRef(0)
  useEffect(() => {
    const marker = markerContext?.lastMarker
    if (
      !marker ||
      (marker.id === heardMarkerId.current && marker.revision === heardMarkerRevision.current)
    )
      return
    heardMarkerId.current = marker.id
    heardMarkerRevision.current = marker.revision
    setSavedMarker(marker)
    setNotice(
      `Marker saved at ${markerTime(marker.atSeconds)} · ${marker.label ?? 'Untitled marker'}`
    )
  }, [markerContext?.lastMarker])

  const [replyToQuestionId, setReplyToQuestionId] = useState<string | null>(null)
  // null sends to every writable destination; a set is the streamer's pick.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const appliedPrefillRef = useRef<number | null>(null)
  const writable = writableProviders(providers)
  const targets = pickedSendProviders(providers, picked)
  const targetPlatforms = [...new Set(targets.map((provider) => provider.platform))]
  // The draft must fit the STRICTEST destination it reaches (140 with X).
  const maxChars = chatDraftMaxChars(targetPlatforms)
  const command = classifyComposerDraft(draft)
  const local = command.kind !== 'chat'
  const canSend = local
    ? !localPending &&
      (command.kind !== 'marker' ||
        Boolean((markerContext?.available || markerContext?.retryAvailable) && onMarker))
    : targets.length > 0 && !pending
  const completions = ['/marker', '/help'].filter(
    (value) =>
      draft.startsWith('/') && !draft.includes(' ') && value.startsWith(draft.toLowerCase())
  )
  const showCompletions = completions.length > 0 && !completionDismissed
  const complete = (value: string): void => {
    setDraft(value + (value === '/marker' ? ' ' : ''))
    setCompletionDismissed(true)
    inputRef.current?.focus()
  }

  useEffect(() => {
    if (!prefill || prefill.seq === appliedPrefillRef.current) return
    appliedPrefillRef.current = prefill.seq
    setDraft(prefill.text)
    setReplyToQuestionId(prefill.questionId ?? null)
    inputRef.current?.focus()
  }, [prefill])
  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus()
  }, [focusSignal])

  // A failed send keeps the draft and offers Retry (plan 174 S3.16a, H-26):
  // the words come back into the composer when nobody got them, and Retry
  // re-sends only where it failed after a partial send.
  const [lastSend, setLastSend] = useState<{ text: string; options?: ChatSendOptions } | null>(null)
  const retry = pending || !lastSend ? null : chatSendRetryPlan(operation, failures)
  const failureKey = retry
    ? failures.map((failure) => `${failure.destinationId}:${failure.reason}`).join('|')
    : null
  const restoreDraft = retry?.restoreDraft ?? false
  const handledFailureRef = useRef<string | null>(null)
  useEffect(() => {
    if (!failureKey || !restoreDraft || !lastSend) return
    if (handledFailureRef.current === failureKey) return
    handledFailureRef.current = failureKey
    setDraft((current) => (current.trim() === '' ? lastSend.text : current))
  }, [failureKey, lastSend, restoreDraft])
  const retrySend = (): void => {
    if (!retry || !lastSend) return
    const options = {
      ...lastSend.options,
      ...(retry.destinationIds ? { destinationIds: retry.destinationIds } : {})
    }
    onSend(lastSend.text, options)
    if (draftRef.current === lastSend.text) setDraft('')
  }

  const submit = (): void => {
    if (localPendingRef.current) return
    if (command.kind === 'error') {
      setNotice(command.message)
      return
    }
    if (command.kind === 'help') {
      setNotice(
        '/marker [title] saves a point on this recording or livestream. // sends a literal slash to chat. Markers are in Library → Session actions → Markers.'
      )
      return
    }
    if (command.kind === 'marker') {
      if ((!markerContext?.available && !markerContext?.retryAvailable) || !onMarker) {
        setNotice(markerContext?.reason ?? 'Start a recording or livestream to make a marker.')
        return
      }
      setSavedMarker(null)
      const submitted = draft
      localPendingRef.current = true
      setLocalPending(true)
      setNotice('Saving marker…')
      void onMarker(command.label)
        .then((marker) => {
          setSavedMarker(marker)
          setNotice(
            `Marker saved at ${markerTime(marker.atSeconds)} · ${marker.label ?? 'Untitled marker'}`
          )
          if (draftRef.current === submitted) setDraft('')
        })
        .catch((error) =>
          setNotice(
            error instanceof Error ? error.message : 'Could not save marker. Retry this command.'
          )
        )
        .finally(() => {
          localPendingRef.current = false
          setLocalPending(false)
        })
      return
    }
    const text = validateChatDraft(command.text, maxChars)
    if (!text || !canSend) return
    const options: ChatSendOptions = {
      ...(replyToQuestionId ? { inReplyToQuestionId: replyToQuestionId } : {}),
      ...(picked ? { destinationIds: targets.map((provider) => provider.id) } : {})
    }
    onSend(text, options)
    setLastSend({ text, options })
    setDraft('')
    setReplyToQuestionId(null)
  }

  const pickLabel =
    picked === null || targets.length === writable.length
      ? 'All'
      : targets.length === 0
        ? 'None'
        : targets.map((provider) => CHAT_PLATFORM_LABELS[provider.platform]).join(', ')

  return (
    <div className="shrink-0 px-2 pt-1 pb-2" data-slot="chat-composer">
      <div className="flex flex-col rounded-panel border border-border bg-foreground/[0.04] p-2">
        <InputGroup>
          {local ? (
            <InputGroupAddon>
              <span className="text-[11px] text-muted-foreground">
                {command.kind === 'marker' ? 'Local · current session' : 'Local'}
              </span>
            </InputGroupAddon>
          ) : writable.length > 1 ? (
            <InputGroupAddon>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton
                    aria-label={`Send to: ${pickLabel}`}
                    data-testid="chat-send-to"
                    size="xs"
                  >
                    To: {pickLabel}
                    <ChevronDownIcon data-icon="inline-end" />
                  </InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>Send to</DropdownMenuLabel>
                  <DropdownMenuGroup>
                    {writable.map((provider) => (
                      <DropdownMenuCheckboxItem
                        key={provider.id}
                        checked={picked === null || picked.has(provider.id)}
                        onCheckedChange={(checked) =>
                          setPicked((current) => {
                            const next = new Set(
                              current ?? writable.map((candidate) => candidate.id)
                            )
                            if (checked) next.add(provider.id)
                            else next.delete(provider.id)
                            return next.size === writable.length ? null : next
                          })
                        }
                        onSelect={(event) => event.preventDefault()}
                      >
                        <ChatPlatformIcon decorative platform={provider.platform} />
                        {CHAT_PLATFORM_LABELS[provider.platform]}
                        {provider.accountLabel ? (
                          <span className="truncate text-muted-foreground">
                            {provider.accountLabel}
                          </span>
                        ) : null}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setPicked(null)}>
                    Every writable destination
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </InputGroupAddon>
          ) : null}
          <InputGroupInput
            ref={inputRef}
            aria-label="Message or local command"
            placeholder={
              writable.length > 0
                ? 'Message or /marker [title]…'
                : '/marker [title] · Local commands'
            }
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setCompletionDismissed(false)
              setCompletionIndex(0)
              if (event.target.value.trim().length === 0) setReplyToQuestionId(null)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Escape') {
                setCompletionDismissed(true)
                return
              }
              if (showCompletions && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                setCompletionIndex(
                  (index) =>
                    (index + (event.key === 'ArrowDown' ? 1 : completions.length - 1)) %
                    completions.length
                )
                return
              }
              if (
                showCompletions &&
                (event.key === 'Tab' ||
                  (event.key === 'Enter' && draft !== completions[completionIndex]))
              ) {
                event.preventDefault()
                complete(completions[completionIndex] ?? completions[0])
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            {draft.length > 0 ? (
              <span
                className={cn(
                  'flex items-center gap-1 text-[11px] tabular-nums',
                  !local && draft.trim().length > maxChars
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground'
                )}
              >
                {/* Over the limit, the icon carries the tone (plan 174 S1.8). */}
                {!local && draft.trim().length > maxChars ? (
                  <AlertIcon aria-hidden className="size-3 text-destructive" weight="fill" />
                ) : null}
                {local
                  ? command.kind === 'marker'
                    ? `${[...(command.label ?? '')].length}/120`
                    : 'Local'
                  : `${draft.trim().length}/${maxChars}`}
              </span>
            ) : null}
            <ShortcutKeys accelerator="Enter" />
            <InputGroupButton
              aria-label={
                local
                  ? 'Run local command'
                  : pending
                    ? 'Sending message'
                    : targets.length === 0
                      ? 'Send message: no destination picked'
                      : picked === null || targets.length === writable.length
                        ? 'Send message to all writable destinations'
                        : `Send message to ${pickLabel}`
              }
              disabled={
                localPending || (!local && (!canSend || !validateChatDraft(command.text, maxChars)))
              }
              size="icon-xs"
              onClick={submit}
            >
              <SendIcon data-icon="inline-end" weight="fill" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {showCompletions ? (
          <Command
            shouldFilter={false}
            value={completions[completionIndex]}
            className="mt-1"
            aria-label="Local commands"
          >
            <CommandList>
              {completions.map((value) => (
                <CommandItem key={value} value={value} onSelect={() => complete(value)}>
                  {value}
                  {value === '/marker' ? ' [title] · Save a timeline point' : ' · Command help'}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        ) : null}
        {markerContext?.available ? (
          <p className="mt-1 text-[11px] text-muted-foreground" data-slot="marker-voice-status">
            {markerContext.voice?.state === 'on'
              ? 'Buddy hears marker commands.'
              : markerContext.voice?.state === 'starting'
                ? 'Buddy is connecting to hear marker commands…'
                : (markerContext.voice?.message ??
                  'Typed /marker commands are available. Turn on Buddy listening for voice markers.')}
          </p>
        ) : null}
        {notice ? (
          <div role="status" className="mt-1 text-xs text-muted-foreground">
            {notice}
            {savedMarker && onUndoMarker ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={localPending}
                onClick={() => {
                  if (localPendingRef.current) return
                  localPendingRef.current = true
                  setLocalPending(true)
                  void onUndoMarker(savedMarker)
                    .then(() => {
                      setSavedMarker(null)
                      setNotice('Marker removed.')
                    })
                    .catch((error) =>
                      setNotice(error instanceof Error ? error.message : 'Could not remove marker.')
                    )
                    .finally(() => {
                      localPendingRef.current = false
                      setLocalPending(false)
                    })
                }}
              >
                Undo
              </Button>
            ) : null}
          </div>
        ) : null}
        {replyToQuestionId ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Buddy&apos;s draft. <ShortcutKeys accelerator="Enter" variant="text" /> sends it.
          </p>
        ) : null}
        {/* Only exceptions speak here (plan 057, D3): the "To:" picker names
            where a message goes, and Buddy's segment carries its status. */}
        <div className="mt-1.5 empty:hidden">
          <CommentsDestinationStatus
            failures={failures}
            mode="composer"
            providers={[...providers]}
            sendTargets={targetPlatforms}
          />
          {retry ? (
            <Button
              aria-label={
                retry.restoreDraft ? 'Retry sending the message' : 'Retry where the send failed'
              }
              className="mt-1"
              data-testid="chat-send-retry"
              size="xs"
              type="button"
              variant="outline"
              onClick={retrySend}
            >
              Retry
            </Button>
          ) : null}
          {cohostNudge && onCohostNudgeDismiss && onCohostNudgeTurnOn ? (
            <CohostNudge onDismiss={onCohostNudgeDismiss} onTurnOn={onCohostNudgeTurnOn} />
          ) : null}
          {operation ? <DeliveryStatus operation={operation} /> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * A send in flight says so; a finished one says nothing (plan 057, D3). The
 * message shows up in chat, a failed destination shows its reason as a
 * badge, and a receive-only one is named in the notes line.
 */
function DeliveryStatus({ operation }: { operation: CommentsSendOperation }): ReactElement | null {
  if (operation.phase !== 'sending') return null
  return (
    <div aria-label="Latest message delivery" className="mt-1.5 flex">
      <Badge className="max-w-full truncate" title={operation.text} variant="secondary">
        Sending…
      </Badge>
    </div>
  )
}

function OffAir({ providers }: { providers: readonly LiveChatProviderState[] }): ReactElement {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>No messages yet</EmptyTitle>
        <EmptyDescription>
          {liveChatEmptyMessage(
            { providers: [...providers] },
            'Start a livestream to see chat here.'
          )}
        </EmptyDescription>
      </EmptyHeader>
      <CommentsDestinationStatus providers={[...providers]} />
    </Empty>
  )
}
