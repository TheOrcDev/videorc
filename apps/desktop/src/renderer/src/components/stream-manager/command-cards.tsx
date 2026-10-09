import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { MicrophoneIcon, BuddyIcon, PreviewIcon } from '@/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { buddyCardPickIndex, removalKeyAnswer } from '@/components/stream-manager/removal-cards'
import type {
  CommandChooserView,
  CommandConfirmView,
  CommandStripView
} from '@/lib/buddy-command-view'
import { cn } from '@/lib/utils'

// Golem voice commands in the Stream Manager's Golem pane (plan 140, S6 part
// B), directly above the removal cards: what Golem heard and did (the strip),
// then what waits for you (the chooser, or "show it anyway?").
//
// Keys follow the removal cards' scoping (`removalKeyAnswer`): Enter only
// with nothing focused, Esc anywhere but a text field or an open menu, and 1
// to 3 like Enter. A command card is newer than any removal card, so its
// window listener runs in the capture phase and takes the key first.

const FOCUSED_CARD =
  '[data-testid="removal-card"], [data-testid="command-chooser"], [data-testid="command-confirm"]'

export type CommandAnswer =
  | { action: 'choose'; index: number }
  | { action: 'confirm' }
  | { action: 'cancel' }

/** "Heard: “…”", then what Golem did. Quiet statuses use secondary text. */
export function CommandStrip({ view }: { view: CommandStripView | null }): ReactElement | null {
  if (!view) return null
  return (
    <p
      aria-live="polite"
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs transition-opacity duration-150 motion-reduce:transition-none',
        view.fading && 'opacity-0'
      )}
      data-fading={view.fading || undefined}
      data-quiet={view.quiet || undefined}
      data-slot="command-strip"
      role="status"
    >
      <MicrophoneIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {view.heard ? (
        <span className="min-w-0 shrink truncate text-muted-foreground" title={view.heard}>
          {view.heard}
        </span>
      ) : null}
      {view.heard && view.message ? (
        <span aria-hidden className="shrink-0 text-subtle">
          ·
        </span>
      ) : null}
      {view.message ? (
        <span
          className={cn(
            'min-w-0 truncate',
            view.quiet ? 'text-muted-foreground' : 'font-medium text-foreground'
          )}
          data-slot="command-strip-message"
          title={view.message}
        >
          {view.message}
        </span>
      ) : null}
    </p>
  )
}

/** One chooser, or one highlight confirm card. Never both at once. */
export function CommandCards({
  chooser,
  confirm,
  onAnswer
}: {
  chooser: CommandChooserView | null
  confirm: CommandConfirmView | null
  onAnswer: (commandId: string, answer: CommandAnswer) => void
}): ReactElement | null {
  const onAnswerRef = useRef(onAnswer)
  useEffect(() => {
    onAnswerRef.current = onAnswer
  }, [onAnswer])
  const commandId = chooser?.commandId ?? (confirm && !confirm.busy ? confirm.commandId : null)
  const pickCount = chooser?.candidates.length ?? 0
  const confirmable = Boolean(confirm && !chooser)

  useEffect(() => {
    if (!commandId) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      // A focused card (this one or a removal card) answers its own keys.
      if (document.activeElement?.closest(FOCUSED_CARD)) return
      const index = buddyCardPickIndex(event, document.activeElement, document.body, pickCount)
      if (index !== null) {
        event.preventDefault()
        onAnswerRef.current(commandId, { action: 'choose', index })
        return
      }
      const answer = removalKeyAnswer(event, document.activeElement, document.body)
      if (!answer || (answer === 'confirm' && !confirmable)) return
      event.preventDefault()
      onAnswerRef.current(commandId, { action: answer })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [commandId, confirmable, pickCount])

  if (chooser) {
    return (
      <div className="shrink-0 border-b border-border p-2" data-slot="command-cards">
        <CommandChooser view={chooser} onAnswer={(answer) => onAnswer(chooser.commandId, answer)} />
      </div>
    )
  }
  if (confirm) {
    return (
      <div className="shrink-0 border-b border-border p-2" data-slot="command-cards">
        <CommandConfirm view={confirm} onAnswer={(answer) => onAnswer(confirm.commandId, answer)} />
      </div>
    )
  }
  return null
}

function cardKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onAnswer: (answer: CommandAnswer) => void,
  { picks = 0, confirmable = false }: { picks?: number; confirmable?: boolean }
): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.shiftKey || event.nativeEvent.isComposing || event.repeat) return
  const index = ['1', '2', '3'].indexOf(event.key)
  if (index >= 0 && index < picks) {
    event.preventDefault()
    onAnswer({ action: 'choose', index })
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    onAnswer({ action: 'cancel' })
    return
  }
  // Enter on a button is that button's own click.
  if (!confirmable || event.key !== 'Enter' || (event.target as Element).closest('button')) return
  event.preventDefault()
  onAnswer({ action: 'confirm' })
}

function CommandChooser({
  view,
  onAnswer
}: {
  view: CommandChooserView
  onAnswer: (answer: CommandAnswer) => void
}): ReactElement {
  return (
    <Alert
      aria-label="Which comment did you mean?"
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      data-command-id={view.commandId}
      data-testid="command-chooser"
      role="group"
      tabIndex={-1}
      onKeyDown={(event) => cardKeyDown(event, onAnswer, { picks: view.candidates.length })}
    >
      <BuddyIcon aria-hidden weight="duotone" />
      <AlertTitle className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">{view.title}</span>
        {view.timer ? (
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums">
            {view.timer}
          </span>
        ) : null}
      </AlertTitle>
      <AlertDescription className="text-xs">
        <ol className="flex flex-col gap-0.5" data-slot="command-candidates">
          {view.candidates.map((candidate) => (
            <li key={candidate.index}>
              <Button
                className="h-auto w-full min-w-0 justify-start gap-2 px-1.5 py-1 text-left whitespace-normal"
                data-testid="command-candidate"
                size="xs"
                title={`Pick ${candidate.authorName} (${candidate.key})`}
                type="button"
                variant="ghost"
                onClick={() => onAnswer({ action: 'choose', index: candidate.index })}
              >
                <Kbd>{candidate.key}</Kbd>
                <ChatPlatformIcon
                  className={candidate.platform === 'youtube' ? 'ml-1' : undefined}
                  platform={candidate.platform}
                />
                <span className="shrink-0 font-medium text-foreground">{candidate.authorName}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {candidate.excerpt ? `“${candidate.excerpt}”` : null}
                </span>
              </Button>
            </li>
          ))}
        </ol>
      </AlertDescription>
      <div className="col-start-2 mt-1 flex flex-wrap gap-1">
        <Button
          data-testid="command-cancel"
          size="xs"
          title="Cancel (Esc)"
          type="button"
          variant="ghost"
          onClick={() => onAnswer({ action: 'cancel' })}
        >
          Cancel
          <Kbd>esc</Kbd>
        </Button>
      </div>
    </Alert>
  )
}

function CommandConfirm({
  view,
  onAnswer
}: {
  view: CommandConfirmView
  onAnswer: (answer: CommandAnswer) => void
}): ReactElement {
  const keys = !view.busy
  return (
    <Alert
      aria-busy={view.busy || undefined}
      aria-label="Show this comment on stream?"
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      data-command-id={view.commandId}
      data-testid="command-confirm"
      role="group"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!view.busy) cardKeyDown(event, onAnswer, { confirmable: true })
      }}
    >
      <PreviewIcon aria-hidden />
      <AlertTitle className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate" title={view.title}>
          {view.title}
        </span>
        {view.timer ? (
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums">
            {view.timer}
          </span>
        ) : null}
      </AlertTitle>
      {view.target ? (
        <AlertDescription className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChatPlatformIcon platform={view.target.platform} />
            <span className="min-w-0 truncate font-medium text-foreground">
              {view.target.authorName}
            </span>
          </span>
          {view.target.excerpt ? (
            <span className="line-clamp-2 break-words text-foreground select-text">
              “{view.target.excerpt}”
            </span>
          ) : null}
        </AlertDescription>
      ) : null}
      <div
        className={cn('col-start-2 mt-1 flex flex-wrap gap-1', view.busy && 'opacity-60')}
        data-slot="command-confirm-actions"
      >
        <Button
          data-testid="command-show"
          disabled={view.busy}
          size="xs"
          title="Show it (Enter)"
          type="button"
          variant="secondary"
          onClick={() => onAnswer({ action: 'confirm' })}
        >
          Show
          {keys ? <Kbd>↵</Kbd> : null}
        </Button>
        <Button
          data-testid="command-cancel"
          disabled={view.busy}
          size="xs"
          title="Cancel (Esc)"
          type="button"
          variant="ghost"
          onClick={() => onAnswer({ action: 'cancel' })}
        >
          Cancel
          {keys ? <Kbd>esc</Kbd> : null}
        </Button>
      </div>
    </Alert>
  )
}
