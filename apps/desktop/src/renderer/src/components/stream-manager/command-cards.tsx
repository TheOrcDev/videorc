import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { MicrophoneIcon, BuddyIcon, PreviewIcon } from '@/components/icons'
import { BuddyCard } from '@/components/stream-manager/buddy-card'
import { useBuddyCardKeys } from '@/components/stream-manager/buddy-card-keys'
import { Button } from '@/components/ui/button'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { buddyCardPickIndex, removalKeyAnswer } from '@/components/stream-manager/removal-cards'
import type {
  CommandChooserView,
  CommandConfirmView,
  CommandStripView
} from '@/lib/buddy-command-view'
import { cn } from '@/lib/utils'

// Buddy voice commands in the Stream Manager's Buddy pane (plan 140, S6 part
// B), directly above the removal cards: what Buddy heard and did (the strip),
// then what waits for you (the chooser, or "show it anyway?").
//
// Keys follow the one BuddyCard contract (plan 174 S3.14c) and the removal
// cards' scoping (`removalKeyAnswer`): Enter only with nothing focused, Esc
// anywhere but a text field or an open menu, and 1 to 3 like Enter. A
// command card is the newest thing the streamer did, so the shared window
// listener (`buddy-card-keys.ts`) asks it first.

const FOCUSED_CARD =
  '[data-testid="removal-card"], [data-testid="command-chooser"], [data-testid="command-confirm"], [data-testid="buddy-utterance-card"]'

export type CommandAnswer =
  | { action: 'choose'; index: number }
  | { action: 'confirm' }
  | { action: 'cancel' }

/** "Heard: “…”", then what Buddy did. Quiet statuses use secondary text. */
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

  const handleWindowKey = useCallback(
    (event: globalThis.KeyboardEvent): boolean => {
      if (!commandId) return false
      // A focused card (this one or another) answers its own keys.
      if (document.activeElement?.closest(FOCUSED_CARD)) return false
      const index = buddyCardPickIndex(event, document.activeElement, document.body, pickCount)
      if (index !== null) {
        event.preventDefault()
        onAnswerRef.current(commandId, { action: 'choose', index })
        return true
      }
      const answer = removalKeyAnswer(event, document.activeElement, document.body)
      if (!answer || (answer === 'confirm' && !confirmable)) return false
      event.preventDefault()
      onAnswerRef.current(commandId, { action: answer })
      return true
    },
    [commandId, confirmable, pickCount]
  )
  useBuddyCardKeys('command', commandId ? handleWindowKey : null)

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

/** The chooser's own keys, before the card's shared contract: 1 to 3 picks. */
function pickKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  picks: number,
  onAnswer: (answer: CommandAnswer) => void
): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.shiftKey || event.nativeEvent.isComposing || event.repeat) return
  const index = ['1', '2', '3'].indexOf(event.key)
  if (index < 0 || index >= picks) return
  event.preventDefault()
  onAnswer({ action: 'choose', index })
}

function CommandChooser({
  view,
  onAnswer
}: {
  view: CommandChooserView
  onAnswer: (answer: CommandAnswer) => void
}): ReactElement {
  return (
    <BuddyCard
      data-command-id={view.commandId}
      decline={{ label: 'Cancel', testId: 'command-cancel' }}
      icon={BuddyIcon}
      keys
      label="Which comment did you mean?"
      testId="command-chooser"
      timer={view.timer}
      title={view.title}
      onDecline={() => onAnswer({ action: 'cancel' })}
      onKeyDown={(event) => pickKeyDown(event, view.candidates.length, onAnswer)}
    >
      <ol className="flex flex-col gap-0.5" data-slot="command-candidates">
        {view.candidates.map((candidate) => (
          <li key={candidate.index}>
            <Button
              className="h-auto w-full min-w-0 justify-start gap-2 px-1.5 py-1 text-left whitespace-normal"
              data-testid="command-candidate"
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onAnswer({ action: 'choose', index: candidate.index })}
            >
              <ShortcutKeys accelerator={candidate.key} />
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
    </BuddyCard>
  )
}

function CommandConfirm({
  view,
  onAnswer
}: {
  view: CommandConfirmView
  onAnswer: (answer: CommandAnswer) => void
}): ReactElement {
  return (
    <BuddyCard
      busy={view.busy}
      data-command-id={view.commandId}
      decline={{ label: 'Cancel', testId: 'command-cancel' }}
      icon={PreviewIcon}
      keys={!view.busy}
      label={view.kind === 'act' ? 'Buddy asks first' : 'Show this comment on stream?'}
      primary={
        view.kind === 'act'
          ? { label: 'Yes', testId: 'command-yes' }
          : { label: 'Show', testId: 'command-show' }
      }
      testId="command-confirm"
      timer={view.timer}
      title={view.title}
      onDecline={() => onAnswer({ action: 'cancel' })}
      onPrimary={() => onAnswer({ action: 'confirm' })}
    >
      {view.target ? (
        <>
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
        </>
      ) : null}
    </BuddyCard>
  )
}
