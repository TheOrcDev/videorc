import { CaretDown, Robot } from '@phosphor-icons/react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { CohostFlagRow } from '@/components/cohost-flag-row'
import { CohostQuestionRow } from '@/components/cohost-question-row'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Command, CommandList } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import type { CohostFlag, CohostQuestion, CohostState } from '@/lib/backend'
import {
  cohostChipView,
  cohostFlagRowKey,
  cohostHighlightMessageId,
  cohostPaneMode,
  cohostQuestionRowKey,
  cohostRowAt,
  cohostRows,
  moveCohostSelection,
  resolveCohostSelection,
  sortedCohostFlags,
  sortedCohostQuestions,
  COHOST_MOOD_LABELS
} from '@/lib/cohost-view'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { cn } from '@/lib/utils'

/**
 * The Co-host segment above the live message list, in BOTH the in-app rail and
 * the detached Comments window. It renders the backend's `cohost.state` and
 * nothing else — it never decides what is a question, never sends anything, and
 * never acts on a flag.
 *
 * Keyboard-first (videorc-design): the rows stay dense single lines and the
 * footer bar carries the actions for the selected row with their key chips.
 * ⌘J focuses the pane; ↑/↓ move; R reply, H show on stream, A answered,
 * ⌫ dismiss.
 */
export function CohostPane({
  state,
  gate,
  consented,
  enabled,
  highlightedMessageId = null,
  actionPending = false,
  onReply,
  onShowOnStream,
  onAnswered,
  onDismissQuestion,
  onDismissFlag,
  onJumpToMessage,
  onEnableConsent,
  onUpgrade
}: {
  state: CohostState | null
  gate: EntitlementUiGate
  consented: boolean
  enabled: boolean
  highlightedMessageId?: string | null
  actionPending?: boolean
  onReply: (question: CohostQuestion) => void
  onShowOnStream?: (question: CohostQuestion) => void
  onAnswered: (question: CohostQuestion) => void
  onDismissQuestion: (question: CohostQuestion) => void
  onDismissFlag: (flag: CohostFlag) => void
  onJumpToMessage?: (messageId: string) => void
  onEnableConsent?: () => void
  onUpgrade?: (url: string) => void
}): ReactElement | null {
  const mode = cohostPaneMode({ gate, consented, enabled })
  const [open, setOpen] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)

  const questions = useMemo(() => sortedCohostQuestions(state?.questions ?? []), [state?.questions])
  const flags = useMemo(() => sortedCohostFlags(state?.flags ?? []), [state?.flags])
  const rows = useMemo(() => cohostRows(state), [state])
  const activeKey = resolveCohostSelection(rows, selectedKey)
  const activeRow = cohostRowAt(rows, selectedKey)

  // Ages are the only time-dependent copy in the pane; one slow tick keeps them
  // honest without re-rendering the message list underneath.
  useEffect(() => {
    if (rows.length === 0) return
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [rows.length])

  // ⌘J focuses the pane. In the main window plain ⌘J already toggles the
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
      setOpen(true)
      root.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode.kind])

  if (mode.kind === 'upsell') {
    return (
      <CohostNotice label="Premium">
        <span className="min-w-0 flex-1 truncate">{mode.reason}</span>
        {mode.upgradeUrl && onUpgrade ? (
          <Button size="xs" variant="ghost" onClick={() => onUpgrade(mode.upgradeUrl as string)}>
            View Premium
          </Button>
        ) : null}
      </CohostNotice>
    )
  }

  if (mode.kind === 'consent') {
    return (
      <CohostNotice label="Co-host">
        <span className="min-w-0 flex-1 truncate">{mode.reason}</span>
        {onEnableConsent ? (
          <Button size="xs" variant="ghost" onClick={onEnableConsent}>
            Turn on cloud AI
          </Button>
        ) : null}
      </CohostNotice>
    )
  }

  if (mode.kind === 'disabled') {
    return null
  }

  const chip = cohostChipView(state)
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

  return (
    <Collapsible
      className="shrink-0 rounded-row border border-border/60 bg-card/30"
      data-slot="cohost-pane"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-row px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60">
        <CaretDown
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90"
        />
        <Robot aria-hidden className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <span className="shrink-0 text-xs font-medium text-foreground">Co-host</span>
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground">
          alpha
        </span>
        {chip ? (
          <span
            className={cn(
              'truncate text-[11px]',
              chip.tone === 'live' ? 'text-success' : 'text-muted-foreground'
            )}
          >
            {chip.label.replace(/^Co-host: /, '')}
          </span>
        ) : null}
        <span className="flex-1" />
        {state?.partial ? (
          <Badge title="Chat outran one AI pass; the newest messages were used." variant="outline">
            Partial
          </Badge>
        ) : null}
        {state?.mood ? (
          <span className="shrink-0 text-[11px] text-subtle">{COHOST_MOOD_LABELS[state.mood]}</span>
        ) : null}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <Separator />
        <Command
          ref={rootRef}
          aria-label="Co-host questions and flags"
          className="bg-transparent outline-none"
          shouldFilter={false}
          tabIndex={0}
          value={activeKey ?? ''}
          onKeyDown={handleKeyDown}
          onValueChange={setSelectedKey}
        >
          <CommandList className="max-h-48 px-1 py-1">
            {rows.length === 0 ? (
              <p className="px-2 py-3 text-xs text-subtle">
                Listening — questions from chat will appear here.
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

        {activeRow ? (
          <>
            <Separator />
            <div className="flex items-center gap-1 px-2 py-1" data-slot="cohost-actions">
              <span className="min-w-0 flex-1 truncate text-[11px] text-subtle">
                Nothing sends without you.
              </span>
              {activeRow.kind === 'question' ? (
                <>
                  <CohostAction
                    disabled={actionPending}
                    keyLabel="R"
                    label="Reply"
                    onClick={() => {
                      const question = questions.find((candidate) => candidate.id === activeRow.id)
                      if (question) onReply(question)
                    }}
                  />
                  {onShowOnStream ? (
                    <CohostAction
                      disabled={actionPending}
                      keyLabel="H"
                      label="Show on stream"
                      onClick={() => {
                        const question = questions.find(
                          (candidate) => candidate.id === activeRow.id
                        )
                        if (question) onShowOnStream(question)
                      }}
                    />
                  ) : null}
                  <CohostAction
                    disabled={actionPending}
                    keyLabel="A"
                    label="Answered"
                    onClick={() => {
                      const question = questions.find((candidate) => candidate.id === activeRow.id)
                      if (question) onAnswered(question)
                    }}
                  />
                  <CohostAction
                    disabled={actionPending}
                    keyLabel="⌫"
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
                      keyLabel="↵"
                      label="Jump to message"
                      onClick={() => onJumpToMessage(activeRow.id)}
                    />
                  ) : null}
                  <CohostAction
                    disabled={actionPending}
                    keyLabel="⌫"
                    label="Dismiss"
                    onClick={() => {
                      const flag = flags.find((candidate) => candidate.messageId === activeRow.id)
                      if (flag) onDismissFlag(flag)
                    }}
                  />
                </>
              )}
            </div>
          </>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function CohostAction({
  label,
  keyLabel,
  disabled = false,
  onClick
}: {
  label: string
  keyLabel: string
  disabled?: boolean
  onClick: () => void
}): ReactElement {
  return (
    <Button disabled={disabled} size="xs" type="button" variant="ghost" onClick={onClick}>
      {label}
      <Kbd>{keyLabel}</Kbd>
    </Button>
  )
}

/** One-line explanation that REPLACES the pane (Premium, consent). Same shape
 * as the multistream upsell: state the reason, offer the one action. */
function CohostNotice({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div
      className="flex shrink-0 items-center gap-2 rounded-row border border-border/60 bg-card/30 px-2.5 py-1.5 text-[11px] text-muted-foreground"
      data-slot="cohost-notice"
    >
      <Robot aria-hidden className="size-4 shrink-0" weight="duotone" />
      <Badge className="shrink-0" variant="outline">
        {label}
        <span className="ml-1 shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground">
          alpha
        </span>
      </Badge>
      {children}
    </div>
  )
}
