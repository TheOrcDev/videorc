import { ChatCircle, Eye, PaperPlaneRight, PushPin } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { CohostPane } from '@/components/cohost-pane'
import { CommentRow, commentHighlightPresentationForMessage } from '@/components/comment-row'
import { CommentsDestinationStatus } from '@/components/comments-destination-status'
import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import type {
  CohostFlag,
  CohostQuestion,
  CohostState,
  CommentHighlightState,
  CommentsSendOperation,
  CommentsViewMode,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot,
  StreamPlatform,
  ViewerSample
} from '@/lib/backend'
import { chatDraftMaxChars, validateChatDraft, type ChatSendFailure } from '@/lib/chat-send'
import { draftForQuestion } from '@/lib/cohost-view'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { liveChatEmptyMessage, sortMessagesChronological } from '@/lib/live-chat-view'
import { cn } from '@/lib/utils'
import { viewerChipDetail, viewerChipLabel, viewerSampleStale } from '@/lib/viewer-count-view'

const BOTTOM_THRESHOLD_PX = 64

function scrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
}

// The detached Comments window is a glanceable, larger-text reader for a
// second monitor. It deliberately shares CommentRow with the dense in-app
// panel so platform identity, paid state, and on-stream state cannot drift.
export function CommentsReader({
  snapshot,
  onClear,
  alwaysOnTop = false,
  onToggleAlwaysOnTop,
  highlightedId = null,
  highlightState,
  highlightApplyingId = null,
  highlightFailure = null,
  viewMode,
  onBackToLive,
  onHighlight,
  sendTargets = [],
  sendPending = false,
  sendOperation = null,
  sendFailures = [],
  onSend,
  viewerSample = null,
  cohostState = null,
  cohostGate,
  cohostConsented = false,
  cohostEnabled = false,
  cohostActionPending = false,
  onCohostShowOnStream,
  onCohostAnswered,
  onCohostDismissQuestion,
  onCohostDismissFlag,
  onCohostEnableConsent,
  onCohostUpgrade
}: {
  snapshot: LiveChatSnapshot
  onClear?: () => void
  alwaysOnTop?: boolean
  onToggleAlwaysOnTop?: () => void
  /** Latest live concurrent-viewer sample; null hides the chip. */
  viewerSample?: ViewerSample | null
  /** The comment currently shown on the stream. */
  highlightedId?: string | null
  highlightState?: CommentHighlightState
  highlightApplyingId?: string | null
  /** A failed command is local UI feedback; it never replaces backend overlay truth. */
  highlightFailure?: { messageId: string; reason: string } | null
  viewMode?: CommentsViewMode
  onBackToLive?: () => void
  /** Click a viewer comment to show, replace, or remove it on the stream. */
  onHighlight?: (message: LiveChatMessage) => void
  /** Platforms the shared composer reaches right now. */
  sendTargets?: StreamPlatform[]
  sendPending?: boolean
  sendOperation?: CommentsSendOperation | null
  sendFailures?: ChatSendFailure[]
  onSend?: (text: string, options?: { inReplyToQuestionId?: string }) => void
  /**
   * Latest `cohost.state`. The relay always supplies a concrete state now —
   * `offCohostState()` when the engine is off or has not reported yet — so
   * presence is knowable from the first frame. Null is still tolerated for
   * backward compat and hides the Co-host segment entirely.
   */
  cohostState?: CohostState | null
  cohostGate?: EntitlementUiGate
  cohostConsented?: boolean
  cohostEnabled?: boolean
  cohostActionPending?: boolean
  onCohostShowOnStream?: (question: CohostQuestion) => void
  onCohostAnswered?: (question: CohostQuestion) => void
  onCohostDismissQuestion?: (question: CohostQuestion) => void
  onCohostDismissFlag?: (flag: CohostFlag) => void
  onCohostEnableConsent?: () => void
  onCohostUpgrade?: (url: string) => void
}): ReactElement {
  const messages = sortMessagesChronological(snapshot.messages)
  const live = Boolean(snapshot.sessionId)
  const mode =
    viewMode?.kind === 'history'
      ? 'History'
      : live
        ? 'Live'
        : messages.length > 0
          ? 'History'
          : 'Idle'
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [pinned, setPinned] = useState(true)
  const [unread, setUnread] = useState(0)
  const previousCount = useRef(messages.length)
  // Reply is a PREFILL, never a send: the co-host draft lands in the shared
  // composer, editable, and carries the question id so a real send marks it
  // answered. `seq` re-applies the same draft after an edit + another Reply.
  const [replyPrefill, setReplyPrefill] = useState<{
    seq: number
    text: string
    questionId: string
  } | null>(null)
  const cohostVisible =
    cohostState !== null &&
    cohostGate !== undefined &&
    mode === 'Live' &&
    viewMode?.kind !== 'history'

  useEffect(() => {
    if (!viewerSample) return
    const timer = setInterval(() => setNowMs(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [viewerSample])

  useEffect(() => {
    const viewport = scrollViewport(scrollRootRef.current)
    viewportRef.current = viewport
    if (!viewport) return

    const handleScroll = (): void => {
      const atBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX
      setPinned(atBottom)
      if (atBottom) setUnread(0)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const added = messages.length - previousCount.current
    previousCount.current = messages.length
    const viewport = viewportRef.current
    if (pinned) {
      viewport?.scrollTo({ top: viewport.scrollHeight })
    } else if (added > 0) {
      setUnread((value) => value + added)
    }
  }, [messages.length, pinned])

  const scrollToMessage = (messageId: string): void => {
    const viewport = viewportRef.current
    const row = viewport?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!row) return
    setPinned(false)
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const jumpToLatest = (): void => {
    const viewport = viewportRef.current
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
    setPinned(true)
    setUnread(0)
  }

  return (
    <div className="relative flex h-screen flex-col bg-background text-foreground">
      <header className="flex min-h-10 shrink-0 items-center gap-2 pl-[78px] pr-3 [-webkit-app-region:drag]">
        <span className="shrink-0 text-xs font-medium">Comments</span>
        <Badge
          className="h-4 shrink-0 px-1.5 text-[10px]"
          variant={mode === 'Live' ? 'success' : mode === 'History' ? 'secondary' : 'outline'}
        >
          {mode}
        </Badge>
        {viewMode?.kind === 'history' ? (
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            {viewMode.title} · {new Date(viewMode.startedAt).toLocaleDateString()}
          </span>
        ) : onClear ? (
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            Clear view keeps Library history.
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {viewerSample ? (
          <span
            className={cn(
              'flex items-center gap-1 text-xs tabular-nums',
              viewerSampleStale(viewerSample, nowMs) ? 'text-subtle' : 'text-foreground'
            )}
            title={viewerChipDetail(viewerSample)}
          >
            <Eye aria-hidden className="size-3.5 shrink-0" weight="duotone" />
            {viewerChipLabel(viewerSample)}
          </span>
        ) : null}
        <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          {viewMode?.kind === 'history' && onBackToLive ? (
            <Button size="sm" type="button" variant="ghost" onClick={onBackToLive}>
              Back to live
            </Button>
          ) : null}
          {onToggleAlwaysOnTop ? (
            <Button
              aria-label="Keep this window on top"
              aria-pressed={alwaysOnTop}
              className={cn(alwaysOnTop && 'text-foreground')}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={onToggleAlwaysOnTop}
            >
              <PushPin data-icon="inline-start" weight={alwaysOnTop ? 'fill' : 'regular'} />
            </Button>
          ) : null}
          {onClear ? (
            <Button size="sm" type="button" variant="ghost" onClick={onClear}>
              Clear view
            </Button>
          ) : null}
        </div>
      </header>
      <Separator />

      {cohostVisible ? (
        <div className="shrink-0 px-3 pt-2">
          <CohostPane
            actionPending={cohostActionPending}
            consented={cohostConsented}
            enabled={cohostEnabled}
            gate={cohostGate!}
            highlightedMessageId={highlightedId}
            state={cohostState}
            onAnswered={(question) => onCohostAnswered?.(question)}
            onDismissFlag={(flag) => onCohostDismissFlag?.(flag)}
            onDismissQuestion={(question) => onCohostDismissQuestion?.(question)}
            onEnableConsent={onCohostEnableConsent}
            onJumpToMessage={scrollToMessage}
            onReply={(question) =>
              setReplyPrefill((current) => ({
                seq: (current?.seq ?? 0) + 1,
                text: draftForQuestion(question, sendTargets),
                questionId: question.id
              }))
            }
            onShowOnStream={onCohostShowOnStream}
            onUpgrade={onCohostUpgrade}
          />
        </div>
      ) : null}

      <ScrollArea ref={scrollRootRef} className="min-h-0 flex-1 px-3 py-2">
        {messages.length === 0 ? (
          <OffAir providers={snapshot.providers} />
        ) : (
          <ol aria-label="Comments" className="flex flex-col gap-1">
            {messages.map((message) => (
              <CommentRow
                key={message.id}
                density="comfortable"
                highlight={commentHighlightPresentationForMessage({
                  messageId: message.id,
                  highlightedId,
                  state: highlightState,
                  applyingId: highlightApplyingId,
                  failure: highlightFailure
                })}
                message={message}
                onHighlight={
                  mode === 'Live' && viewMode?.kind !== 'history' ? onHighlight : undefined
                }
              />
            ))}
          </ol>
        )}
      </ScrollArea>

      {unread > 0 ? (
        <Button
          className={cn(
            'absolute inset-x-0 mx-auto w-fit shadow-soft',
            onSend && mode === 'Live' ? 'bottom-16' : 'bottom-3'
          )}
          size="sm"
          type="button"
          variant="secondary"
          onClick={jumpToLatest}
        >
          {unread} new {unread === 1 ? 'comment' : 'comments'} ↓
        </Button>
      ) : null}

      {onSend && mode === 'Live' && viewMode?.kind !== 'history' ? (
        <SendRow
          cohostState={cohostState}
          failures={sendFailures}
          operation={sendOperation}
          pending={sendPending}
          prefill={replyPrefill}
          providers={snapshot.providers}
          targets={sendTargets}
          onSend={onSend}
        />
      ) : null}
    </div>
  )
}

function SendRow({
  targets,
  providers,
  pending,
  failures,
  operation,
  prefill,
  cohostState,
  onSend
}: {
  targets: StreamPlatform[]
  providers: LiveChatProviderState[]
  pending: boolean
  failures: ChatSendFailure[]
  operation: CommentsSendOperation | null
  prefill: { seq: number; text: string; questionId: string } | null
  cohostState: CohostState | null
  onSend: (text: string, options?: { inReplyToQuestionId?: string }) => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  // The question a draft is answering. Cleared as soon as the streamer clears
  // the box — a reply must never be attributed to a question it no longer
  // answers.
  const [replyToQuestionId, setReplyToQuestionId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const appliedPrefillRef = useRef(0)
  // Per-platform caps: the draft must fit the STRICTEST destination it reaches.
  const maxChars = chatDraftMaxChars(targets)
  const canSend = targets.length > 0 && !pending

  useEffect(() => {
    if (!prefill || prefill.seq === appliedPrefillRef.current) return
    appliedPrefillRef.current = prefill.seq
    setDraft(prefill.text)
    setReplyToQuestionId(prefill.questionId)
    inputRef.current?.focus()
  }, [prefill])

  const submit = (): void => {
    const text = validateChatDraft(draft, maxChars)
    if (!text || !canSend) return
    onSend(text, replyToQuestionId ? { inReplyToQuestionId: replyToQuestionId } : undefined)
    setDraft('')
    setReplyToQuestionId(null)
  }

  return (
    <div className="shrink-0 px-3 py-2">
      <Separator className="mb-2" />
      <InputGroup>
        <InputGroupInput
          ref={inputRef}
          aria-label="Send a comment to all writable destinations"
          disabled={targets.length === 0}
          maxLength={maxChars}
          placeholder={
            targets.length > 0 ? 'Message writable destinations…' : 'No writable destinations'
          }
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
            aria-label={pending ? 'Sending comment' : 'Send comment to all writable destinations'}
            disabled={!canSend || !validateChatDraft(draft, maxChars)}
            size="icon-xs"
            onClick={submit}
          >
            <PaperPlaneRight data-icon="inline-end" weight="fill" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {replyToQuestionId ? (
        <p className="mt-1 text-[11px] text-subtle">
          Replying to a co-host question — edit freely, nothing sends until you do.
        </p>
      ) : null}
      <div className="mt-1.5">
        <CommentsDestinationStatus
          cohostState={cohostState}
          failures={failures}
          mode="composer"
          providers={providers}
          sendTargets={targets}
        />
        {operation ? (
          <div className="mt-1.5 flex flex-col gap-1" aria-label="Latest comment delivery">
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
        ) : null}
      </div>
    </div>
  )
}

function OffAir({ providers }: { providers: LiveChatProviderState[] }): ReactElement {
  return (
    <Empty className="h-full border-0 p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChatCircle weight="duotone" />
        </EmptyMedia>
        <EmptyTitle className="text-base">No comments yet</EmptyTitle>
        <EmptyDescription>
          {liveChatEmptyMessage({ providers }, 'Start a livestream to see comments here.')}
        </EmptyDescription>
      </EmptyHeader>
      <CommentsDestinationStatus providers={providers} />
    </Empty>
  )
}
