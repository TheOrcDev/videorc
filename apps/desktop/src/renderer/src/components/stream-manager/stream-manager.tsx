import {
  chatDeliveryActivityMatches,
  chatDeliveryProgress,
  deliveryCursor,
  type ChatDelivery,
  type ChatDeliveryMessage
} from '../../../../shared/chat-delivery'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import { toast } from '@/lib/toast'

import { CohostListenPrompt, CohostPane } from '@/components/cohost-pane'
import { CohostListeningIndicator, CohostStatus } from '@/components/cohost-status'
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
  CohostPromise,
  CohostQuestion,
  CohostSayHi,
  CohostState,
  CohostUtteranceState,
  CohostWindowGolem,
  CommentHighlightAnchor,
  CommentHighlightState,
  CommentsHistoryStats,
  CommentsSendOperation,
  CommentsViewMode,
  LiveChatMessage,
  LiveChatSnapshot,
  ModerationOperation,
  ScopeReconnectPlatform,
  ViewerSample
} from '@/lib/backend'
import { isActivityOnlyEvent } from '@/lib/backend'
import type { ChatSendFailure } from '@/lib/chat-send'
import { useCohostSensitivity } from '@/hooks/use-cohost-sensitivity'
import { cohostGroupedDeltaFlash } from '@/lib/cohost-presence'
import { activeCohostSpotlight, cohostCommentMarks } from '@/lib/cohost-marks'
import {
  cohostDeadAirToast,
  cohostNudgeVisible,
  cohostPromiseReminderToast,
  cohostQuestionToast,
  cohostStateForSensitivity,
  draftForQuestion,
  COHOST_DEAD_AIR_TOAST_ID,
  COHOST_PROMISE_TOAST_ID,
  COHOST_QUESTION_TOAST_ID
} from '@/lib/cohost-view'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { CHAT_HEADER_CONTAINER } from '@/lib/chat-header-tiers'
import { sortMessagesChronological } from '@/lib/live-chat-view'
import { activityItems, thankYouDraft, type ActivityItem } from '@/lib/stream-activity'
import { statItems } from '@/lib/stream-manager-stats'
import {
  browserStorage,
  loadStatsLayout,
  saveStatsLayout,
  type StatsLayout
} from '@/lib/stream-manager-stats-layout'
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
import { cn } from '@/lib/utils'
import { RemoveMessagesReconnectRows } from '@/components/stream-manager/remove-messages-reconnect'
import { RemovalCards } from '@/components/stream-manager/removal-cards'
import {
  CommandCards,
  CommandStrip,
  type CommandAnswer
} from '@/components/stream-manager/command-cards'
import { commandChooserView, commandConfirmView, commandStripView } from '@/lib/orcle-command-view'
import {
  removalPaneView,
  removeFromChatAvailable,
  type RemovalAnswer
} from '@/lib/chat-removal-view'

import type { LiveDashboardState } from '../../../../shared/live-dashboard'
import { removeMessagesReconnectPlatforms } from '../../../../shared/platform-scopes'
import { latestModerationOperationByMessage } from '../../../../shared/chat-moderation'

/**
 * ⌘J on macOS, Ctrl+J elsewhere; the key handler below accepts both. Electron's
 * user agent names the host OS, as lib/platform.ts reads it for toasts. Read
 * here, not imported: importing that module moves it into the chunk this
 * window shares with the main window and grows the main window's eager bytes.
 */
const ORCLE_SHORTCUT = /Macintosh/.test(globalThis.navigator?.userAgent ?? '') ? '⌘J' : 'Ctrl+J'

const NO_MODERATION_OPERATIONS: readonly ModerationOperation[] = []

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

/** Delivery progress is independent of the bounded painted rows. Non-chat
 * activity and questions use fresh current identities, not length growth. */
function useUnseen(
  delivery: ChatDelivery | undefined,
  key: string,
  visible: boolean,
  matches: (message: ChatDeliveryMessage) => boolean,
  ids: readonly string[] = []
): { count: number; incomplete: boolean } {
  const [unseen, setUnseen] = useState({ count: 0, incomplete: false })
  const previous = useRef({ key, cursor: deliveryCursor(delivery), ids: new Set(ids) })
  useEffect(() => {
    const prior = previous.current
    const sameKey = prior.key === key
    const progress = chatDeliveryProgress(delivery, sameKey ? prior.cursor : null, matches)
    const addedIds = sameKey ? ids.filter((id) => !prior.ids.has(id)).length : 0
    previous.current = { key, cursor: progress.cursor, ids: new Set(ids) }
    if (visible || !sameKey || (delivery && progress.reset)) {
      setUnseen((value) =>
        value.count || value.incomplete ? { count: 0, incomplete: false } : value
      )
    } else if (progress.count + addedIds > 0 || progress.incomplete) {
      setUnseen((value) => ({
        count: value.count + progress.count + addedIds,
        incomplete: value.incomplete || progress.incomplete
      }))
    }
  }, [delivery, ids, key, matches, visible])
  return visible ? { count: 0, incomplete: false } : unseen
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
  dot,
  onStream = false
}: {
  label: string
  unseen: { count: number; incomplete: boolean }
  dot?: StatusDotTone
  /** Something only this pane shows is on stream (plan 095, D1). */
  onStream?: boolean
}): ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      {dot ? <StatusDot tone={dot} /> : null}
      {onStream ? (
        <span className="flex" data-slot="pane-on-stream" title="On stream">
          <StatusDot tone="good" />
          <span className="sr-only">On stream:</span>
        </span>
      ) : null}
      {label}
      {unseen.count > 0 || unseen.incomplete ? (
        <Badge
          className="h-4 px-1.5 text-[10px] tabular-nums"
          data-slot="pane-unseen"
          variant="outline"
        >
          {unseen.incomplete ? 'New' : unseen.count > 99 ? '99+' : unseen.count}
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
  /** Mark the current moment for a clip (plan 068 D6); shown only on air. */
  markerContext?: import('@/lib/backend').MarkerContext | null
  onMarker?: (label?: string) => Promise<import('@/lib/backend').SessionMarker>
  onUndoMarker?: (marker: import('@/lib/backend').SessionMarker) => Promise<void>
  onMarkClip?: () => void
  onOpenPreview?: () => void
  /** Show who followed (plan 071, S2): reconnect Twitch with its follow
   * permission, relayed to the main window. */
  onShowFollowNames?: () => void
  /** Auto-show Activity celebrations on stream (plan 156): the one switch,
   * owned by Electron main; the Studio renderer runs the engine. */
  autoShowActivity?: boolean
  onAutoShowActivityChange?: (on: boolean) => void
  /** Reconnect Twitch or Kick so Golem can remove messages (plan 140, S5);
   * Electron main starts it. Rows show only while live. */
  onReconnectScopes?: (platform: ScopeReconnectPlatform) => void
  /** The live session's chat removals (plan 140, S6), relayed by Studio:
   * row chips, and Golem's removal cards in the Golem pane. */
  moderationOperations?: readonly ModerationOperation[]
  /** "Remove from chat" asked for, before any operation answered. */
  removalRequestIds?: ReadonlySet<string>
  /** Cards whose answer is on its way. */
  removalAnsweringIds?: ReadonlySet<string>
  /** ⋯ Remove from chat on a row, or on a flagged message: a manual removal. */
  onRemoveFromChat?: (message: LiveChatMessage) => void
  /** Remove or Cancel on a Golem removal card. */
  onAnswerRemoval?: (operation: ModerationOperation, answer: RemovalAnswer) => void
  /** Answer Golem's open voice command (plan 140, S6 part B): pick from the
   * chooser, or Show / Cancel a flagged highlight. */
  onAnswerCommand?: (commandId: string, answer: CommandAnswer) => void
  /** The command whose answer is on its way. */
  commandAnsweringId?: string | null
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
  /** Persisted `cohost.settings.listen` (plan 068); unknown hides its card. */
  cohostListen?: boolean
  /** The Golem on stream (plan 164 S-C4): the pane's header shows and
   * operates it; absent hides the header. */
  cohostGolem?: CohostWindowGolem
  /** A Golem action is on its way through the relay. */
  golemPending?: boolean
  /** Say something in the bubble (D7): ↵ talks, ⌘↵ laughs. */
  onGolemSay?: (text: string, state: CohostUtteranceState) => Promise<void> | void
  /** `overlayLayout.golem.showOnStream`, through the Studio relay. */
  onGolemShowOnStream?: (showOnStream: boolean) => void
  /** Golem Live's one switch (plan 119), from the status popover and the
   * nudge: on means Golem reads chat and hears you, off only stops it. */
  onCohostEnable?: (enabled: boolean) => void
  /** Turn listening on from the one-time card (plan 068 D3). */
  onCohostListenOn?: () => void
  onCohostNudgeDismiss?: () => void
  onCohostShowOnStream?: (question: CohostQuestion) => void
  onCohostAnswered?: (question: CohostQuestion) => void
  onCohostRestoreQuestion?: (question: CohostQuestion) => void
  onCohostDismissQuestion?: (question: CohostQuestion) => void
  onCohostDismissFlag?: (flag: CohostFlag) => void
  /** Promises and recaps (plan 068 D8). The draft resolves with the relayed
   * state; its `recap.text` pre-fills the composer. */
  onCohostPromiseDone?: (promise: CohostPromise) => void
  onCohostPromiseDismiss?: (promise: CohostPromise) => void
  onCohostRecapDismiss?: () => void
  onCohostRecapDraft?: () => Promise<CohostState | null>
  /** The Greeted button on a "Say hi" row (plan 068 D9). */
  onCohostAuthorGreeted?: (entry: CohostSayHi) => void
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
  onMarkClip,
  markerContext,
  onMarker,
  onUndoMarker,
  onOpenPreview,
  onShowFollowNames,
  autoShowActivity = false,
  onAutoShowActivityChange,
  onReconnectScopes,
  moderationOperations = NO_MODERATION_OPERATIONS,
  removalRequestIds,
  removalAnsweringIds,
  onRemoveFromChat,
  onAnswerRemoval,
  onAnswerCommand,
  commandAnsweringId = null,
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
  cohostListen,
  cohostGolem,
  golemPending = false,
  onGolemSay,
  onGolemShowOnStream,
  onCohostEnable,
  onCohostListenOn,
  onCohostNudgeDismiss,
  onCohostShowOnStream,
  onCohostAnswered,
  onCohostRestoreQuestion,
  onCohostDismissQuestion,
  onCohostDismissFlag,
  onCohostPromiseDone,
  onCohostPromiseDismiss,
  onCohostRecapDismiss,
  onCohostRecapDraft,
  onCohostAuthorGreeted,
  onCohostEnableConsent,
  onCohostUpgrade
}: StreamManagerProps): ReactElement {
  const trafficLightGutter = useTrafficLightGutter()
  const messages = useMemo(() => sortMessagesChronological(snapshot.messages), [snapshot.messages])
  // The message on stream now (plan 095, S2): the backend's live state when
  // it has one. Chat, Activity and Golem all read this one slot.
  const liveHighlightId =
    highlightState?.phase === 'live' ? (highlightState.messageId ?? null) : highlightedId
  const inHistory = viewMode?.kind === 'history'
  const live = !inHistory && Boolean(snapshot.sessionId)
  const mode = inHistory ? 'History' : live ? 'Live' : messages.length > 0 ? 'History' : 'Idle'

  // One clock: seconds while on air (the session clock) or while a removal
  // card counts down, slow otherwise.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const onAir =
    !inHistory && dashboard?.session.state !== undefined && dashboard.session.state !== 'off-air'
  // Chat removals (plan 140, S6): each row's newest removal, and Golem's
  // cards and their result lines. History never has any.
  const removalOperations = live ? moderationOperations : NO_MODERATION_OPERATIONS
  const removals = useMemo(
    () => latestModerationOperationByMessage(removalOperations),
    [removalOperations]
  )
  const removalPane = removalPaneView(removalOperations, nowMs, removalAnsweringIds)
  // Golem voice commands (plan 140, S6 part B): the strip, the chooser and
  // the "show it anyway?" card, from the latest command. Live only.
  const command = live ? (cohostState?.command ?? null) : null
  const commandStrip = commandStripView(command, nowMs)
  const commandChooser = commandChooserView(command, nowMs)
  const commandConfirm = commandConfirmView(
    command,
    nowMs,
    command !== null && command.id === commandAnsweringId
  )
  const commandCardId = commandChooser || commandConfirm ? (command?.id ?? '') : ''
  const orcleCardsActive = removalPane.active || commandStrip !== null || commandCardId !== ''
  useEffect(() => {
    const timer = setInterval(
      () => setNowMs(Date.now()),
      onAir || orcleCardsActive ? 1_000 : 15_000
    )
    return () => clearInterval(timer)
  }, [onAir, orcleCardsActive])

  // --- Golem (unchanged behaviour, moved into its own pane: D5) ---
  const cohostSensitivity = useCohostSensitivity()
  const shownCohostState = useMemo(
    () => cohostStateForSensitivity(cohostState, cohostSensitivity),
    [cohostSensitivity, cohostState]
  )
  // The spotlight also expires on the window's clock, so a missed clearing
  // event never leaves a stale "Talking about this" behind. Keyed on a boolean,
  // not the clock, so the list only re-renders when the mark changes.
  const spotlightLive = activeCohostSpotlight(shownCohostState, nowMs) !== null
  const cohostMarks = useMemo(() => {
    const marks = cohostCommentMarks(shownCohostState)
    return spotlightLive || !marks.spotlight ? marks : { ...marks, spotlight: null }
  }, [shownCohostState, spotlightLive])
  const cohostPresent = cohostGate !== undefined
  const cohostVisible = cohostState !== null && cohostPresent && mode === 'Live'
  const [cohostFlash, setCohostFlash] = useState<string | null>(null)
  const [cohostExpand, setCohostExpand] = useState(0)
  const cohostPaneOpenRef = useRef(true)
  const previousCohostStateRef = useRef<CohostState | null>(null)
  const cohostToastAtRef = useRef<number | null>(null)
  const deadAirToastKeyRef = useRef<string | null>(null)
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
    // A met promise trigger (plan 068 D8): private, keyed, once per promise.
    const reminder = cohostPromiseReminderToast({ previous, next: cohostState })
    if (reminder) toast(reminder, { id: COHOST_PROMISE_TOAST_ID })
    // Dead air (plan 068 D9): private, keyed, each nudge once.
    const deadAir = cohostDeadAirToast(cohostState, deadAirToastKeyRef.current)
    if (deadAir) {
      deadAirToastKeyRef.current = deadAir.key
      toast(deadAir.text, { id: COHOST_DEAD_AIR_TOAST_ID })
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

  const activityAudience = inHistory ? (history?.audience ?? null) : (dashboard?.audience ?? null)
  const items = useMemo(
    () =>
      activityItems(
        messages,
        inHistory ? [] : (dashboard?.destinationEvents ?? []),
        activityAudience
      ),
    [activityAudience, dashboard?.destinationEvents, inHistory, messages]
  )
  const arrivalKey = `${viewMode?.kind ?? 'live'}:${snapshot.sessionId ?? ''}`
  const chatUnseen = useUnseen(
    inHistory ? undefined : snapshot.delivery,
    arrivalKey,
    chatVisible,
    (message) => !isActivityOnlyEvent(message.eventType)
  )
  const communityGifts = new Set([
    ...messages.flatMap((message) =>
      message.details?.kind === 'subscription' &&
      message.details.subscription === 'community-sub-gift' &&
      !message.isDeleted &&
      message.details.communityGiftId
        ? [message.details.communityGiftId]
        : []
    ),
    ...(snapshot.delivery?.entries.flatMap(({ message }) =>
      message.gift === 'community' && message.communityGiftId && !message.isDeleted
        ? [message.communityGiftId]
        : []
    ) ?? [])
  ])
  const activityUnseen = useUnseen(
    inHistory ? undefined : snapshot.delivery,
    arrivalKey,
    activityVisible,
    (message) => chatDeliveryActivityMatches(message, communityGifts),
    inHistory ? [] : items.filter((item) => !item.messageId).map((item) => item.id)
  )
  // A follow, Power-up or redemption on stream has no chat row to say so
  // (plan 095, D1; plan 162): while Activity sits behind a tab, its tab
  // carries the success dot.
  const activityOnStream =
    !activityVisible &&
    liveHighlightId !== null &&
    messages.some(
      (message) => message.id === liveHighlightId && isActivityOnlyEvent(message.eventType)
    )
  const orcleUnseen = useUnseen(
    undefined,
    `${arrivalKey}:${cohostSensitivity}`,
    orcleVisible,
    () => false,
    shownCohostState?.questions.map((question) => question.id) ?? []
  )

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
        sessionId: viewMode?.kind === 'history' ? viewMode.sessionId : (snapshot.sessionId ?? null),
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
    [
      dashboard,
      history,
      inHistory,
      messages,
      nowMs,
      snapshot.providers,
      snapshot.sessionId,
      viewMode,
      viewerSample
    ]
  )

  // The streamer's own order and picks for the stats bar (plan 057, D2).
  const [statsLayout, setStatsLayout] = useState(() => loadStatsLayout(browserStorage()))
  const changeStatsLayout = useCallback((next: StatsLayout): void => {
    setStatsLayout(next)
    saveStatsLayout(browserStorage(), next)
  }, [])

  const showOrcle = useCallback((): void => {
    setNarrowPane('orcle')
    setRightPane('orcle')
    setCohostExpand((value) => value + 1)
  }, [])

  // A new Golem removal card brings the Golem pane forward when it sits behind
  // a tab, without taking focus from the composer. Once the cards and their
  // result lines are gone, the pane the streamer was on comes back, unless
  // they moved on themselves.
  const orcleCardIds = [
    ...removalPane.cards.map((card) => card.operationId),
    ...(commandCardId ? [commandCardId] : [])
  ].join(' ')
  const seenRemovalCardsRef = useRef<Set<string>>(new Set())
  const revealedFromRef = useRef<{
    narrow: StreamManagerPane
    right: StreamManagerRightPane
  } | null>(null)
  useEffect(() => {
    const ids = orcleCardIds ? orcleCardIds.split(' ') : []
    const fresh = ids.filter((id) => !seenRemovalCardsRef.current.has(id))
    for (const id of fresh) seenRemovalCardsRef.current.add(id)
    if (fresh.length === 0 || orcleVisible || !cohostPresent) return
    revealedFromRef.current ??= { narrow: narrowPane, right: rightPane }
    setNarrowPane('orcle')
    setRightPane('orcle')
  }, [cohostPresent, narrowPane, orcleVisible, orcleCardIds, rightPane])
  useEffect(() => {
    const from = revealedFromRef.current
    if (orcleCardsActive || !from) return
    revealedFromRef.current = null
    setNarrowPane((current) => (current === 'orcle' ? from.narrow : current))
    setRightPane((current) => (current === 'orcle' ? from.right : current))
  }, [orcleCardsActive])

  // ⌘J focuses Golem wherever it sits; ⌘F searches chat. The pane is shown
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

  // Flagged messages Remove from chat can act on: still in chat, removable,
  // and with no removal in flight.
  const flaggedIds = (shownCohostState?.flags ?? []).map((flag) => flag.messageId).join(' ')
  const removableFlaggedIds = useMemo(() => {
    const removable = new Set<string>()
    if (!live || !onRemoveFromChat || !flaggedIds) return removable
    const flagged = new Set(flaggedIds.split(' '))
    for (const message of messages) {
      if (
        flagged.has(message.id) &&
        removeFromChatAvailable(
          message,
          removals.get(message.id),
          removalRequestIds?.has(message.id) ?? false
        )
      ) {
        removable.add(message.id)
      }
    }
    return removable
  }, [flaggedIds, live, messages, onRemoveFromChat, removalRequestIds, removals])
  const removeFlagged = (flag: CohostFlag): void => {
    const message = messages.find((candidate) => candidate.id === flag.messageId)
    if (message) onRemoveFromChat?.(message)
  }

  const sendTargets = sendablePlatforms(snapshot.providers)
  // Pre-fill only: the composer is the one place a send starts (plan 068 D8).
  const prefillComposer = (text: string): void => {
    setPrefill((current) => ({ seq: (current?.seq ?? 0) + 1, text }))
    setNarrowPane('chat')
  }
  const thankInChat = (item: ActivityItem): void => {
    const text = thankYouDraft(item)
    if (!text) return
    prefillComposer(text)
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
        <span className="shrink-0 text-xs font-medium">Golem</span>
        {/* Whether Golem hears you (plan 068); nothing while listening is off. */}
        {cohostVisible ? <CohostListeningIndicator listening={cohostState?.listening} /> : null}
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
      {/* Plan 140, S6: what Golem heard and did, what waits for an answer
          (the chooser, "show it anyway?"), then what Golem is about to remove
          because you asked, and how to stop it. Above the scroll, so none of
          it scrolls away. */}
      <CommandStrip view={commandStrip} />
      {onAnswerCommand ? (
        <CommandCards
          chooser={commandChooser}
          confirm={commandConfirm}
          onAnswer={onAnswerCommand}
        />
      ) : null}
      {onAnswerRemoval ? (
        <RemovalCards
          view={removalPane}
          onAnswer={(operationId, answer) => {
            const operation = removalOperations.find(
              (candidate) => candidate.operationId === operationId
            )
            if (operation) onAnswerRemoval(operation, answer)
          }}
        />
      ) : null}
      {/* Plan 140, S5: a quiet row per platform whose account must be
          reconnected before Golem can remove messages there. Live only. */}
      {live && onReconnectScopes ? (
        <RemoveMessagesReconnectRows
          platforms={removeMessagesReconnectPlatforms(snapshot.providers)}
          onReconnect={onReconnectScopes}
        />
      ) : null}
      {/* The one-time listening card (plan 068 D3), on air or off, above the
          scroll so it never scrolls away. Same gate as the pane itself:
          Premium, cloud-AI consent, and Golem on. */}
      {onCohostListenOn ? (
        <CohostListenPrompt
          enabled={cohostEnabled && cohostConsented && cohostGate?.allowed === true}
          listen={cohostListen}
          onTurnOn={onCohostListenOn}
        />
      ) : null}
      {cohostVisible ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CohostPane
            actionPending={cohostActionPending}
            consented={cohostConsented}
            enabled={cohostEnabled}
            golem={cohostGolem ?? null}
            sayPending={golemPending}
            onSay={onGolemSay}
            onShowOnStreamChange={onGolemShowOnStream}
            expandSignal={cohostExpand}
            flash={cohostFlash}
            gate={cohostGate!}
            highlightedMessageId={liveHighlightId}
            starting={cohostStarting}
            state={shownCohostState}
            onAnswered={(question) => onCohostAnswered?.(question)}
            onRestoreQuestion={
              onCohostRestoreQuestion ? (question) => onCohostRestoreQuestion(question) : undefined
            }
            onDismissFlag={(flag) => onCohostDismissFlag?.(flag)}
            onRemoveFlagged={onRemoveFromChat ? removeFlagged : undefined}
            removableMessageIds={removableFlaggedIds}
            onDismissQuestion={(question) => onCohostDismissQuestion?.(question)}
            onEnableConsent={onCohostEnableConsent}
            onJumpToMessage={(messageId) => {
              setNarrowPane('chat')
              setJumpTo((current) => ({ messageId, seq: (current?.seq ?? 0) + 1 }))
            }}
            onPromiseDismiss={onCohostPromiseDismiss}
            onPromiseDone={onCohostPromiseDone}
            onSayHiGreeted={onCohostAuthorGreeted}
            onRecapDismiss={onCohostRecapDismiss}
            onRecapDraft={
              onCohostRecapDraft
                ? () => {
                    void onCohostRecapDraft().then((state) => {
                      const text = state?.recap?.text
                      if (text) prefillComposer(text)
                    })
                  }
                : undefined
            }
            onRecapPost={(recap) => prefillComposer(recap.text)}
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
              Golem listens to chat during a live stream: questions, flags and the room's mood.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  ) : null

  return (
    // No background: the window frame paints the content coat (plan 050).
    // overflow-hidden: the window never scrolls, each pane scrolls itself. A
    // hit area at the edge (the Auto-show switch's ::after) once gave it both
    // scrollbars.
    <div
      className={cn(
        STREAM_MANAGER_CONTAINER,
        'relative flex h-screen flex-col overflow-hidden text-foreground'
      )}
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

      <StatsBar items={stats} layout={statsLayout} onLayoutChange={changeStatsLayout} />

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
                <PaneLabel label="Activity" onStream={activityOnStream} unseen={activityUnseen} />
              </TabsTrigger>
              {cohostPresent ? (
                <TabsTrigger value="orcle">
                  <PaneLabel dot={cohostTone(cohostState)} label="Golem" unseen={orcleUnseen} />
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </div>
        {/* At Wide: Chat on the left, Activity · Golem on the right. */}
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
                <PaneLabel label="Activity" onStream={activityOnStream} unseen={activityUnseen} />
              </TabsTrigger>
              {cohostPresent ? (
                <TabsTrigger value="orcle">
                  <PaneLabel dot={cohostTone(cohostState)} label="Golem" unseen={orcleUnseen} />
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
            cohostSpotlight={cohostVisible ? cohostMarks.spotlight : null}
            cohostSuggested={cohostVisible ? cohostMarks.suggested : undefined}
            highlightApplyingId={highlightApplyingId}
            highlightFailure={highlightFailure}
            highlightState={highlightState}
            highlightedId={highlightedId}
            jumpTo={jumpTo}
            live={live}
            mentionNames={mentionNames}
            messages={messages}
            delivery={inHistory ? undefined : snapshot.delivery}
            arrivalKey={arrivalKey}
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
            removalRequestIds={removalRequestIds}
            removals={removals}
            onRemoveFromChat={live ? onRemoveFromChat : undefined}
            markerContext={inHistory ? null : markerContext}
            onMarker={inHistory ? undefined : onMarker}
            onUndoMarker={inHistory ? undefined : onUndoMarker}
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
            highlightApplyingId={highlightApplyingId}
            highlightFailure={highlightFailure}
            highlightState={highlightState}
            items={items}
            liveHighlightId={liveHighlightId}
            nowMs={nowMs}
            audience={activityAudience}
            providers={snapshot.providers}
            onShowOnStream={live && onHighlight ? showActivityOnStream : undefined}
            onThank={live && onSend ? thankInChat : undefined}
            onShowFollowNames={onShowFollowNames}
            autoShow={autoShowActivity}
            onAutoShowChange={onAutoShowActivityChange}
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
        onMarkClip={onAir ? onMarkClip : undefined}
        onOpenPreview={onOpenPreview}
        onToggleAlwaysOnTop={onToggleAlwaysOnTop}
      />
    </div>
  )
}
