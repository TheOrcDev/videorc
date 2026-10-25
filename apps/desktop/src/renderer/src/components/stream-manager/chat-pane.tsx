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
import {
  bannerCompletions,
  type BannerRelayAction,
  type BannerSummary,
  type ComposerCompletion
} from '../../../../shared/banner-commands'
import {
  soundCompletions,
  type SoundRelayAction,
  type SoundboardSummary
} from '../../../../shared/sound-commands'
import type { ClipContext, ClipLength, MarkerContext, SessionMarker } from '@/lib/backend'
import { clipLastWords } from '../../../../shared/clip-lengths'

/** What follows "the last" in the composer's clip words: "30 seconds" for
 * `/clip`, "minute" for `/clip 60` (plan 199). */
function clipSeconds(clip: ClipContext | undefined, long = false): string {
  return clipLastWords(long ? (clip?.longSeconds ?? 60) : clip?.seconds)
}

/** Why `/clip` keeps nothing right now, in the window's own words. */
function clipOffNotice(clip: ClipContext | undefined): string {
  switch (clip?.off) {
    case 'blocked':
      return 'Clips are off on this computer. Turn them on on the Output page.'
    case 'starting':
      return 'Clips are still starting. Try again in a moment.'
    case 'idle':
      return 'Nothing to clip yet. Start a recording, or go live.'
    default:
      return 'Clips are off. Turn on Keep the last seconds on the Output page.'
  }
}
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { ChatPlatformIcon, CHAT_PLATFORM_LABELS } from '@/components/chat-platform-icon'
import { CohostNudge } from '@/components/cohost-nudge'
import { CommentRow, commentHighlightPresentationForMessage } from '@/components/comment-row'
import { CommentsDestinationStatus } from '@/components/comments-destination-status'
import {
  PlatformFilter,
  PlatformFilterMenuItems
} from '@/components/stream-manager/platform-filter'
import { AlertIcon, ArrowDownIcon, ChevronDownIcon, SearchIcon, SendIcon } from '@/components/icons'
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
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { useChatFollow } from '@/hooks/use-chat-follow'
import {
  chatPaneMessages,
  pickedSendProviders,
  writableProviders,
  type ChatPaneFilter
} from '@/lib/stream-manager-chat'
import { liveChatEmptyMessage } from '@/lib/live-chat-view'
import { ABOVE_NARROW, NARROW_ONLY } from '@/lib/stream-manager-layout'
import { cn } from '@/lib/utils'

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
  onClip,
  onUndoMarker,
  banners,
  onBanner,
  sounds,
  onSound,
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
  /**
   * The message the streamer is talking about: marked "Talking about this",
   * never scrolled to. The list stays on the newest message (2026-10-21).
   */
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
  /** `/clip` (plan 181 R4): the Clip button's action, answered with its words.
   * Plan 199: `/clip` asks for 30 s, `/clip 60` for the minute. */
  onClip?: (seconds: ClipLength) => Promise<string>
  /** Plan 186 S7: the banners `/banner` reads, and its show or hide. */
  banners?: readonly BannerSummary[] | null
  onBanner?: (action: BannerRelayAction) => Promise<boolean>
  /** Plan 189 S9: the board `/sound` reads, and its press or Stop all. */
  sounds?: SoundboardSummary | null
  onSound?: (action: SoundRelayAction) => Promise<boolean>
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

  const [unread, setUnread] = useState(0)
  const [incomplete, setIncomplete] = useState(false)
  const arrivalRef = useRef({ key: arrivalKey, cursor: deliveryCursor(delivery) })
  // Newest at the bottom, and the list stays there (hooks/use-chat-follow.ts):
  // only the streamer scrolling up stops it, and reaching the bottom (or the
  // jump chip) follows again with nothing unread.
  const clearUnread = useCallback((): void => {
    setUnread(0)
    setIncomplete(false)
  }, [])
  const { pinned, pinnedRef, stick, follow, release } = useChatFollow(viewport, {
    onFollow: clearUnread
  })

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
  }, [arrivalKey, delivery, filter, mentionNames, pinnedRef, questionMessageIds])
  // A new newest message while following: show it before the frame paints.
  // The bottom of the viewport, not the virtualizer's index scroll, whose
  // settle loop could pull a streamer who just scrolled up back down.
  const newestId = shown.at(-1)?.id
  useLayoutEffect(() => {
    if (pinnedRef.current) stick()
  }, [newestId, pinnedRef, shown.length, stick])

  // Buddy's "jump to message": clear filters that hide it, then scroll there.
  // The streamer asked for it, so the list stops following until they come
  // back down or press the jump chip.
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
    release()
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [filtering, jumpTo, release, shown, virtualizer])

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
              <ShortcutTooltip label="Messages behind Buddy's open questions">
                <ToggleGroupItem className="text-xs" value="questions">
                  Questions
                </ToggleGroupItem>
              </ShortcutTooltip>
            ) : null}
            <ShortcutTooltip label="Messages that @mention your channel">
              <ToggleGroupItem className="text-xs" value="mentions">
                Mentions
              </ToggleGroupItem>
            </ShortcutTooltip>
          </ToggleGroup>
        </div>
        {/* Below 640 px the same filters live in one menu. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Chat filters"
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
            placeholder="Search chat…"
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
        {/* The follow owns this scroll position, so the browser's own scroll
            anchoring stays out of it. */}
        <ScrollArea
          ref={rootRef}
          className="min-h-0 flex-1 px-2 py-1"
          viewportClassName="[overflow-anchor:none]"
        >
          {shown.length === 0 ? (
            filtering ? (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyDescription>No messages match these filters.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <OffAir live={live} providers={providers} />
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
        {!pinned ? (
          // Whenever the list is not on the newest message, one way back.
          // A glass chip, not an ad-hoc pill (plan 174 H-17): the Badge is
          // the button.
          <Badge asChild className="absolute inset-x-0 bottom-2 mx-auto">
            <button
              aria-label={`Chat paused: ${incomplete ? 'New chat' : unread > 0 ? `${unread} new` : 'reading back'}. Jump to the newest`}
              data-testid="chat-paused"
              type="button"
              onClick={follow}
            >
              {incomplete ? 'New chat' : unread > 0 ? `${unread} new` : 'Latest'}
              <ArrowDownIcon data-icon="inline-end" />
            </button>
          </Badge>
        ) : null}
      </div>

      {composerVisible && onSend ? (
        <Composer
          markerContext={markerContext}
          onMarker={onMarker}
          onUndoMarker={onUndoMarker}
          onClip={onClip}
          banners={banners}
          onBanner={onBanner}
          sounds={sounds}
          onSound={onSound}
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

/** The composer's own commands, in the order the completion list offers them. */
const COMPOSER_COMMANDS: readonly ComposerCompletion[] = [
  { value: '/marker', hint: ' [title] · Save a timeline point' },
  { value: '/clip', hint: ' · Save the last seconds as a clip' },
  // Plan 199 D6: the 1-minute clip.
  { value: '/clip 60', hint: ' · Save the last minute as a clip' },
  { value: '/banner', hint: ' [name] · Show or hide a banner' },
  { value: '/sound', hint: ' [name] · Play a sound' },
  { value: '/help', hint: ' · Command help' }
]

/** The commands that take an argument, and go on to its completions. */
const COMMANDS_WITH_ARGUMENT = new Set(['/marker', '/banner', '/sound'])
/** The commands whose completions are names (plans 186, 189). */
const COMMANDS_WITH_NAMES = new Set(['/banner', '/sound'])
/** No sounds before Studio has read the board: the same empty board. */
const NO_SOUNDBOARD: SoundboardSummary = { sounds: [], voices: [] }

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
  onUndoMarker,
  onClip,
  banners,
  onBanner,
  sounds,
  onSound
}: {
  markerContext?: MarkerContext | null
  onMarker?: (label?: string) => Promise<SessionMarker>
  onUndoMarker?: (marker: SessionMarker) => Promise<void>
  onClip?: (seconds: ClipLength) => Promise<string>
  /**
   * Plan 186 S7: `/banner <name>` shows or hides one of these, `/banner off`
   * hides them all. Resolves false when it didn't happen; the window has
   * said why. Never posts to chat.
   */
  banners?: readonly BannerSummary[] | null
  onBanner?: (action: BannerRelayAction) => Promise<boolean>
  /**
   * Plan 189 S9: `/sound <name>` presses the first sound whose name starts
   * with it, `/sound stop` stops them all. Resolves false when it didn't
   * happen; the window has said why. Never posts to chat.
   */
  sounds?: SoundboardSummary | null
  onSound?: (action: SoundRelayAction) => Promise<boolean>
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
  const bannerList = onBanner ? (banners ?? []) : null
  const soundBoard = onSound ? (sounds ?? NO_SOUNDBOARD) : null
  const command = classifyComposerDraft(draft, bannerList ?? [], soundBoard?.sounds ?? [])
  const local = command.kind !== 'chat'
  const clipContext = markerContext?.clip
  const canSend = local
    ? !localPending &&
      (command.kind !== 'marker' ||
        Boolean((markerContext?.available || markerContext?.retryAvailable) && onMarker)) &&
      (command.kind !== 'clip' || Boolean(clipContext?.available && onClip))
    : targets.length > 0 && !pending
  // Under `/banner` and `/sound`, the names (plans 186, 189); otherwise the commands.
  const completions: readonly ComposerCompletion[] =
    (bannerList && bannerCompletions(draft, bannerList)) ??
    (soundBoard && soundCompletions(draft, soundBoard)) ??
    COMPOSER_COMMANDS.filter(
      (entry) =>
        draft.startsWith('/') &&
        !draft.includes(' ') &&
        (bannerList || entry.value !== '/banner') &&
        (soundBoard || entry.value !== '/sound') &&
        entry.value.startsWith(draft.toLowerCase())
    )
  const showCompletions = completions.length > 0 && !completionDismissed
  const selectedCompletion = completions[completionIndex] ?? completions[0]
  const complete = (value: string): void => {
    setDraft(value + (COMMANDS_WITH_ARGUMENT.has(value) ? ' ' : ''))
    // `/banner` and `/sound` go straight on to the names (plans 186, 189).
    setCompletionDismissed(!COMMANDS_WITH_NAMES.has(value))
    setCompletionIndex(0)
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
        `/marker [title] saves a point on this recording or livestream. /clip saves the last ${clipSeconds(clipContext)} as a clip, and /clip 60 the last ${clipSeconds(clipContext, true)}.${onBanner ? ' /banner [name] shows or hides a banner, and /banner off hides them all.' : ''}${onSound ? ' /sound [name] plays a sound, and /sound stop stops them all.' : ''} // sends a literal slash to chat. Markers are in Library → Session actions → Markers.`
      )
      return
    }
    if (command.kind === 'clip') {
      // Plan 181 R4: the Clip button's action from the keyboard. The
      // streamer's own composer only; chat never triggers it.
      if (!clipContext?.available || !onClip) {
        setNotice(clipOffNotice(clipContext))
        return
      }
      const submitted = draft
      localPendingRef.current = true
      setLocalPending(true)
      // Plan 199: the notice names the length asked for.
      setNotice(`Saving the last ${clipSeconds(clipContext, command.seconds === 60)} as a clip…`)
      void onClip(command.seconds)
        .then((outcome) => {
          setNotice(outcome)
          if (draftRef.current === submitted) setDraft('')
        })
        .catch((error) =>
          setNotice(error instanceof Error ? error.message : "Couldn't save the clip.")
        )
        .finally(() => {
          localPendingRef.current = false
          setLocalPending(false)
        })
      return
    }
    if (command.kind === 'banner') {
      if (!onBanner) return
      const submitted = draft
      localPendingRef.current = true
      setLocalPending(true)
      setNotice(null)
      // The picture is the confirmation; a refusal is the window's toast.
      void onBanner(command.action)
        .then((done) => {
          if (done && draftRef.current === submitted) setDraft('')
        })
        .finally(() => {
          localPendingRef.current = false
          setLocalPending(false)
        })
      return
    }
    if (command.kind === 'sound') {
      if (!onSound) return
      const submitted = draft
      localPendingRef.current = true
      setLocalPending(true)
      setNotice(null)
      // The pad's ring is the confirmation; a refusal is the window's toast.
      void onSound(command.action)
        .then((done) => {
          if (done && draftRef.current === submitted) setDraft('')
        })
        .finally(() => {
          localPendingRef.current = false
          setLocalPending(false)
        })
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
            error instanceof Error ? error.message : "Couldn't save marker. Retry this command."
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
    // A flush region under a hairline (plan 174 H-18): no box, no card inside.
    <div className="shrink-0 border-t border-border px-2 py-2" data-slot="chat-composer">
      <div className="flex flex-col">
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
                ? 'Message, /marker [title] or /clip…'
                : '/marker [title], /clip · Local commands'
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
                  (event.key === 'Enter' &&
                    draft.trim().toLowerCase() !== selectedCompletion.value.toLowerCase()))
              ) {
                event.preventDefault()
                complete(selectedCompletion.value)
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
            value={selectedCompletion.value}
            className="mt-1"
            aria-label="Local commands"
          >
            <CommandList>
              {completions.map(({ value, hint }) => (
                <CommandItem key={value} value={value} onSelect={() => complete(value)}>
                  {value}
                  {value === '/clip'
                    ? ` · Save the last ${clipSeconds(clipContext)} as a clip`
                    : hint}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        ) : null}
        {/* Only while it matters (plan 174 H-24): Buddy still connecting to
            hear markers, or why it cannot. Working, or off, says nothing. */}
        {markerContext?.available &&
        (markerContext.voice?.state === 'starting' || markerContext.voice?.message) ? (
          <p className="mt-1 text-[11px] text-muted-foreground" data-slot="marker-voice-status">
            {markerContext.voice?.state === 'starting'
              ? 'Buddy is connecting to hear marker commands…'
              : markerContext.voice?.message}
          </p>
        ) : null}
        {notice ? (
          <div role="status" className="mt-1 text-xs text-muted-foreground">
            {notice}
            {savedMarker && onUndoMarker ? (
              <Button
                variant="ghost"
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
                      setNotice(error instanceof Error ? error.message : "Couldn't remove marker.")
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge className="max-w-full truncate">Sending…</Badge>
        </TooltipTrigger>
        <TooltipContent>{operation.text}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The empty chat (plan 174 H-12): one short line that is true now. While
 * live it says chat is connected (or what a destination still needs); off
 * air it says how chat starts.
 */
function OffAir({
  live,
  providers
}: {
  live: boolean
  providers: readonly LiveChatProviderState[]
}): ReactElement {
  const text = live
    ? liveChatEmptyMessage(
        { providers: [...providers] },
        'No destination on this livestream has chat.',
        'Chat is connected. New messages appear here.'
      )
    : 'Start a livestream to see chat here.'
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyDescription data-testid="chat-empty">{text}</EmptyDescription>
      </EmptyHeader>
      <CommentsDestinationStatus providers={[...providers]} />
    </Empty>
  )
}
