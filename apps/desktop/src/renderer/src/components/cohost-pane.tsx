import { AlertIcon, MicrophoneIcon, BuddyIcon } from '@/components/icons'
import type React from 'react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import type { BuddyPetPreviewHandle } from '@/components/buddy-pet-preview'
import { LazyBuddyPetPreview } from '@/components/buddy-pet-preview-lazy'
import { CohostFlagRow } from '@/components/cohost-flag-row'
import { CohostQuestionRow } from '@/components/cohost-question-row'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Command, CommandList } from '@/components/ui/command'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Switch } from '@/components/ui/switch'
import type {
  CohostFlag,
  CohostPromise,
  CohostQuestion,
  CohostRecap,
  CohostRecentlyResolved,
  CohostSayHi,
  CohostState,
  CohostUtteranceState,
  CohostWindowBuddy
} from '@/lib/backend'
import { buddyStateImageUrl } from '@/lib/buddy-default-pack'
import {
  BUDDY_HEADER_PREVIEW_PX,
  BUDDY_REACTION_CHIPS,
  buddyReactionDisabledReason,
  BUDDY_STILL_PACK_ID
} from '@/lib/buddy-pet-view'
import { CLOUD_AI_KEEPS, CLOUD_AI_USES } from '@/lib/buddy-tab-view'
import { cohostEmptyStateCopy, cohostPresenceView } from '@/lib/cohost-presence'
import { activeCohostSpotlight } from '@/lib/cohost-marks'
import { REMOVE_FROM_CHAT_LABEL } from '@/lib/chat-removal-view'
import {
  activeCohostAlerts,
  activeCohostRecap,
  cohostAgeLabel,
  cohostAlertLabel,
  cohostErrorDetail,
  cohostErrorDetailText,
  cohostFlagRowKey,
  cohostHighlightMessageId,
  cohostListenPromptVisible,
  cohostPaneMode,
  cohostPromiseTriggerLabel,
  cohostQuestionRowKey,
  cohostRowAt,
  cohostRows,
  moveCohostSelection,
  persistCohostListenPromptDismissed,
  readCohostListenPromptDismissed,
  resolveCohostSelection,
  sortedCohostFlags,
  sortedCohostQuestions,
  COHOST_ACTS_ON_ASK_COPY,
  COHOST_ACTS_ON_ASK_HINT,
  COHOST_LISTEN_DISCLOSURE,
  COHOST_MOOD_LABELS,
  COHOST_REMOVE_FLAGGED_KEY
} from '@/lib/cohost-view'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { cn } from '@/lib/utils'
import { smoothScrollBehavior } from '@/hooks/use-reduced-motion'

/**
 * The Buddy pane's triage list in the Stream Manager, which only the
 * detached Comments window mounts (plan 174 S3.14c): the Stream Manager owns
 * the pane's one header (identity, status, the Buddy Live switch, the posting
 * mode: `BuddyIdentity` sits in it) and its footer (`BuddySayFooter`); this
 * is what lies between. It renders the backend's `cohost.state` and nothing
 * else: it never decides what is a question and never sends anything to
 * chat. A flag is only acted on when the streamer asks: "Remove from chat"
 * on the selected flag (plan 140, S6) is the same manual removal as the chat
 * row's ⋯ menu.
 *
 * Keyboard-first (videorc-design): the rows are dense 32 px lines, the list
 * takes the pane's height and scrolls on its own, and the footer bar carries
 * the actions for the selected row with their key chips. ⌘J focuses the
 * list; ↑/↓ move; R reply, H show on stream, A answered, ⌫ dismiss, ⇧⌫
 * remove a flagged message from chat.
 */
export function CohostPane({
  state,
  gate,
  consented,
  enabled,
  starting = false,
  expandSignal = 0,
  highlightedMessageId = null,
  actionPending = false,
  onReply,
  onShowOnStream,
  onAnswered,
  onRestoreQuestion,
  onDismissQuestion,
  onDismissFlag,
  onRemoveFlagged,
  removableMessageIds,
  onPromiseDone,
  onPromiseDismiss,
  onRecapPost,
  onRecapDismiss,
  onRecapDraft,
  onSayHiGreeted,
  onJumpToMessage,
  onEnableConsent,
  onUpgrade
}: {
  state: CohostState | null
  gate: EntitlementUiGate
  consented: boolean
  enabled: boolean
  /** The engine was asked to start but has not reported listening yet. */
  starting?: boolean
  /** Bumped by the header status element to scroll to and focus the list. */
  expandSignal?: number
  highlightedMessageId?: string | null
  actionPending?: boolean
  onReply: (question: CohostQuestion) => void
  onShowOnStream?: (question: CohostQuestion) => void
  onAnswered: (question: CohostQuestion) => void
  /** Put back a question the engine resolved from what the streamer said. */
  onRestoreQuestion?: (question: CohostQuestion) => void
  onDismissQuestion: (question: CohostQuestion) => void
  onDismissFlag: (flag: CohostFlag) => void
  /** "Remove from chat" on a flagged message (plan 140, S6): a manual
   * removal, offered only for messages in `removableMessageIds`. */
  onRemoveFlagged?: (flag: CohostFlag) => void
  removableMessageIds?: ReadonlySet<string>
  /** Promises and recaps (plan 068 D8). Nothing here sends: Post to chat
   * pre-fills the composer, Draft a recap asks the backend for a draft. */
  onPromiseDone?: (promise: CohostPromise) => void
  onPromiseDismiss?: (promise: CohostPromise) => void
  onRecapPost?: (recap: CohostRecap) => void
  onRecapDismiss?: () => void
  onRecapDraft?: () => void
  /** "Say hi" (plan 068 D9): the streamer greeted this first-timer. */
  onSayHiGreeted?: (entry: CohostSayHi) => void
  onJumpToMessage?: (messageId: string) => void
  onEnableConsent?: () => void
  onUpgrade?: (url: string) => void
}): ReactElement | null {
  const mode = cohostPaneMode({ gate, consented, enabled })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)

  const questions = useMemo(() => sortedCohostQuestions(state?.questions ?? []), [state?.questions])
  const flags = useMemo(() => sortedCohostFlags(state?.flags ?? []), [state?.flags])
  const rows = useMemo(() => cohostRows(state), [state])
  const activeKey = resolveCohostSelection(rows, selectedKey)
  const activeRow = cohostRowAt(rows, selectedKey)
  // "Answered on air" (plan 060 D9): newest first, gone after the backend's
  // 60 s even when no cohost.state arrives in quiet chat (the backend only
  // filters when it snapshots, and a Restore on an aged entry is a no-op).
  const answeredOnAir = useMemo(
    () =>
      [...(state?.recentlyResolved ?? [])]
        .filter((entry) => Date.parse(entry.resolvedAt) + COHOST_RECENTLY_RESOLVED_TTL_MS > nowMs)
        .reverse()
        .slice(0, 3),
    [state?.recentlyResolved, nowMs]
  )
  const spotlightQuestionId = activeCohostSpotlight(state, nowMs)?.questionId ?? null
  const promises = state?.promises ?? []
  const sayHi = state?.sayHi ?? []
  const recap = activeCohostRecap(state, nowMs)
  const topic = state?.topic?.trim() || null
  // Viewers saying something is broken. A persistent chip, never a toast: it
  // stays while the backend still counts two corroborating viewers.
  const alerts = activeCohostAlerts(state, nowMs)
  const alertCount = state?.alerts?.length ?? 0
  // The empty-state copy follows what the engine is doing right now.
  const presence = cohostPresenceView(state, nowMs, { starting })

  // Ages and alert expiry are the only time-dependent copy in the pane; one
  // slow tick keeps them honest without re-rendering the message list
  // underneath.
  const recapPresent = state?.recap !== undefined
  const sayHiCount = sayHi.length
  useEffect(() => {
    if (rows.length === 0 && alertCount === 0 && !recapPresent && sayHiCount === 0) return
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [alertCount, recapPresent, rows.length, sayHiCount])

  // The header status element takes you here: scroll into view, focus the list.
  useEffect(() => {
    if (expandSignal <= 0) return
    paneRef.current?.scrollIntoView({ block: 'nearest', behavior: smoothScrollBehavior() })
    const frame = requestAnimationFrame(() => rootRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [expandSignal])

  // ⌘J focuses the list. In the main window plain ⌘J already toggles the
  // Comments window, so this only ever fires where the pane is mounted.
  useEffect(() => {
    if (mode.kind !== 'live') return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'j' || !(event.metaKey || event.ctrlKey) || event.shiftKey) {
        return
      }
      const root = rootRef.current
      if (!root) return
      event.preventDefault()
      root.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode.kind])

  // Notices are flush Alerts (plan 174 F-14): the Premium lock with its one
  // action, or the cloud-AI disclosure with its one action.
  if (mode.kind === 'upsell') {
    return (
      <div className="shrink-0 p-2" data-slot="cohost-notice">
        <Alert data-testid="cohost-upsell" variant="locked">
          <AlertTitle>{mode.reason}</AlertTitle>
          {mode.upgradeUrl && onUpgrade ? (
            <AlertAction>
              <Button
                size="xs"
                type="button"
                variant="outline"
                onClick={() => onUpgrade(mode.upgradeUrl as string)}
              >
                View Premium
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      </div>
    )
  }

  if (mode.kind === 'consent') {
    // The whole disclosure, wrapping (plan 174 S0.2): the one list of cloud
    // uses consent covers, and an action that opens the consent dialog.
    // Nothing is granted by this click.
    return (
      <>
        <div className="shrink-0 p-2" data-slot="cohost-consent">
          <Alert aria-label="Buddy needs cloud AI" role="group" icon={BuddyIcon}>
            <AlertTitle className="text-xs">Buddy needs cloud AI</AlertTitle>
            <AlertDescription className="text-xs">
              <ul className="flex list-disc flex-col gap-0.5 pl-4">
                {CLOUD_AI_USES.map((use) => (
                  <li key={use}>{use}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">{CLOUD_AI_KEEPS}</p>
            </AlertDescription>
            {onEnableConsent ? (
              <div className="col-start-2 mt-1.5 flex flex-wrap gap-1">
                <Button size="xs" type="button" variant="secondary" onClick={onEnableConsent}>
                  Allow cloud AI…
                </Button>
              </div>
            ) : null}
          </Alert>
        </div>
      </>
    )
  }

  // Buddy Live off: the header's switch already says so (plan 174 S3.14a).
  if (mode.kind === 'disabled') return null

  // The failed tick in the server's own words. The engine clears `detail` the
  // moment it listens again, so a stale detail is never shown.
  const errorDetail =
    state?.status === 'error' || state?.status === 'paused'
      ? cohostErrorDetailText(cohostErrorDetail(state))
      : null
  const primaryAction = (): void => {
    if (!activeRow) return
    if (activeRow.kind === 'question') {
      const question = questions.find((candidate) => candidate.id === activeRow.id)
      if (question) onReply(question)
      return
    }
    onJumpToMessage?.(activeRow.id)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedKey(moveCohostSelection(rows, selectedKey, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (!activeRow) return
    const question =
      activeRow.kind === 'question'
        ? questions.find((candidate) => candidate.id === activeRow.id)
        : undefined
    const flag =
      activeRow.kind === 'flag'
        ? flags.find((candidate) => candidate.messageId === activeRow.id)
        : undefined

    // ⇧⌫ removes a flagged message from chat, and never falls back to a
    // dismissal when removal is not offered.
    if ((event.key === 'Backspace' || event.key === 'Delete') && event.shiftKey && flag) {
      event.preventDefault()
      if (onRemoveFlagged && removableMessageIds?.has(flag.messageId)) onRemoveFlagged(flag)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      primaryAction()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      if (question) onDismissQuestion(question)
      else if (flag) onDismissFlag(flag)
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 'r' && question) {
      event.preventDefault()
      onReply(question)
      return
    }
    if (key === 'h' && question && onShowOnStream) {
      event.preventDefault()
      onShowOnStream(question)
      return
    }
    if (key === 'a' && question) {
      event.preventDefault()
      onAnswered(question)
    }
  }

  // The chat's weather, one quiet line: its mood, what you are talking about,
  // and whether the last pass was partial. Plain words, never a tooltip.
  const weather = [
    ...(state?.mood ? [COHOST_MOOD_LABELS[state.mood]] : []),
    ...(state?.partial ? ['Partial pass, newest messages used'] : [])
  ]

  return (
    <div
      ref={paneRef}
      className="@container/cohost-pane flex min-h-0 flex-1 flex-col"
      data-testid="cohost-pane"
    >
      {alerts.length > 0 ? (
        // Viewers saying something is broken (plan 174 F-7): a flush warning
        // row, never a toast; it stays while the backend counts two viewers.
        <div className="flex shrink-0 flex-col gap-1 px-2 pt-2">
          {alerts.map((alert) => (
            <Alert key={alert.kind} data-testid="cohost-alert" variant="warning">
              <AlertTitle>{cohostAlertLabel(alert)}</AlertTitle>
              <AlertDescription className="text-xs">
                Several viewers said this in chat in the last two minutes.
              </AlertDescription>
            </Alert>
          ))}
        </div>
      ) : null}
      {weather.length > 0 || topic ? (
        <p
          className="truncate px-2.5 py-1 text-[11px] text-muted-foreground"
          data-slot="cohost-topic"
        >
          {weather.join(' · ')}
          {weather.length > 0 && topic ? ' · ' : ''}
          {topic ? (
            <>
              <span className="text-subtle">Talking about:</span> {topic}
            </>
          ) : null}
        </p>
      ) : null}
      {errorDetail ? (
        // The failed tick in the server's own words, so "AI error" is never
        // the whole story. Monochrome; the header's dot carries the state.
        <p
          className="truncate px-2.5 py-1 text-[11px] text-muted-foreground"
          data-slot="cohost-error-detail"
          title={errorDetail}
        >
          {errorDetail}
        </p>
      ) : null}
      {/* The triage list takes the pane's height and scrolls on its own (plan
          174 F-8, H-21): a stack of cards above never collapses it. */}
      <Command
        ref={rootRef}
        aria-label="Buddy questions and flags"
        className="min-h-0 flex-1 bg-transparent outline-none"
        shouldFilter={false}
        tabIndex={0}
        value={activeKey ?? ''}
        onKeyDown={handleKeyDown}
        onValueChange={setSelectedKey}
      >
        <CommandList className="max-h-none min-h-0 flex-1 px-1 py-1">
          {rows.length === 0 ? (
            <p className="px-2 py-3 text-xs text-subtle" data-slot="cohost-empty-state">
              {cohostEmptyStateCopy(presence, state)}
            </p>
          ) : (
            <>
              {questions.map((question) => (
                <CohostQuestionRow
                  key={question.id}
                  nowMs={nowMs}
                  onStream={
                    highlightedMessageId !== null &&
                    cohostHighlightMessageId(question) === highlightedMessageId
                  }
                  question={question}
                  selected={activeKey === cohostQuestionRowKey(question.id)}
                  talkingAbout={spotlightQuestionId === question.id}
                  onReply={onReply}
                  onSelect={setSelectedKey}
                />
              ))}
              {flags.map((flag) => (
                <CohostFlagRow
                  key={flag.messageId}
                  flag={flag}
                  nowMs={nowMs}
                  selected={activeKey === cohostFlagRowKey(flag.messageId)}
                  onJump={(value) => onJumpToMessage?.(value.messageId)}
                  onSelect={setSelectedKey}
                />
              ))}
            </>
          )}
        </CommandList>
      </Command>
      {answeredOnAir.length > 0 ? (
        <AnsweredOnAir
          disabled={actionPending || !onRestoreQuestion}
          items={answeredOnAir}
          onRestore={(question) => onRestoreQuestion?.(question)}
        />
      ) : null}
      {sayHi.length > 0 ? (
        <CohostSayHiList
          disabled={actionPending}
          items={sayHi}
          nowMs={nowMs}
          onGreeted={onSayHiGreeted}
        />
      ) : null}
      {promises.length > 0 ? (
        <CohostPromises
          disabled={actionPending}
          items={promises}
          onDismiss={onPromiseDismiss}
          onDone={onPromiseDone}
        />
      ) : null}
      {recap ? (
        <CohostRecapCard
          disabled={actionPending}
          recap={recap}
          onDismiss={onRecapDismiss}
          onPost={onRecapPost}
        />
      ) : onRecapDraft ? (
        <>
          <Separator />
          <div className="flex h-7 items-center gap-1 px-2" data-slot="cohost-recap-draft">
            <span
              className={cn('min-w-0 flex-1 truncate text-[11px] text-subtle', PANE_NARROW_HIDDEN)}
            >
              For viewers who just arrived.
            </span>
            <Button
              className="shrink-0"
              disabled={actionPending}
              size="xs"
              type="button"
              variant="ghost"
              onClick={onRecapDraft}
            >
              Draft a recap
            </Button>
          </div>
        </>
      ) : null}

      {activeRow ? (
        <>
          <Separator />
          <div
            className="flex flex-wrap items-center justify-end gap-1 px-2 py-1"
            data-slot="cohost-actions"
          >
            <HoverHint hint={COHOST_ACTS_ON_ASK_COPY}>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[11px] text-muted-foreground',
                  PANE_NARROW_HIDDEN
                )}
                data-slot="cohost-acts-on-ask"
              >
                {COHOST_ACTS_ON_ASK_HINT}
              </span>
            </HoverHint>
            {activeRow.kind === 'question' ? (
              <>
                <CohostAction
                  disabled={actionPending}
                  accelerator="R"
                  label="Reply"
                  onClick={() => {
                    const question = questions.find((candidate) => candidate.id === activeRow.id)
                    if (question) onReply(question)
                  }}
                />
                {onShowOnStream ? (
                  <CohostAction
                    disabled={actionPending}
                    accelerator="H"
                    label="Show on stream"
                    onClick={() => {
                      const question = questions.find((candidate) => candidate.id === activeRow.id)
                      if (question) onShowOnStream(question)
                    }}
                  />
                ) : null}
                <CohostAction
                  disabled={actionPending}
                  accelerator="A"
                  label="Answered"
                  onClick={() => {
                    const question = questions.find((candidate) => candidate.id === activeRow.id)
                    if (question) onAnswered(question)
                  }}
                />
                <CohostAction
                  disabled={actionPending}
                  accelerator="Backspace"
                  label="Dismiss"
                  onClick={() => {
                    const question = questions.find((candidate) => candidate.id === activeRow.id)
                    if (question) onDismissQuestion(question)
                  }}
                />
              </>
            ) : (
              <>
                {onJumpToMessage ? (
                  <CohostAction
                    accelerator="Enter"
                    label="Jump to message"
                    onClick={() => onJumpToMessage(activeRow.id)}
                  />
                ) : null}
                <CohostAction
                  disabled={actionPending}
                  accelerator="Backspace"
                  label="Dismiss"
                  onClick={() => {
                    const flag = flags.find((candidate) => candidate.messageId === activeRow.id)
                    if (flag) onDismissFlag(flag)
                  }}
                />
                {onRemoveFlagged && removableMessageIds?.has(activeRow.id) ? (
                  <CohostAction
                    accelerator={COHOST_REMOVE_FLAGGED_KEY}
                    label={REMOVE_FROM_CHAT_LABEL}
                    variant="destructive"
                    onClick={() => {
                      const flag = flags.find((candidate) => candidate.messageId === activeRow.id)
                      if (flag) onRemoveFlagged(flag)
                    }}
                  />
                ) : null}
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * The Buddy's identity in the pane header (plan 164 S-C4, plan 168 S-D3,
 * plan 174 S3.14c): the living preview at 32 px (the pack it wears on
 * stream, following the pointer in this window and holding the frame of the
 * state on air), the name, and the bubble while one is up. The pane's
 * reactions come from the same preview, so the footer registers its handle
 * through `onPreview`. Free for everyone (D6): no Premium, no consent, no
 * live session.
 */
export function BuddyIdentity({
  buddy,
  previewRef,
  onPackReactions
}: {
  buddy: CohostWindowBuddy
  /** The footer's handle on the preview, to play a reaction on it. */
  previewRef?: React.RefObject<BuddyPetPreviewHandle | null>
  /** The loaded pack's reactions; null when it cannot load. */
  onPackReactions?: (reactions: readonly string[] | null) => void
}): ReactElement {
  const image = buddyStateImageUrl(buddy.persona, buddy.state)
  const avatar = buddy.persona.avatar
  const packId = avatar?.kind === 'alive' ? avatar.packId : BUDDY_STILL_PACK_ID
  return (
    <div className="flex min-w-0 items-center gap-2" data-slot="buddy-header">
      <div className="shrink-0" data-slot="buddy-avatar" data-state={buddy.state}>
        <LazyBuddyPetPreview
          ref={previewRef}
          label={buddy.persona.name}
          motion={buddy.persona.motion}
          packId={packId}
          personaId={buddy.persona.id}
          placeholder={
            <img
              alt=""
              className="size-8 rounded-chip bg-foreground/[0.04] object-contain"
              data-slot="buddy-state-image"
              data-state={buddy.state}
              draggable={false}
              src={image}
            />
          }
          pose={buddy.state === 'idle' ? null : buddy.state}
          size={BUDDY_HEADER_PREVIEW_PX}
          stillImages={buddy.persona.images}
          onError={() => onPackReactions?.(null)}
          onLoad={(info) => onPackReactions?.(info.reactions)}
        />
      </div>
      <span
        className="min-w-0 shrink truncate text-xs font-medium text-foreground"
        data-slot="buddy-name"
        title={buddy.persona.name}
      >
        {buddy.persona.name}
      </span>
      {buddy.bubble ? (
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          data-slot="buddy-bubble"
          title={buddy.bubble}
        >
          “{buddy.bubble}”
        </span>
      ) : null}
    </div>
  )
}

/**
 * The Buddy pane's footer (plan 174 S3.14c, F-10): the Say box (↵ says it
 * talking, ⌘↵ laughing), the reaction chips that play a reaction on air
 * (each disabled when the pack has no such reaction), and the "{name} on
 * stream" switch. Visible on air and off: all of it is free (D6).
 */
export function BuddySayFooter({
  buddy,
  previewRef,
  packReactions = null,
  sayPending = false,
  sayPostsToChat = false,
  sayChatCap = null,
  onSay,
  onShowOnStreamChange,
  onReact
}: {
  buddy: CohostWindowBuddy
  /** The header preview's handle, so a reaction plays there too. */
  previewRef?: React.RefObject<BuddyPetPreviewHandle | null>
  /** The pack's reactions as the header preview reported them. */
  packReactions?: readonly string[] | null
  sayPending?: boolean
  /** Auto, on air: the line also goes to every chat as you (plan 174 F-6). */
  sayPostsToChat?: boolean
  /** The shortest chat cap a posted Say meets (X takes 140); null when unknown. */
  sayChatCap?: number | null
  onSay?: (text: string, state: CohostUtteranceState) => Promise<void> | void
  onShowOnStreamChange?: (showOnStream: boolean) => void
  onReact?: (reaction: string) => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  const name = buddy.persona.name
  const overCap = sayPostsToChat && sayChatCap !== null && draft.length > sayChatCap
  const avatar = buddy.persona.avatar
  const say = (state: CohostUtteranceState): void => {
    const text = draft.trim()
    if (!text || !onSay || sayPending) return
    setDraft('')
    void onSay(text, state)
  }
  const react = (reaction: string): void => {
    if (!onReact) return
    previewRef?.current?.react(reaction)
    onReact(reaction)
  }
  return (
    <div
      className="@container/buddy-header shrink-0 border-t border-border"
      data-slot="buddy-footer"
    >
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2" data-slot="buddy-say">
        <div className="flex min-w-48 flex-1 items-center gap-1.5">
          <Input
            aria-describedby={sayPostsToChat ? 'buddy-say-posts' : undefined}
            aria-label={`Say something as ${name}`}
            className="h-7 text-xs"
            disabled={!onSay}
            maxLength={200}
            placeholder={
              sayPostsToChat ? 'Say something on stream and in chat' : 'Say something on stream'
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              say(event.metaKey || event.ctrlKey ? 'laugh' : 'talk')
            }}
          />
          <HoverHint hint="Say it">
            <ShortcutKeys accelerator="Enter" className={HEADER_NARROW_HIDDEN} />
          </HoverHint>
          <HoverHint hint="Say it laughing">
            <ShortcutKeys accelerator="CmdOrCtrl+Enter" className={HEADER_NARROW_HIDDEN} />
          </HoverHint>
        </div>
        {sayPostsToChat ? (
          // Plan 174 F-6: Auto posts the line to every chat as you, so the box
          // says so and counts against the shortest chat cap (X takes 140).
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 text-[11px] tabular-nums',
              overCap ? 'font-medium text-foreground' : 'text-muted-foreground'
            )}
            data-over-cap={overCap || undefined}
            data-slot="buddy-say-posts"
            id="buddy-say-posts"
          >
            {overCap ? (
              <AlertIcon aria-hidden className="size-3 text-warning" weight="fill" />
            ) : null}
            Also posts to chat as you
            {sayChatCap !== null ? ` · ${draft.length}/${sayChatCap}` : ''}
          </span>
        ) : null}
        <div
          aria-label="React on stream"
          className="flex shrink-0 items-center gap-1"
          data-slot="buddy-reactions"
          role="group"
        >
          {BUDDY_REACTION_CHIPS.map((chip) => {
            const reactionChip = (
              entry: (typeof BUDDY_REACTION_CHIPS)[number],
              off: boolean
            ): ReactElement => (
              <Button
                data-reaction={entry.id}
                data-testid="buddy-reaction-chip"
                disabled={off}
                size="xs"
                type="button"
                variant="outline"
                onClick={() => react(entry.id)}
              >
                {entry.label}
              </Button>
            )
            const available = packReactions?.includes(chip.id) ?? false
            const disabled = !onReact || !available
            return (
              <DisabledReason
                key={chip.id}
                reason={buddyReactionDisabledReason({
                  relay: Boolean(onReact),
                  alive: avatar?.kind === 'alive',
                  packReactions,
                  chip
                })}
              >
                {disabled ? (
                  reactionChip(chip, true)
                ) : (
                  <ShortcutTooltip label={`${chip.label} on stream`}>
                    {reactionChip(chip, false)}
                  </ShortcutTooltip>
                )}
              </DisabledReason>
            )
          })}
        </div>
        {/* Plan 174 F-18: the overlay switch is named after the Buddy, so it
            never reads like a question's "Show on stream". */}
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch
            aria-label={`${name} on stream`}
            checked={buddy.showOnStream}
            data-testid="buddy-show-on-stream"
            disabled={!onShowOnStreamChange}
            size="sm"
            onCheckedChange={(checked) => onShowOnStreamChange?.(checked)}
          />
          <span className={HEADER_NARROW_HIDDEN}>{name} on stream</span>
        </label>
      </div>
    </div>
  )
}

/**
 * The one-time "Buddy can hear you" card (plan 068 D3) at the top of the
 * Buddy pane, for someone who already runs Buddy with listening off. Either
 * answer is final: Turn on and Not now both persist, so it never comes back.
 * A flush Alert row, not a card on a card; the words say what listening sends
 * before the streamer opts in.
 */
export function CohostListenPrompt({
  enabled,
  listen,
  onTurnOn
}: {
  /** Buddy can run here: Premium, cloud-AI consent, and Buddy on. */
  enabled: boolean
  /** Persisted `cohost.settings.listen`; unknown never shows the card. */
  listen: boolean | undefined
  onTurnOn: () => void
}): ReactElement | null {
  const [dismissed, setDismissed] = useState(() => readCohostListenPromptDismissed())
  if (!cohostListenPromptVisible({ enabled, listen, dismissed })) return null
  const answer = (): void => {
    setDismissed(true)
    persistCohostListenPromptDismissed()
  }
  return (
    <div className="shrink-0 p-2" data-slot="cohost-listen-prompt">
      <Alert aria-label="Buddy can hear you while you're live" role="group" icon={MicrophoneIcon}>
        <AlertTitle className="text-xs">Buddy can hear you while you&apos;re live</AlertTitle>
        <AlertDescription className="text-xs">{COHOST_LISTEN_DISCLOSURE}</AlertDescription>
        <div className="col-start-2 mt-1.5 flex flex-wrap gap-1">
          <Button
            size="xs"
            type="button"
            variant="secondary"
            onClick={() => {
              answer()
              onTurnOn()
            }}
          >
            Turn on
          </Button>
          <Button size="xs" type="button" variant="ghost" onClick={answer}>
            Not now
          </Button>
        </div>
      </Alert>
    </div>
  )
}

/**
 * Questions the engine resolved because the streamer answered them out loud:
 * one quiet line for the newest, the others (at most two) one click away.
 * Restore puts a question back; no toast, the line simply leaves.
 */
function AnsweredOnAir({
  items,
  disabled,
  onRestore
}: {
  items: readonly CohostRecentlyResolved[]
  disabled: boolean
  onRestore: (question: CohostQuestion) => void
}): ReactElement | null {
  const [newest, ...older] = items
  if (!newest) return null
  const line = (item: CohostRecentlyResolved, more?: ReactNode): ReactElement => (
    <div key={item.question.id} className="flex h-7 min-w-0 items-center gap-1 px-2 text-xs">
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        data-slot="cohost-answered-on-air-text"
        title={item.question.text}
      >
        <span className="text-subtle">Answered on air:</span> {item.question.text}
      </span>
      {more}
      <Button
        className="shrink-0"
        disabled={disabled}
        size="xs"
        type="button"
        variant="ghost"
        onClick={() => onRestore(item.question)}
      >
        Restore
      </Button>
    </div>
  )
  return (
    <Collapsible data-testid="cohost-answered-on-air">
      <Separator />
      {line(
        newest,
        older.length > 0 ? (
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`${older.length} more answered on air`}
              className="shrink-0 tabular-nums"
              size="xs"
              type="button"
              variant="ghost"
            >
              +{older.length}
            </Button>
          </CollapsibleTrigger>
        ) : undefined
      )}
      {older.length > 0 ? (
        <CollapsibleContent>{older.map((item) => line(item))}</CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}

/**
 * What the streamer promised out loud (plan 068 D8): private rows with the
 * trigger as a hint. Done and Dismiss both close the promise; the backend
 * reminds once when the trigger is met, as a keyed toast.
 */
function CohostPromises({
  items,
  disabled,
  onDone,
  onDismiss
}: {
  items: readonly CohostPromise[]
  disabled: boolean
  onDone?: (promise: CohostPromise) => void
  onDismiss?: (promise: CohostPromise) => void
}): ReactElement {
  return (
    <div data-slot="cohost-promises">
      <Separator />
      <p className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-subtle">Promises</p>
      {items.map((promise) => {
        const hint = cohostPromiseTriggerLabel(promise.trigger)
        return (
          <div
            key={promise.id}
            className="flex h-7 min-w-0 items-center gap-1 px-2 text-xs"
            data-slot="cohost-promise"
          >
            <span
              className="min-w-0 flex-1 truncate text-foreground"
              title={hint ? `${promise.text} (${hint})` : promise.text}
            >
              {promise.text}
            </span>
            {hint ? (
              <span
                className={cn('shrink-0 text-[11px] text-muted-foreground', PANE_NARROW_HIDDEN)}
                data-slot="cohost-promise-hint"
              >
                {hint}
              </span>
            ) : null}
            <Button
              className="shrink-0"
              disabled={disabled || !onDone}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onDone?.(promise)}
            >
              Done
            </Button>
            <Button
              className="shrink-0"
              disabled={disabled || !onDismiss}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onDismiss?.(promise)}
            >
              Dismiss
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * First-time chatters nobody greeted yet (plan 068 D9): name, platform, how
 * long they have waited. Saying their name out loud, @-ing them, replying to
 * their question or putting their message on stream all take them off; so
 * does Greeted. The backend drops them after 15 minutes.
 */
function CohostSayHiList({
  items,
  nowMs,
  disabled,
  onGreeted
}: {
  items: readonly CohostSayHi[]
  nowMs: number
  disabled: boolean
  onGreeted?: (entry: CohostSayHi) => void
}): ReactElement {
  return (
    <div data-slot="cohost-say-hi">
      <Separator />
      <HoverHint hint="First time in your chat. Say their name and Buddy takes them off.">
        <p className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-subtle">Say hi</p>
      </HoverHint>
      {items.map((entry) => {
        const age = cohostAgeLabel(entry.firstSeenAt, nowMs)
        return (
          <div
            key={entry.authorKey}
            className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs"
            data-slot="cohost-say-hi-row"
          >
            <ChatPlatformIcon platform={entry.platform} />
            <span className="min-w-0 flex-1 truncate text-foreground" title={entry.name}>
              {entry.name}
            </span>
            {age ? (
              <span
                className={cn(
                  'shrink-0 text-[11px] text-muted-foreground tabular-nums',
                  PANE_NARROW_HIDDEN
                )}
              >
                {age}
              </span>
            ) : null}
            <Button
              className="shrink-0"
              disabled={disabled || !onGreeted}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onGreeted?.(entry)}
            >
              Greeted
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A recap for viewers who asked what they missed, or one the streamer
 * drafted. "Edit in chat box" pre-fills the composer and nothing else (plan
 * 174 F-23): Buddy never sends, and the button says what the click does.
 */
function CohostRecapCard({
  recap,
  disabled,
  onPost,
  onDismiss
}: {
  recap: CohostRecap
  disabled: boolean
  onPost?: (recap: CohostRecap) => void
  onDismiss?: () => void
}): ReactElement {
  return (
    <div className="shrink-0 p-2" data-slot="cohost-recap">
      <Alert aria-label="Recap for viewers who just arrived" icon={null} role="group">
        <AlertTitle className="text-xs">Recap</AlertTitle>
        <AlertDescription className="text-xs" data-testid="cohost-recap-text">
          {recap.text}
        </AlertDescription>
        <div className="col-start-2 mt-1.5 flex flex-wrap gap-1">
          <Button
            disabled={disabled || !onPost}
            size="xs"
            type="button"
            variant="secondary"
            onClick={() => onPost?.(recap)}
          >
            Edit in chat box
          </Button>
          <Button
            disabled={disabled || !onDismiss}
            size="xs"
            type="button"
            variant="ghost"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </div>
      </Alert>
    </div>
  )
}

function CohostAction({
  label,
  accelerator,
  disabled = false,
  variant = 'ghost',
  onClick
}: {
  label: string
  /** The row action's key, as an accelerator (`R`, `Backspace`, `Shift+Backspace`). */
  accelerator: string
  disabled?: boolean
  /** Destructive only for Remove from chat: red is information. */
  variant?: 'ghost' | 'destructive'
  onClick: () => void
}): ReactElement {
  return (
    // The key chip folds in a narrow pane; the tooltip still names it.
    <ShortcutTooltip accelerator={accelerator} label={label}>
      <Button disabled={disabled} size="xs" type="button" variant={variant} onClick={onClick}>
        {label}
        <ShortcutKeys accelerator={accelerator} className={PANE_NARROW_HIDDEN} />
      </Button>
    </ShortcutTooltip>
  )
}

// The pane is a container: in a narrow Chat window (320px minimum) it drops
// decoration and key chips before anything clips. Shortcuts keep working and
// stay named in each action's title. Literal so Tailwind generates it.
// Mirrors the backend TTL for recentlyResolved (cohost.rs).
const COHOST_RECENTLY_RESOLVED_TTL_MS = 60_000

const PANE_NARROW_HIDDEN = '@max-[400px]/cohost-pane:hidden'
// The Buddy header is its own container (plan 174 F-27): a class that names
// the pane's container never applied there, so it names its own.
const HEADER_NARROW_HIDDEN = '@max-[400px]/buddy-header:hidden'

/**
 * A hint on hover (plan 174 S1.10): a key chip's action, a short line's full
 * sentence, a label's explanation. Never a native `title`.
 */
function HoverHint({ hint, children }: { hint: string; children: ReactElement }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}
