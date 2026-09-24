import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'

import { ChatPlatformIcon, CHAT_PLATFORM_LABELS } from '@/components/chat-platform-icon'
import { CohostNudge } from '@/components/cohost-nudge'
import { CommentRow, commentHighlightPresentationForMessage } from '@/components/comment-row'
import { CommentsDestinationStatus } from '@/components/comments-destination-status'
import { ChatIcon, ChevronDownIcon, SearchIcon, SendIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type {
  CohostFlag,
  CohostState,
  CommentHighlightState,
  CommentsSendOperation,
  LiveChatMessage,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'
import { chatDraftMaxChars, validateChatDraft, type ChatSendFailure } from '@/lib/chat-send'
import {
  chatPaneMessages,
  pickedSendProviders,
  writableProviders,
  type ChatPaneFilter
} from '@/lib/stream-manager-chat'
import { liveChatEmptyMessage } from '@/lib/live-chat-view'
import { ABOVE_NARROW, NARROW_ONLY } from '@/lib/stream-manager-layout'
import { cn } from '@/lib/utils'

const BOTTOM_THRESHOLD_PX = 64

export interface ChatPrefill {
  seq: number
  text: string
  /** A reply to an Orcle question: a real send marks it answered. */
  questionId?: string
}

export interface ChatSendOptions {
  inReplyToQuestionId?: string
  destinationIds?: string[]
}

export function ChatPane({
  messages,
  providers,
  live,
  className,
  highlightedId = null,
  highlightState,
  highlightApplyingId = null,
  highlightFailure = null,
  cohostFlags,
  cohostSuggested,
  questionMessageIds,
  mentionNames,
  onHighlight,
  sendPending = false,
  sendOperation = null,
  sendFailures = [],
  onSend,
  prefill = null,
  cohostState = null,
  cohostNudge = false,
  onCohostNudgeTurnOn,
  onCohostNudgeDismiss,
  jumpTo = null,
  searchFocusSignal = 0
}: {
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
  /** Messages behind Orcle's open questions (the Questions filter). */
  questionMessageIds: ReadonlySet<string>
  /** The streamer's own account names (the Mentions filter). */
  mentionNames: readonly string[]
  onHighlight?: (message: LiveChatMessage) => void
  sendPending?: boolean
  sendOperation?: CommentsSendOperation | null
  sendFailures?: ChatSendFailure[]
  onSend?: (text: string, options?: ChatSendOptions) => void
  prefill?: ChatPrefill | null
  cohostState?: CohostState | null
  cohostNudge?: boolean
  onCohostNudgeTurnOn?: () => void
  onCohostNudgeDismiss?: () => void
  /** Orcle "jump to message": scroll there and stop following new chat. */
  jumpTo?: { messageId: string; seq: number } | null
  /** Bumped by ⌘F in the window. */
  searchFocusSignal?: number
}): ReactElement {
  const [filter, setFilter] = useState<ChatPaneFilter>({
    platform: 'all',
    questions: false,
    mentions: false,
    search: ''
  })
  // One prefill stream for the composer: the window's (Orcle Reply, Thank in
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
  const previousCount = useRef(shown.length)
  useEffect(() => {
    if (!viewport) return
    const onScroll = (): void => {
      const atBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX
      pinnedRef.current = atBottom
      setPinned(atBottom)
      if (atBottom) setUnread(0)
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [viewport])

  // Follow new chat while pinned; count it while the streamer reads back.
  useEffect(() => {
    const added = shown.length - previousCount.current
    previousCount.current = shown.length
    if (shown.length === 0) return
    if (pinnedRef.current) {
      virtualizer.scrollToIndex(shown.length - 1, { align: 'end' })
    } else if (added > 0) {
      setUnread((value) => value + added)
    }
  }, [shown.length, virtualizer])

  const jumpToLatest = useCallback((): void => {
    pinnedRef.current = true
    setPinned(true)
    setUnread(0)
    if (shown.length > 0) virtualizer.scrollToIndex(shown.length - 1, { align: 'end' })
  }, [shown.length, virtualizer])

  // Orcle's "jump to message": clear filters that hide it, then scroll there.
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

  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchFocusSignal > 0) searchRef.current?.focus()
  }, [searchFocusSignal])

  const composerVisible = Boolean(onSend) && live

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
          {platforms.length > 1 ? (
            <ToggleGroup
              aria-label="Show chat from"
              size="sm"
              type="single"
              value={filter.platform}
              onValueChange={(value) =>
                setFilter((current) => ({
                  ...current,
                  platform: (value || 'all') as StreamPlatform | 'all'
                }))
              }
            >
              <ToggleGroupItem className="h-6 px-2 text-xs" value="all">
                All
              </ToggleGroupItem>
              {platforms.map((platform) => (
                <ToggleGroupItem
                  key={platform}
                  aria-label={CHAT_PLATFORM_LABELS[platform]}
                  className="h-6 min-w-6 px-1.5"
                  title={`Only ${CHAT_PLATFORM_LABELS[platform]}`}
                  value={platform}
                >
                  <ChatPlatformIcon decorative platform={platform} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
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
            <ToggleGroupItem
              className="h-6 px-2 text-xs"
              title="Messages behind Orcle's open questions"
              value="questions"
            >
              Questions
            </ToggleGroupItem>
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
                <Badge className="h-4 px-1.5 text-[10px]" variant="outline">
                  {activeFilterCount}
                </Badge>
              ) : null}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {platforms.length > 1 ? (
              <>
                <DropdownMenuLabel>Show chat from</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filter.platform}
                  onValueChange={(value) =>
                    setFilter((current) => ({
                      ...current,
                      platform: value as StreamPlatform | 'all'
                    }))
                  }
                >
                  <DropdownMenuRadioItem value="all">Every platform</DropdownMenuRadioItem>
                  {platforms.map((platform) => (
                    <DropdownMenuRadioItem key={platform} value={platform}>
                      <ChatPlatformIcon decorative platform={platform} />
                      {CHAT_PLATFORM_LABELS[platform]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuGroup>
              <DropdownMenuCheckboxItem
                checked={filter.questions}
                onCheckedChange={(checked) =>
                  setFilter((current) => ({ ...current, questions: checked === true }))
                }
              >
                Questions
              </DropdownMenuCheckboxItem>
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
        <InputGroup className="h-7 min-w-28 flex-1 basis-40" data-slot="chat-search">
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
            <Kbd>⌘F</Kbd>
          </InputGroupAddon>
        </InputGroup>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea ref={rootRef} className="min-h-0 flex-1 px-2 py-1">
          {shown.length === 0 ? (
            filtering ? (
              <Empty className="h-full border-0 p-6">
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
            >
              {virtualizer.getVirtualItems().map((item) => {
                const message = shown[item.index]
                if (!message) return null
                return (
                  <CommentRow
                    key={item.key}
                    ref={virtualizer.measureElement}
                    cohostFlag={cohostFlags?.get(message.id)}
                    cohostSuggested={cohostSuggested?.has(message.id) ?? false}
                    density="comfortable"
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
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                      paddingBottom: 4
                    }}
                    onHighlight={live ? onHighlight : undefined}
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
        {!pinned && unread > 0 ? (
          <Button
            className="absolute inset-x-0 bottom-2 mx-auto h-6 w-fit rounded-full px-2.5 text-xs text-foreground glass-chip hover:text-foreground"
            data-slot="chat-paused"
            size="sm"
            type="button"
            variant="ghost"
            onClick={jumpToLatest}
          >
            Chat paused · {unread} new ↓
          </Button>
        ) : null}
      </div>

      {composerVisible && onSend ? (
        <Composer
          cohostNudge={cohostNudge}
          cohostState={cohostState}
          failures={sendFailures}
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

function Composer({
  providers,
  pending,
  failures,
  operation,
  prefill,
  cohostState,
  cohostNudge,
  onCohostNudgeTurnOn,
  onCohostNudgeDismiss,
  onSend
}: {
  providers: readonly LiveChatProviderState[]
  pending: boolean
  failures: ChatSendFailure[]
  operation: CommentsSendOperation | null
  prefill: ChatPrefill | null
  cohostState: CohostState | null
  cohostNudge: boolean
  onCohostNudgeTurnOn?: () => void
  onCohostNudgeDismiss?: () => void
  onSend: (text: string, options?: ChatSendOptions) => void
}): ReactElement {
  const [draft, setDraft] = useState('')
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
  const canSend = targets.length > 0 && !pending

  useEffect(() => {
    if (!prefill || prefill.seq === appliedPrefillRef.current) return
    appliedPrefillRef.current = prefill.seq
    setDraft(prefill.text)
    setReplyToQuestionId(prefill.questionId ?? null)
    inputRef.current?.focus()
  }, [prefill])

  const submit = (): void => {
    const text = validateChatDraft(draft, maxChars)
    if (!text || !canSend) return
    onSend(text, {
      ...(replyToQuestionId ? { inReplyToQuestionId: replyToQuestionId } : {}),
      ...(picked ? { destinationIds: targets.map((provider) => provider.id) } : {})
    })
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
          {writable.length > 1 ? (
            <InputGroupAddon>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton
                    aria-label={`Send to: ${pickLabel}`}
                    data-slot="chat-send-to"
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
            aria-label="Send a message to all writable destinations"
            disabled={writable.length === 0}
            maxLength={maxChars}
            placeholder={writable.length > 0 ? 'Send a message…' : 'No writable destinations'}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              if (event.target.value.trim().length === 0) setReplyToQuestionId(null)
            }}
            onKeyDown={(event) => {
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
                  'text-[11px] tabular-nums',
                  draft.trim().length > maxChars ? 'text-destructive' : 'text-subtle'
                )}
              >
                {draft.trim().length}/{maxChars}
              </span>
            ) : null}
            <Kbd aria-label="Enter">↵</Kbd>
            <InputGroupButton
              aria-label={pending ? 'Sending message' : 'Send message to all writable destinations'}
              disabled={!canSend || !validateChatDraft(draft, maxChars)}
              size="icon-xs"
              onClick={submit}
            >
              <SendIcon data-icon="inline-end" weight="fill" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {replyToQuestionId ? (
          <p className="mt-1 text-[11px] text-subtle">
            Replying to a question Orcle found. Edit freely, nothing sends until you do.
          </p>
        ) : null}
        <div className="mt-1.5">
          <CommentsDestinationStatus
            cohostState={cohostState}
            failures={failures}
            mode="composer"
            providers={[...providers]}
            sendTargets={targetPlatforms}
          />
          {cohostNudge && onCohostNudgeDismiss && onCohostNudgeTurnOn ? (
            <CohostNudge onDismiss={onCohostNudgeDismiss} onTurnOn={onCohostNudgeTurnOn} />
          ) : null}
          {operation ? <DeliveryStatus operation={operation} /> : null}
        </div>
      </div>
    </div>
  )
}

function DeliveryStatus({ operation }: { operation: CommentsSendOperation }): ReactElement {
  return (
    <div className="mt-1.5 flex flex-col gap-1" aria-label="Latest message delivery">
      <Badge
        className="max-w-full truncate"
        title={operation.text}
        variant={
          operation.phase === 'sent'
            ? 'success'
            : operation.phase === 'failed' || operation.phase === 'delivery-unknown'
              ? 'destructive'
              : 'secondary'
        }
      >
        You · {operation.text} · {operation.phase.replace('-', ' ')}
      </Badge>
      <div className="flex flex-wrap gap-1">
        {operation.destinations.map((destination) => (
          <Badge
            key={destination.destinationId}
            title={destination.reason}
            variant={
              destination.phase === 'sent'
                ? 'success'
                : destination.phase === 'failed' || destination.phase === 'timed-out-unknown'
                  ? 'destructive'
                  : destination.phase === 'pending'
                    ? 'warning'
                    : 'outline'
            }
          >
            <ChatPlatformIcon decorative platform={destination.platform} />
            {CHAT_PLATFORM_LABELS[destination.platform]} ·{' '}
            {destination.phase === 'timed-out-unknown'
              ? 'Unknown'
              : destination.phase === 'read-only'
                ? 'Receive-only'
                : destination.phase === 'pending'
                  ? 'Sending…'
                  : destination.phase.charAt(0).toUpperCase() + destination.phase.slice(1)}
          </Badge>
        ))}
      </div>
    </div>
  )
}

function OffAir({ providers }: { providers: readonly LiveChatProviderState[] }): ReactElement {
  return (
    <Empty className="h-full border-0 p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChatIcon weight="duotone" />
        </EmptyMedia>
        <EmptyTitle className="text-base">No messages yet</EmptyTitle>
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
