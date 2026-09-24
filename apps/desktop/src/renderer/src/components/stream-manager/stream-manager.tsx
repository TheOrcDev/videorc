import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import { toast } from 'sonner'

import { CohostPane } from '@/components/cohost-pane'
import { CohostStatus } from '@/components/cohost-status'
import { ActivityPane } from '@/components/stream-manager/activity-pane'
import {
  ChatPane,
  type ChatPrefill,
  type ChatSendOptions
} from '@/components/stream-manager/chat-pane'
import { StatsBar } from '@/components/stream-manager/stats-bar'
import { StreamManagerStatusBar } from '@/components/stream-manager/stream-manager-status-bar'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTrafficLightGutter } from '@/components/window-frame'
import type {
  CohostFlag,
  CohostQuestion,
  CohostState,
  CommentHighlightAnchor,
  CommentHighlightState,
  CommentsHistoryStats,
  CommentsSendOperation,
  CommentsViewMode,
  LiveChatMessage,
  LiveChatSnapshot,
  ViewerSample
} from '@/lib/backend'
import type { ChatSendFailure } from '@/lib/chat-send'
import { useCohostSensitivity } from '@/hooks/use-cohost-sensitivity'
import { cohostGroupedDeltaFlash } from '@/lib/cohost-presence'
import {
  cohostCommentMarks,
  cohostNudgeVisible,
  cohostQuestionToast,
  cohostStateForSensitivity,
  draftForQuestion,
  COHOST_QUESTION_TOAST_ID
} from '@/lib/cohost-view'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { CHAT_HEADER_CONTAINER } from '@/lib/chat-header-tiers'
import { sortMessagesChronological } from '@/lib/live-chat-view'
import { activityItems, thankYouDraft, type ActivityItem } from '@/lib/stream-activity'
import { statItems } from '@/lib/stream-manager-stats'
import {
  BELOW_WIDE,
  PANES_GRID,
  STREAM_MANAGER_CONTAINER,
  WIDE_ONLY,
  paneClasses,
  type StreamManagerPane,
  type StreamManagerRightPane
} from '@/lib/stream-manager-layout'
import { sendablePlatforms } from '@/lib/chat-send'
import { detectedPlatform, isMacPlatform } from '@/lib/platform'
import { cn } from '@/lib/utils'

import type { LiveDashboardState } from '../../../../shared/live-dashboard'

/** ⌘J on macOS, Ctrl+J elsewhere; the key handler below accepts both. */
const ORCLE_SHORTCUT = isMacPlatform(detectedPlatform()) ? '⌘J' : 'Ctrl+J'

/** True while the element is laid out and on screen (a hidden pane is not). */
function usePaneVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) =>
      setVisible(entries.some((entry) => entry.isIntersecting))
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return visible
}

/** Items that arrived while a pane was out of sight. */
function useUnseen(count: number, visible: boolean): number {
  const [seen, setSeen] = useState(count)
  useEffect(() => {
    // Seen while on screen; a cleared view restarts the count from zero.
    if (visible || count < seen) setSeen(count)
  }, [count, seen, visible])
  return visible ? 0 : Math.max(0, count - seen)
}

function cohostTone(state: CohostState | null): StatusDotTone {
  switch (state?.status) {
    case 'listening':
      return 'good'
    case 'paused':
      return 'warn'
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
}

function PaneLabel({
  label,
  unseen,
  dot
}: {
  label: string
  unseen: number
  dot?: StatusDotTone
}): ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      {dot ? <StatusDot tone={dot} /> : null}
      {label}
      {unseen > 0 ? (
        <Badge
          className="h-4 px-1.5 text-[10px] tabular-nums"
          data-slot="pane-unseen"
          variant="outline"
        >
          {unseen > 99 ? '99+' : unseen}
        </Badge>
      ) : null}
    </span>
  )
}

export interface StreamManagerProps {
  snapshot: LiveChatSnapshot
  viewMode?: CommentsViewMode
  history?: CommentsHistoryStats
  dashboard: LiveDashboardState | null
  viewerSample?: ViewerSample | null
  alwaysOnTop?: boolean
  onToggleAlwaysOnTop?: () => void
  highlightAnchor?: CommentHighlightAnchor
  onHighlightAnchorChange?: (anchor: CommentHighlightAnchor) => void
  highlightedId?: string | null
  highlightState?: CommentHighlightState
  highlightApplyingId?: string | null
  highlightFailure?: { messageId: string; reason: string } | null
  onBackToLive?: () => void
  onHighlight?: (message: LiveChatMessage) => void
  onClear?: () => void
  onOpenPreview?: () => void
  sendPending?: boolean
  sendOperation?: CommentsSendOperation | null
  sendFailures?: ChatSendFailure[]
  onSend?: (text: string, options?: ChatSendOptions) => void
  cohostState?: CohostState | null
  cohostGate?: EntitlementUiGate
  cohostConsented?: boolean
  cohostEnabled?: boolean
  cohostActionPending?: boolean
  cohostStarting?: boolean
  cohostNudgeDismissedForever?: boolean
  onCohostEnable?: (enabled: boolean) => void
  onCohostNudgeDismiss?: () => void
  onCohostShowOnStream?: (question: CohostQuestion) => void
  onCohostAnswered?: (question: CohostQuestion) => void
  onCohostDismissQuestion?: (question: CohostQuestion) => void
  onCohostDismissFlag?: (flag: CohostFlag) => void
  onCohostEnableConsent?: () => void
  onCohostUpgrade?: (url: string) => void
}

// The Stream Manager (plan 055): the Chat window grown into a live dashboard.
// One window, three widths (D1): the layout follows the window body's own
// width through container queries, and every pane renders exactly once.
export function StreamManager({
  snapshot,
  viewMode,
  history,
  dashboard,
  viewerSample = null,
  alwaysOnTop = false,
  onToggleAlwaysOnTop,
  highlightAnchor,
  onHighlightAnchorChange,
  highlightedId = null,
  highlightState,
  highlightApplyingId = null,
  highlightFailure = null,
  onBackToLive,
  onHighlight,
  onClear,
  onOpenPreview,
  sendPending = false,
  sendOperation = null,
  sendFailures = [],
  onSend,
  cohostState = null,
  cohostGate,
  cohostConsented = false,
  cohostEnabled = false,
  cohostActionPending = false,
  cohostStarting = false,
  cohostNudgeDismissedForever = false,
  onCohostEnable,
  onCohostNudgeDismiss,
  onCohostShowOnStream,
  onCohostAnswered,
  onCohostDismissQuestion,
  onCohostDismissFlag,
  onCohostEnableConsent,
  onCohostUpgrade
}: StreamManagerProps): ReactElement {
  const trafficLightGutter = useTrafficLightGutter()
  const messages = useMemo(() => sortMessagesChronological(snapshot.messages), [snapshot.messages])
  const inHistory = viewMode?.kind === 'history'
  const live = !inHistory && Boolean(snapshot.sessionId)
  const mode = inHistory ? 'History' : live ? 'Live' : messages.length > 0 ? 'History' : 'Idle'

  // One clock: seconds while on air (the session clock), slow otherwise.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const onAir =
    !inHistory && dashboard?.session.state !== undefined && dashboard.session.state !== 'off-air'
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), onAir ? 1_000 : 15_000)
    return () => clearInterval(timer)
  }, [onAir])

  // --- Orcle (unchanged behaviour, moved into its own pane: D5) ---
  const cohostSensitivity = useCohostSensitivity()
  const shownCohostState = useMemo(
    () => cohostStateForSensitivity(cohostState, cohostSensitivity),
    [cohostSensitivity, cohostState]
  )
  const cohostMarks = useMemo(() => cohostCommentMarks(shownCohostState), [shownCohostState])
  const cohostPresent = cohostGate !== undefined
  const cohostVisible = cohostState !== null && cohostPresent && mode === 'Live'
  const [cohostFlash, setCohostFlash] = useState<string | null>(null)
  const [cohostExpand, setCohostExpand] = useState(0)
  const cohostPaneOpenRef = useRef(true)
  const previousCohostStateRef = useRef<CohostState | null>(null)
  const cohostToastAtRef = useRef<number | null>(null)
  const [cohostNudgeDismissedSessionId, setCohostNudgeDismissedSessionId] = useState<string | null>(
    null
  )
  useEffect(() => {
    const previous = previousCohostStateRef.current
    if (!cohostState) return
    previousCohostStateRef.current = cohostState
    const questionToast = cohostQuestionToast({
      previous,
      next: cohostState,
      paneOpen: cohostPaneOpenRef.current,
      lastToastAtMs: cohostToastAtRef.current,
      nowMs: Date.now(),
      shortcut: ORCLE_SHORTCUT
    })
    if (questionToast) {
      cohostToastAtRef.current = questionToast.atMs
      toast(questionToast.message, { id: COHOST_QUESTION_TOAST_ID })
    }
    const delta = cohostGroupedDeltaFlash(previous, cohostState)
    if (delta) setCohostFlash(delta)
  }, [cohostState])
  useEffect(() => {
    if (!cohostFlash) return
    const timer = setTimeout(() => setCohostFlash(null), 2_000)
    return () => clearTimeout(timer)
  }, [cohostFlash])
  const cohostNudge =
    cohostGate !== undefined &&
    cohostNudgeVisible({
      sessionId: mode === 'Live' ? (snapshot.sessionId ?? null) : null,
      gateAllowed: cohostGate.allowed,
      consented: cohostConsented,
      enabled: cohostEnabled,
      dismissedForever: cohostNudgeDismissedForever,
      dismissedSessionId: cohostNudgeDismissedSessionId
    })
  const dismissCohostNudge = useCallback(
    (persist: boolean) => {
      setCohostNudgeDismissedSessionId(snapshot.sessionId ?? null)
      if (persist) onCohostNudgeDismiss?.()
    },
    [onCohostNudgeDismiss, snapshot.sessionId]
  )
  const questionMessageIds = useMemo(
    () => new Set((shownCohostState?.questions ?? []).flatMap((question) => question.messageIds)),
    [shownCohostState]
  )

  // --- Panes (D1): one segmented pick below Wide, a right pane at Wide ---
  const [narrowPane, setNarrowPane] = useState<StreamManagerPane>('chat')
  const [rightPane, setRightPane] = useState<StreamManagerRightPane>('activity')
  const [prefill, setPrefill] = useState<ChatPrefill | null>(null)
  const [jumpTo, setJumpTo] = useState<{ messageId: string; seq: number } | null>(null)
  const [searchFocus, setSearchFocus] = useState(0)
  const chatRef = useRef<HTMLDivElement>(null)
  const activityRef = useRef<HTMLDivElement>(null)
  const orcleRef = useRef<HTMLDivElement>(null)
  const chatVisible = usePaneVisible(chatRef)
  const activityVisible = usePaneVisible(activityRef)
  const orcleVisible = usePaneVisible(orcleRef)
  useEffect(() => {
    cohostPaneOpenRef.current = orcleVisible
  }, [orcleVisible])

  const items = useMemo(
    () => activityItems(messages, inHistory ? [] : (dashboard?.destinationEvents ?? [])),
    [dashboard?.destinationEvents, inHistory, messages]
  )
  const chatCount = useMemo(
    () => messages.filter((message) => message.eventType !== 'follow').length,
    [messages]
  )
  const chatUnseen = useUnseen(chatCount, chatVisible)
  const activityUnseen = useUnseen(items.length, activityVisible)
  const orcleUnseen = useUnseen(shownCohostState?.questions.length ?? 0, orcleVisible)

  const mentionNames = useMemo(
    () =>
      snapshot.providers
        .map((provider) => provider.accountLabel)
        .filter((name): name is string => Boolean(name)),
    [snapshot.providers]
  )
  const stats = useMemo(
    () =>
      statItems({
        dashboard: inHistory ? null : dashboard,
        viewerSample: inHistory ? null : viewerSample,
        messages,
        providers: snapshot.providers,
        nowMs,
        ...(viewMode?.kind === 'history'
          ? {
              history: {
                stats: history,
                startedAt: viewMode.startedAt,
                title: viewMode.title
              }
            }
          : {})
      }),
    [dashboard, history, inHistory, messages, nowMs, snapshot.providers, viewMode, viewerSample]
  )

  const showOrcle = useCallback((): void => {
    setNarrowPane('orcle')
    setRightPane('orcle')
    setCohostExpand((value) => value + 1)
  }, [])

  // ⌘J focuses Orcle wherever it sits; ⌘F searches chat. The pane is shown
  // first, so its own focus handling lands on a visible element.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'j' && cohostVisible) {
        event.preventDefault()
        showOrcle()
      } else if (key === 'f') {
        event.preventDefault()
        setNarrowPane('chat')
        setSearchFocus((value) => value + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cohostVisible, showOrcle])

  const sendTargets = sendablePlatforms(snapshot.providers)
  const thankInChat = (item: ActivityItem): void => {
    const text = thankYouDraft(item)
    if (!text) return
    setPrefill((current) => ({ seq: (current?.seq ?? 0) + 1, text }))
    setNarrowPane('chat')
  }
  const showActivityOnStream = (item: ActivityItem): void => {
    const message = messages.find((candidate) => candidate.id === item.messageId)
    if (message) onHighlight?.(message)
  }

  const orclePane = cohostPresent ? (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="orcle-pane">
      <div
        className={cn(
          CHAT_HEADER_CONTAINER,
          'flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-3'
        )}
        data-slot="orcle-pane-header"
      >
        <span className="text-xs font-medium">Orcle</span>
        <span className="flex-1" />
        <CohostStatus
          consented={cohostConsented}
          enabled={cohostEnabled}
          flash={cohostFlash}
          gate={cohostGate!}
          nowMs={nowMs}
          starting={cohostStarting}
          state={cohostState}
          onEnable={onCohostEnable}
          onEnableConsent={onCohostEnableConsent}
          onOpenPane={() => setCohostExpand((value) => value + 1)}
          onUpgrade={onCohostUpgrade}
        />
      </div>
      {cohostVisible ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CohostPane
            actionPending={cohostActionPending}
            consented={cohostConsented}
            enabled={cohostEnabled}
            expandSignal={cohostExpand}
            flash={cohostFlash}
            gate={cohostGate!}
            highlightedMessageId={highlightedId}
            starting={cohostStarting}
            state={shownCohostState}
            onAnswered={(question) => onCohostAnswered?.(question)}
            onDismissFlag={(flag) => onCohostDismissFlag?.(flag)}
            onDismissQuestion={(question) => onCohostDismissQuestion?.(question)}
            onEnableConsent={onCohostEnableConsent}
            onJumpToMessage={(messageId) => {
              setNarrowPane('chat')
              setJumpTo((current) => ({ messageId, seq: (current?.seq ?? 0) + 1 }))
            }}
            onReply={(question) => {
              setPrefill((current) => ({
                seq: (current?.seq ?? 0) + 1,
                text: draftForQuestion(question, sendTargets),
                questionId: question.id
              }))
              setNarrowPane('chat')
            }}
            onShowOnStream={onCohostShowOnStream}
            onUpgrade={onCohostUpgrade}
          />
        </div>
      ) : (
        <Empty className="border-0 p-6">
          <EmptyHeader>
            <EmptyDescription>
              Orcle listens to chat during a live stream: questions, flags and the room's mood.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  ) : null

  return (
    // No background: the window frame paints the content coat (plan 050).
    <div
      className={cn(STREAM_MANAGER_CONTAINER, 'relative flex h-screen flex-col text-foreground')}
      data-slot="stream-manager"
    >
      {/* The title row: the title only (owner call, 2026-09-23). Fixed height:
          the traffic lights are centred on this strip. The stats bar says
          On air, and History has its own bar (plan 057). */}
      <header
        className={cn(
          'flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b border-border pr-3 [-webkit-app-region:drag]',
          trafficLightGutter
        )}
        data-slot="chat-header"
      >
        <span className="shrink-0 truncate text-xs font-medium" data-slot="stream-manager-title">
          Stream Manager
        </span>
      </header>

      {viewMode?.kind === 'history' ? (
        <div
          className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs"
          data-slot="history-bar"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {viewMode.title} · {new Date(viewMode.startedAt).toLocaleDateString()}
          </span>
          {onBackToLive ? (
            <Button
              className="shrink-0"
              size="xs"
              type="button"
              variant="ghost"
              onClick={onBackToLive}
            >
              Back to live
            </Button>
          ) : null}
        </div>
      ) : null}

      <StatsBar items={stats} />

      <div className={PANES_GRID} data-slot="stream-manager-panes">
        {/* Below Wide: one segmented control picks the pane. */}
        <div
          className={cn(
            'row-start-1 flex items-center border-b border-border px-2 py-1.5',
            BELOW_WIDE
          )}
          data-slot="pane-tabs-narrow"
        >
          <Tabs
            value={narrowPane}
            onValueChange={(value) => setNarrowPane(value as StreamManagerPane)}
          >
            <TabsList>
              <TabsTrigger value="chat">
                <PaneLabel label="Chat" unseen={chatUnseen} />
              </TabsTrigger>
              <TabsTrigger value="activity">
                <PaneLabel label="Activity" unseen={activityUnseen} />
              </TabsTrigger>
              {cohostPresent ? (
                <TabsTrigger value="orcle">
                  <PaneLabel dot={cohostTone(cohostState)} label="Orcle" unseen={orcleUnseen} />
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </div>
        {/* At Wide: Chat on the left, Activity · Orcle on the right. */}
        <div
          className={cn(
            'col-start-2 row-start-1 items-center border-b border-l border-border px-2 py-1.5',
            WIDE_ONLY
          )}
          data-slot="pane-tabs-wide"
        >
          <Tabs
            value={rightPane}
            onValueChange={(value) => setRightPane(value as StreamManagerRightPane)}
          >
            <TabsList>
              <TabsTrigger value="activity">
                <PaneLabel label="Activity" unseen={activityUnseen} />
              </TabsTrigger>
              {cohostPresent ? (
                <TabsTrigger value="orcle">
                  <PaneLabel dot={cohostTone(cohostState)} label="Orcle" unseen={orcleUnseen} />
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </div>

        <div
          ref={chatRef}
          className={cn('min-h-0 flex-col', paneClasses('chat', narrowPane, rightPane))}
          data-pane="chat"
        >
          <ChatPane
            className="flex"
            cohostFlags={cohostVisible ? cohostMarks.flags : undefined}
            cohostNudge={cohostNudge}
            cohostSuggested={cohostVisible ? cohostMarks.suggested : undefined}
            highlightApplyingId={highlightApplyingId}
            highlightFailure={highlightFailure}
            highlightState={highlightState}
            highlightedId={highlightedId}
            jumpTo={jumpTo}
            live={live}
            mentionNames={mentionNames}
            messages={messages}
            prefill={prefill}
            providers={snapshot.providers}
            questionMessageIds={questionMessageIds}
            searchFocusSignal={searchFocus}
            sendFailures={sendFailures}
            sendOperation={sendOperation}
            sendPending={sendPending}
            onCohostNudgeDismiss={() => dismissCohostNudge(true)}
            onCohostNudgeTurnOn={() => {
              dismissCohostNudge(false)
              onCohostEnable?.(true)
            }}
            onHighlight={live ? onHighlight : undefined}
            onSend={onSend}
          />
        </div>
        <div
          ref={activityRef}
          className={cn('min-h-0 flex-col', paneClasses('activity', narrowPane, rightPane))}
          data-pane="activity"
        >
          <ActivityPane
            className="flex"
            items={items}
            nowMs={nowMs}
            providers={snapshot.providers}
            onShowOnStream={live && onHighlight ? showActivityOnStream : undefined}
            onThank={live && onSend ? thankInChat : undefined}
          />
        </div>
        {orclePane ? (
          <div
            ref={orcleRef}
            className={cn('min-h-0 flex-col', paneClasses('orcle', narrowPane, rightPane))}
            data-pane="orcle"
          >
            {orclePane}
          </div>
        ) : null}
      </div>

      <StreamManagerStatusBar
        alwaysOnTop={alwaysOnTop}
        audience={inHistory ? (history?.audience ?? null) : (dashboard?.audience ?? null)}
        highlightAnchor={onHighlightAnchorChange ? highlightAnchor : undefined}
        providers={snapshot.providers}
        onClear={onClear}
        onHighlightAnchorChange={onHighlightAnchorChange}
        onOpenPreview={onOpenPreview}
        onToggleAlwaysOnTop={onToggleAlwaysOnTop}
      />
    </div>
  )
}
