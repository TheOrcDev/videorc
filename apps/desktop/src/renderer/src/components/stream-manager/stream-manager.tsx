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

import {
  BuddyIdentity,
  BuddySayFooter,
  CohostListenPrompt,
  CohostPane
} from '@/components/cohost-pane'
import type { BuddyPetPreviewHandle } from '@/components/buddy-pet-preview'
import { BuddyCardsArea } from '@/components/stream-manager/buddy-cards-area'
import { BuddyChatControls } from '@/components/stream-manager/buddy-chat-controls'
import {
  BuddyUtteranceCards,
  openProposedUtterances
} from '@/components/stream-manager/buddy-utterance-cards'
import { BuddyLiveSwitch, CohostListeningIndicator, CohostStatus } from '@/components/cohost-status'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WindowHeader } from '@/components/window-frame'
import type {
  CohostAutoChat,
  CohostAutoChatRelayPatch,
  CohostFlag,
  CohostPromise,
  CohostQuestion,
  CohostSayHi,
  CohostState,
  CohostUtteranceState,
  CohostWindowBuddy,
  CohostUtterance,
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
  activeCohostAlerts,
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
import { CHAT_HEADER_CONTAINER, CHAT_HEADER_TIGHT_HIDDEN } from '@/lib/chat-header-tiers'
import { isSortedChronologically, sortMessagesChronological } from '@/lib/live-chat-view'
import { activityItems, thankYouDraft, type ActivityItem } from '@/lib/stream-activity'
import { formatHistoryDate, statItems } from '@/lib/stream-manager-stats'
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
import { chatDraftMaxChars, sendablePlatforms } from '@/lib/chat-send'
import { shortcutLabel } from '@/lib/platform'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { RemoveMessagesReconnectRows } from '@/components/stream-manager/remove-messages-reconnect'
import { RemovalCards } from '@/components/stream-manager/removal-cards'
import {
  CommandCards,
  CommandStrip,
  type CommandAnswer
} from '@/components/stream-manager/command-cards'
import { commandChooserView, commandConfirmView, commandStripView } from '@/lib/buddy-command-view'
import { buddyStateImageUrl } from '@/lib/buddy-default-pack'
import { buddyOffOutputsNotice } from '@/lib/buddy-output-notice'
import {
  removalPaneView,
  removeFromChatAvailable,
  type RemovalAnswer
} from '@/lib/chat-removal-view'

import type { LiveDashboardState } from '../../../../shared/live-dashboard'
import type { BannerRelayAction, BannerSummary } from '../../../../shared/banner-commands'
import type { SoundRelayAction, SoundboardSummary } from '../../../../shared/sound-commands'
import { removeMessagesReconnectPlatforms } from '../../../../shared/platform-scopes'
import { latestModerationOperationByMessage } from '../../../../shared/chat-moderation'
import { WINDOW_NAMES } from '../../../../shared/window-names'

/**
 * ⌘J on macOS, Ctrl+J elsewhere (plan 174 H-22): the platform the window's
 * bootstrap set before the first paint, as every shortcut reads it.
 */
const BUDDY_SHORTCUT = shortcutLabel(shortcutAccelerator('cohost-focus'))

const NO_MODERATION_OPERATIONS: readonly ModerationOperation[] = []
const NO_COHOST_UTTERANCES: readonly CohostUtterance[] = []
const NO_IDS: readonly string[] = []

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

/** The Buddy tab's dot: viewers reporting a problem outrank a healthy green (plan 174 F-7). */
function cohostTone(state: CohostState | null, alerts: number): StatusDotTone {
  if (alerts > 0) return 'warn'
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

/** The Buddy tab's dot in words, for a screen reader (plan 174 H-15). */
function cohostDotLabel(state: CohostState | null): string | null {
  switch (state?.status) {
    case 'listening':
      return 'Buddy is listening'
    case 'paused':
      return 'Buddy is paused'
    case 'error':
      return 'Buddy has a problem'
    default:
      return null
  }
}

function PaneLabel({
  label,
  unseen,
  dot,
  dotLabel = null,
  onStream = false
}: {
  label: string
  unseen: { count: number; incomplete: boolean }
  dot?: StatusDotTone
  /** What the dot means, read aloud (never colour alone). */
  dotLabel?: string | null
  /** Something only this pane shows is on stream (plan 095, D1). */
  onStream?: boolean
}): ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      {dot ? (
        <span
          aria-label={dotLabel ?? undefined}
          className="flex"
          role={dotLabel ? 'img' : undefined}
        >
          <StatusDot tone={dot} />
        </span>
      ) : null}
      {onStream ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex" data-slot="pane-on-stream">
              <StatusDot tone="good" />
              <span className="sr-only">On stream:</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>On stream</TooltipContent>
        </Tooltip>
      ) : null}
      {label}
      {unseen.count > 0 || unseen.incomplete ? (
        <Badge className="px-1.5 tabular-nums" data-testid="pane-unseen" variant="outline">
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
  /** `/clip` in the composer (plan 181 R4): the same action, answered with its words. */
  onClip?: () => Promise<string>
  /**
   * Banners (plan 186 S7): the list Studio pushed (null until it loads) and
   * one show or hide, relayed to Studio. The status bar's Banners menu and
   * the composer's `/banner` use them, on air or not: banners matter in
   * recordings too. Resolves false when it didn't happen, already said.
   */
  banners?: readonly BannerSummary[] | null
  onBanner?: (action: BannerRelayAction) => Promise<boolean>
  /**
   * Sounds (plan 189 S9): the board Studio pushed (null until it loads) and
   * one pad, `/sound` or Stop all, relayed to Studio. The status bar's Sounds
   * popover and the composer's `/sound` use them, on air or not: sounds
   * matter in recordings too. Resolves false when it didn't happen, already
   * said.
   */
  sounds?: SoundboardSummary | null
  onSound?: (action: SoundRelayAction) => Promise<boolean>
  onOpenPreview?: () => void
  /** Show who followed (plan 071, S2): reconnect Twitch with its follow
   * permission, relayed to the main window. */
  onShowFollowNames?: () => void
  /** Auto-show Activity celebrations on stream (plan 156): the one switch,
   * owned by Electron main; the Studio renderer runs the engine. */
  autoShowActivity?: boolean
  onAutoShowActivityChange?: (on: boolean) => void
  /** Reconnect Twitch or Kick so Buddy can remove messages (plan 140, S5);
   * Electron main starts it. Rows show only while live. */
  onReconnectScopes?: (platform: ScopeReconnectPlatform) => void
  /** The live session's chat removals (plan 140, S6), relayed by Studio:
   * row chips, and Buddy's removal cards in the Buddy pane. */
  moderationOperations?: readonly ModerationOperation[]
  /** "Remove from chat" asked for, before any operation answered. */
  removalRequestIds?: ReadonlySet<string>
  /** Cards whose answer is on its way. */
  removalAnsweringIds?: ReadonlySet<string>
  /** ⋯ Remove from chat on a row, or on a flagged message: a manual removal. */
  onRemoveFromChat?: (message: LiveChatMessage) => void
  /** Remove or Cancel on a Buddy removal card. */
  onAnswerRemoval?: (operation: ModerationOperation, answer: RemovalAnswer) => void
  /** Answer Buddy's open voice command (plan 140, S6 part B): pick from the
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
  /** The Buddy on stream (plan 164 S-C4): the pane's header shows and
   * operates it; absent hides the header. */
  cohostBuddy?: CohostWindowBuddy
  /** A Buddy action is on its way through the relay. */
  buddyPending?: boolean
  /** Say something in the bubble (D7): ↵ talks, ⌘↵ laughs. */
  onBuddySay?: (text: string, state: CohostUtteranceState) => Promise<void> | void
  /** `overlayLayout.buddy.showOnStream`, through the Studio relay. */
  onBuddyShowOnStream?: (showOnStream: boolean) => void
  /** A reaction chip (plan 168 S-D3), through the Studio relay. */
  onBuddyReact?: (reaction: string) => void
  /** Persisted `cohost.settings.autoChat` (plan 164 S-D6): the pane's
   * posting mode control and behaviour chips; unknown hides them. */
  cohostAutoChat?: CohostAutoChat
  /** The posting mode (plan 174 S3.14a): `{mode}` alone, never `enabled`. */
  onCohostAutoChatChange?: (patch: CohostAutoChatRelayPatch) => void
  /** The behaviour chips' link to Buddy → Chat, their one home (plan 174 D7). */
  onCohostOpenChatSettings?: () => void
  /** The Buddy's proposed cards (plan 164 S-D2): Send and Dismiss. */
  onCohostUtteranceApprove?: (utterance: CohostUtterance) => void
  onCohostUtteranceDismiss?: (utterance: CohostUtterance) => void
  /** The Buddy Live switch in the pane header and the nudge (plan 174
   * S3.14a): on and off, nothing else. Without cloud-AI consent, on opens
   * the consent dialog (`onCohostEnableConsent`) instead. */
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
  onClip,
  banners,
  onBanner,
  sounds,
  onSound,
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
  cohostBuddy,
  buddyPending = false,
  onBuddySay,
  onBuddyShowOnStream,
  onBuddyReact,
  cohostAutoChat,
  onCohostAutoChatChange,
  onCohostOpenChatSettings,
  onCohostUtteranceApprove,
  onCohostUtteranceDismiss,
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
  // The buffer almost always arrives sorted: one scan instead of a copy and a
  // full sort per chat message (plan 191). Either way the rows are the same.
  const messages = useMemo<readonly LiveChatMessage[]>(
    () =>
      isSortedChronologically(snapshot.messages)
        ? snapshot.messages
        : sortMessagesChronological(snapshot.messages),
    [snapshot.messages]
  )
  // The message on stream now (plan 095, S2): the backend's live state when
  // it has one. Chat, Activity and Buddy all read this one slot.
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
  // The Clip button (plan 181 R4): on air, or whenever the ring holds frames
  // (the main window says so through the marker context).
  const clipAvailable = !inHistory && (onAir || markerContext?.clip?.available === true)
  // Chat removals (plan 140, S6): each row's newest removal, and Buddy's
  // cards and their result lines. History never has any.
  const removalOperations = live ? moderationOperations : NO_MODERATION_OPERATIONS
  const removals = useMemo(
    () => latestModerationOperationByMessage(removalOperations),
    [removalOperations]
  )
  const removalPane = removalPaneView(removalOperations, nowMs, removalAnsweringIds)
  // Buddy voice commands (plan 140, S6 part B): the strip, the chooser and
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
  // The Buddy's proposed posts (plan 164 S-D2, Suggest): open while proposed
  // and not expired, and only live, like the cards themselves.
  const proposedUtteranceIds = live
    ? openProposedUtterances(cohostState?.utterances ?? NO_COHOST_UTTERANCES, nowMs).map(
        (utterance) => utterance.id
      )
    : NO_IDS
  const buddyCardsActive =
    removalPane.active ||
    commandStrip !== null ||
    commandCardId !== '' ||
    proposedUtteranceIds.length > 0
  useEffect(() => {
    const timer = setInterval(
      () => setNowMs(Date.now()),
      onAir || buddyCardsActive ? 1_000 : 15_000
    )
    return () => clearInterval(timer)
  }, [onAir, buddyCardsActive])

  // --- Buddy (unchanged behaviour, moved into its own pane: D5) ---
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
  // The question toast speaks as the streamer's Buddy (plan 174 J2-20). A
  // ref, so a rename never re-runs the state effect below.
  const buddyName = cohostBuddy?.persona.name ?? null
  // The header's living preview and the footer's reaction chips share one
  // handle and one reaction list (plan 174 S3.14c).
  const buddyPreviewRef = useRef<BuddyPetPreviewHandle | null>(null)
  const [buddyPackReactions, setBuddyPackReactions] = useState<readonly string[] | null>(null)
  const buddyNameRef = useRef(buddyName)
  buddyNameRef.current = buddyName
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
      shortcut: BUDDY_SHORTCUT,
      name: buddyNameRef.current
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
  const [composerFocus, setComposerFocus] = useState(0)
  const chatRef = useRef<HTMLDivElement>(null)
  const activityRef = useRef<HTMLDivElement>(null)
  const buddyRef = useRef<HTMLDivElement>(null)
  const chatVisible = usePaneVisible(chatRef)
  const activityVisible = usePaneVisible(activityRef)
  const buddyVisible = usePaneVisible(buddyRef)
  useEffect(() => {
    cohostPaneOpenRef.current = buddyVisible
  }, [buddyVisible])

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
  // Rebuilt only when the rows or the journal change, not on every render
  // (plan 191).
  const communityGifts = useMemo(
    () =>
      new Set([
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
      ]),
    [messages, snapshot.delivery]
  )
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
  // New questions and the Buddy's proposed posts (plan 174 S0.2) count while
  // the pane sits behind a tab: a Suggest card is never a surprise.
  const buddyUnseen = useUnseen(
    undefined,
    `${arrivalKey}:${cohostSensitivity}`,
    buddyVisible,
    () => false,
    [...(shownCohostState?.questions.map((question) => question.id) ?? []), ...proposedUtteranceIds]
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

  const showBuddy = useCallback((): void => {
    setNarrowPane('buddy')
    setRightPane('buddy')
    setCohostExpand((value) => value + 1)
  }, [])

  // A new Buddy card (a removal, a voice command, or a proposed post) brings
  // the Buddy pane forward when it sits behind a tab, without taking focus
  // from the composer. Once the cards and their result lines are gone, the
  // pane the streamer was on comes back, unless they moved on themselves.
  const buddyCardIds = [
    ...removalPane.cards.map((card) => card.operationId),
    ...(commandCardId ? [commandCardId] : []),
    ...proposedUtteranceIds
  ].join(' ')
  const seenRemovalCardsRef = useRef<Set<string>>(new Set())
  const revealedFromRef = useRef<{
    narrow: StreamManagerPane
    right: StreamManagerRightPane
  } | null>(null)
  useEffect(() => {
    const ids = buddyCardIds ? buddyCardIds.split(' ') : []
    const fresh = ids.filter((id) => !seenRemovalCardsRef.current.has(id))
    for (const id of fresh) seenRemovalCardsRef.current.add(id)
    if (fresh.length === 0 || buddyVisible || !cohostPresent) return
    revealedFromRef.current ??= { narrow: narrowPane, right: rightPane }
    setNarrowPane('buddy')
    setRightPane('buddy')
  }, [cohostPresent, narrowPane, buddyVisible, buddyCardIds, rightPane])
  useEffect(() => {
    const from = revealedFromRef.current
    if (buddyCardsActive || !from) return
    revealedFromRef.current = null
    setNarrowPane((current) => (current === 'buddy' ? from.narrow : current))
    setRightPane((current) => (current === 'buddy' ? from.right : current))
  }, [buddyCardsActive])

  // ⌘J focuses Buddy wherever it sits; ⌘F searches chat; ⌘L writes in it
  // (plan 174 S3.16a). The pane is shown first, so its own focus handling
  // lands on a visible element. The single-key row actions live on the chat
  // list itself, never here.
  const searchChat = useCallback((): void => {
    setNarrowPane('chat')
    setSearchFocus((value) => value + 1)
  }, [])
  const writeInChat = useCallback((): void => {
    setNarrowPane('chat')
    setComposerFocus((value) => value + 1)
  }, [])
  const composerAvailable = !inHistory && Boolean(onSend) && (live || Boolean(markerContext))
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'j' && cohostVisible) {
        event.preventDefault()
        showBuddy()
      } else if (key === 'f') {
        event.preventDefault()
        searchChat()
      } else if (key === 'l' && composerAvailable) {
        event.preventDefault()
        writeInChat()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cohostVisible, composerAvailable, searchChat, showBuddy, writeInChat])

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

  // The Buddy Live switch (plan 174 S3.14a, D7): on and off, nothing else.
  // Without cloud-AI consent, on opens the consent dialog, whose Allow grants
  // consent and turns Buddy on (never the microphone). A locked account can
  // still turn Buddy off, never on.
  const buddyLiveReason =
    cohostGate && !cohostGate.allowed && !cohostEnabled ? cohostGate.reason : null
  const requestBuddyLive = (on: boolean): void => {
    if (on && !cohostConsented) {
      onCohostEnableConsent?.()
      return
    }
    onCohostEnable?.(on)
  }

  // The cards waiting on the streamer, for the pane's "N waiting" line and
  // its polite live region (plan 174 H-20): a voice command, each removal,
  // each proposed post.
  const cardNotices = [
    ...(commandCardId
      ? [
          {
            id: commandCardId,
            label: commandChooser
              ? 'Buddy asks which comment you meant'
              : 'Buddy asks whether to show a flagged comment'
          }
        ]
      : []),
    ...removalPane.cards.map((card) => ({
      id: card.operationId,
      label: `Buddy asks before removing ${card.authorName}'s message${card.timer ? `, ${card.timer}` : ''}`
    })),
    ...proposedUtteranceIds.map((id) => ({
      id,
      label: `${buddyName ?? 'Buddy'} wants to post, it expires soon`
    }))
  ]
  const recentUtterances =
    live &&
    (shownCohostState?.utterances ?? NO_COHOST_UTTERANCES).some(
      (utterance) => utterance.status !== 'proposed' && utterance.status !== 'dismissed'
    )
  const activeAlerts = activeCohostAlerts(shownCohostState, nowMs).length

  const buddyPane = cohostPresent ? (
    // overflow-y-auto: when the window is shorter than header, chat controls
    // and the Say footer together (a tiling window manager ignores the
    // window's minimum size), the pane scrolls instead of painting the Say
    // box and the on-stream switch under the status bar.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-slot="buddy-pane">
      {/* One pane header (plan 174 S3.14c, F-8, H-9): identity first, then the
          one Alpha tag, listening, the status, and the Buddy Live switch. */}
      <div
        className={cn(
          CHAT_HEADER_CONTAINER,
          'flex min-h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-3 py-1'
        )}
        data-slot="buddy-pane-header"
      >
        {cohostBuddy ? (
          <BuddyIdentity
            buddy={cohostBuddy}
            previewRef={buddyPreviewRef}
            onPackReactions={setBuddyPackReactions}
          />
        ) : (
          <span className="shrink-0 text-xs font-medium">Buddy</span>
        )}
        <Badge className={cn('shrink-0', CHAT_HEADER_TIGHT_HIDDEN)} variant="outline">
          Alpha
        </Badge>
        {/* Whether Buddy hears you (plan 068); nothing while listening is off. */}
        {cohostVisible ? <CohostListeningIndicator listening={cohostState?.listening} /> : null}
        <span className="flex-1" />
        <CohostStatus
          flash={cohostFlash}
          nowMs={nowMs}
          starting={cohostStarting}
          state={cohostState}
          onOpenPane={cohostVisible ? () => setCohostExpand((value) => value + 1) : undefined}
        />
        {onCohostEnable ? (
          <BuddyLiveSwitch
            checked={cohostEnabled}
            disabledReason={buddyLiveReason}
            onCheckedChange={requestBuddyLive}
          />
        ) : null}
      </div>
      {/* Plan 164 S-D6, plan 174 S3.14a: the posting mode governs only what
          Buddy posts; the behaviours are read-only chips linking to Buddy →
          Chat. Neither touches Buddy Live. */}
      {cohostPresent && cohostAutoChat && onCohostAutoChatChange ? (
        <BuddyChatControls
          autoChat={cohostAutoChat}
          name={buddyName}
          picture={cohostBuddy ? buddyStateImageUrl(cohostBuddy.persona, 'idle') : null}
          onModeChange={(mode) => onCohostAutoChatChange({ mode })}
          onOpenChatSettings={onCohostOpenChatSettings}
        />
      ) : null}
      {/* Everything that waits on the streamer, in one capped scroll region
          (plan 174 H-21): what Buddy heard and did, the chooser or "show it
          anyway?", what it is about to remove because you asked, and what it
          wants to post as you (Suggest), whose keys answer only while the
          pane is on screen (plan 174 S0.2). */}
      <BuddyCardsArea active={buddyCardsActive || recentUtterances} cards={cardNotices}>
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
        {live && onCohostUtteranceApprove && onCohostUtteranceDismiss ? (
          <BuddyUtteranceCards
            active={buddyVisible}
            destinations={snapshot.providers}
            name={buddyName}
            pending={cohostActionPending}
            utterances={shownCohostState?.utterances ?? []}
            onApprove={onCohostUtteranceApprove}
            onDismiss={onCohostUtteranceDismiss}
          />
        ) : null}
      </BuddyCardsArea>
      {/* Plan 140, S5: a quiet row per platform whose account must be
          reconnected before Buddy can remove messages there. Live only. */}
      {live && onReconnectScopes ? (
        <RemoveMessagesReconnectRows
          platforms={removeMessagesReconnectPlatforms(snapshot.providers)}
          onReconnect={onReconnectScopes}
        />
      ) : null}
      {/* The one-time listening card (plan 068 D3), on air or off, above the
          scroll so it never scrolls away. Same gate as the pane itself:
          Premium, cloud-AI consent, and Buddy on. */}
      {onCohostListenOn ? (
        <CohostListenPrompt
          enabled={cohostEnabled && cohostConsented && cohostGate?.allowed === true}
          listen={cohostListen}
          onTurnOn={onCohostListenOn}
        />
      ) : null}
      {cohostVisible ? (
        <CohostPane
          actionPending={cohostActionPending}
          consented={cohostConsented}
          enabled={cohostEnabled}
          expandSignal={cohostExpand}
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
      ) : (
        <Empty className="min-h-0 flex-1">
          <EmptyHeader>
            <EmptyDescription>
              Buddy reads chat during a live stream: questions, flags and the room's mood.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {/* The footer (plan 174 S3.14c, F-10): the Say box, the reactions and
          the on-stream switch, on air and off. All of it is free (D6). */}
      {cohostBuddy ? (
        <BuddySayFooter
          buddy={cohostBuddy}
          offOutputsNotice={buddyOffOutputsNotice({
            enabled: cohostEnabled,
            onAir,
            showOnStream: cohostBuddy.showOnStream,
            showInRecording: cohostBuddy.showInRecording,
            name: buddyName
          })}
          packReactions={buddyPackReactions}
          previewRef={buddyPreviewRef}
          sayChatCap={sendTargets.length > 0 ? chatDraftMaxChars(sendTargets) : null}
          sayPending={buddyPending}
          sayPostsToChat={live && cohostAutoChat?.mode === 'auto'}
          onReact={onBuddyReact}
          onSay={onBuddySay}
          onShowOnStreamChange={onBuddyShowOnStream}
        />
      ) : null}
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
      <WindowHeader title={WINDOW_NAMES.streamManager} />

      {viewMode?.kind === 'history' ? (
        <div
          className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs"
          data-slot="history-bar"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {viewMode.title} · {formatHistoryDate(viewMode.startedAt)}
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
                <TabsTrigger value="buddy">
                  <PaneLabel
                    dot={cohostTone(cohostState, activeAlerts)}
                    dotLabel={cohostDotLabel(cohostState)}
                    label="Buddy"
                    unseen={buddyUnseen}
                  />
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </div>
        {/* At Wide: Chat on the left, Activity · Buddy on the right. */}
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
                <TabsTrigger value="buddy">
                  <PaneLabel
                    dot={cohostTone(cohostState, activeAlerts)}
                    dotLabel={cohostDotLabel(cohostState)}
                    label="Buddy"
                    unseen={buddyUnseen}
                  />
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
            composerFocusSignal={composerFocus}
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
            onClip={inHistory ? undefined : onClip}
            onUndoMarker={inHistory ? undefined : onUndoMarker}
            banners={banners}
            onBanner={inHistory ? undefined : onBanner}
            sounds={sounds}
            onSound={inHistory ? undefined : onSound}
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
            onShowFollowNames={inHistory ? undefined : onShowFollowNames}
            autoShow={autoShowActivity}
            onAutoShowChange={inHistory ? undefined : onAutoShowActivityChange}
            timestamps={live ? 'hover' : 'always'}
          />
        </div>
        {buddyPane ? (
          <div
            ref={buddyRef}
            className={cn('min-h-0 flex-col', paneClasses('buddy', narrowPane, rightPane))}
            data-pane="buddy"
          >
            {buddyPane}
          </div>
        ) : null}
      </div>

      <StreamManagerStatusBar
        alwaysOnTop={alwaysOnTop}
        audience={inHistory ? (history?.audience ?? null) : (dashboard?.audience ?? null)}
        highlightAnchor={onHighlightAnchorChange && !inHistory ? highlightAnchor : undefined}
        providers={snapshot.providers}
        onClear={onClear}
        onFocusBuddy={cohostVisible ? showBuddy : undefined}
        onFocusComposer={composerAvailable ? writeInChat : undefined}
        onHighlightAnchorChange={inHistory ? undefined : onHighlightAnchorChange}
        clip={markerContext?.clip}
        onMarkClip={clipAvailable ? onMarkClip : undefined}
        banners={banners}
        onBanner={onBanner}
        sounds={sounds}
        onSound={onSound}
        onOpenPreview={onOpenPreview}
        onSearchChat={searchChat}
        onStatsLayoutChange={changeStatsLayout}
        onToggleAlwaysOnTop={onToggleAlwaysOnTop}
        statsLayout={statsLayout}
      />
    </div>
  )
}
