import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { DeleteIcon } from '@/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type {
  RemovalAnswer,
  RemovalCardView,
  RemovalPaneView,
  RemovalResultView
} from '@/lib/chat-removal-view'
import { cn } from '@/lib/utils'

// Orcle's removal cards (plan 140, S6), at the top of the Stream Manager's
// Orcle pane: what Orcle is about to remove because you asked, and how to stop
// it. The backend owns the timing; a card only counts down to it, and leaves
// a one-line result behind when the operation ends.
//
// Keyboard (Enter confirms, Esc cancels), scoped so it never steals a key:
//
// - A focused card answers its own keys. Enter on one of its buttons is that
//   button's own click.
// - Otherwise the topmost open card answers, but only when nothing else could
//   want the key. Enter needs no focus at all (the page body): it never
//   confirms from the chat composer, the search field, a chat row or a menu.
//   Esc works anywhere except a text field or an open menu, dialog or list,
//   which close themselves with it. Cancelling is the safe direction.
// - Never with a modifier, a held key (repeat) or during IME composition, and
//   never once another handler took the key (`defaultPrevented`).

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const SELF_CLOSING = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]'

/** What a window-level key means for the topmost card, or null to leave it alone. */
export function removalKeyAnswer(
  event: Pick<
    globalThis.KeyboardEvent,
    | 'key'
    | 'defaultPrevented'
    | 'repeat'
    | 'isComposing'
    | 'metaKey'
    | 'ctrlKey'
    | 'altKey'
    | 'shiftKey'
  >,
  activeElement: Element | null,
  body: Element | null
): RemovalAnswer | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  const nothingFocused = !activeElement || activeElement === body
  if (event.key === 'Enter') return nothingFocused ? 'confirm' : null
  if (event.key !== 'Escape') return null
  if (nothingFocused) return 'cancel'
  if (activeElement.closest(EDITABLE) || activeElement.closest(SELF_CLOSING)) return null
  return 'cancel'
}

export function RemovalCards({
  view,
  onAnswer
}: {
  view: RemovalPaneView
  onAnswer: (operationId: string, answer: RemovalAnswer) => void
}): ReactElement | null {
  const onAnswerRef = useRef(onAnswer)
  useEffect(() => {
    onAnswerRef.current = onAnswer
  }, [onAnswer])
  const topmost = view.cards.find((card) => !card.busy) ?? null
  const topmostId = topmost?.operationId ?? null

  useEffect(() => {
    if (!topmostId) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const answer = removalKeyAnswer(event, document.activeElement, document.body)
      if (!answer) return
      event.preventDefault()
      onAnswerRef.current(topmostId, answer)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [topmostId])

  if (!view.active) return null
  return (
    <div
      aria-label="Removals Orcle is waiting on"
      className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2"
      data-slot="removal-cards"
    >
      {view.cards.map((card) => (
        <RemovalCard
          key={card.operationId}
          card={card}
          topmost={card.operationId === topmostId}
          onAnswer={(answer) => onAnswer(card.operationId, answer)}
        />
      ))}
      {view.results.map((result) => (
        <RemovalResult key={result.operationId} result={result} />
      ))}
    </div>
  )
}

function RemovalCard({
  card,
  topmost,
  onAnswer
}: {
  card: RemovalCardView
  topmost: boolean
  onAnswer: (answer: RemovalAnswer) => void
}): ReactElement {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (card.busy || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.repeat) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onAnswer('cancel')
      return
    }
    // Enter on a button is that button's own click.
    if (event.key !== 'Enter' || (event.target as Element).closest('button')) return
    event.preventDefault()
    onAnswer('confirm')
  }
  const keys = topmost && !card.busy
  const confirm = (
    <Button
      key="confirm"
      data-slot="removal-confirm"
      disabled={card.busy}
      size="xs"
      title={`${card.confirmLabel} (Enter)`}
      type="button"
      variant={card.primary === 'confirm' ? 'destructive' : 'ghost'}
      onClick={() => onAnswer('confirm')}
    >
      {card.confirmLabel}
      {keys ? <Kbd>↵</Kbd> : null}
    </Button>
  )
  const cancel = (
    <Button
      key="cancel"
      data-slot="removal-cancel"
      disabled={card.busy}
      size="xs"
      title="Cancel (Esc)"
      type="button"
      variant={card.primary === 'cancel' ? 'secondary' : 'ghost'}
      onClick={() => onAnswer('cancel')}
    >
      Cancel
      {keys ? <Kbd>esc</Kbd> : null}
    </Button>
  )
  return (
    <Alert
      aria-busy={card.busy || undefined}
      aria-label={`Remove ${card.authorName}'s message from ${card.platformLabel}?`}
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      data-mode={card.mode}
      data-operation-id={card.operationId}
      data-slot="removal-card"
      data-topmost={topmost || undefined}
      role="group"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <DeleteIcon aria-hidden />
      <AlertTitle className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate" data-slot="removal-card-title">
          {card.title}
        </span>
        {card.timer ? (
          <span
            className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums"
            data-slot="removal-card-timer"
          >
            {card.timer}
          </span>
        ) : null}
      </AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-1 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChatPlatformIcon platform={card.platform} />
          <span className="min-w-0 truncate font-medium text-foreground">{card.authorName}</span>
          {card.reason ? (
            <Badge className="shrink-0" data-slot="removal-card-reason" variant="outline">
              {card.reason}
            </Badge>
          ) : null}
        </span>
        {card.excerpt ? (
          <span
            className="line-clamp-2 break-words text-foreground select-text"
            data-slot="removal-card-excerpt"
          >
            “{card.excerpt}”
          </span>
        ) : null}
        {card.note ? <span data-slot="removal-card-note">{card.note}</span> : null}
      </AlertDescription>
      <div
        className={cn('col-start-2 mt-1 flex flex-wrap gap-1', card.busy && 'opacity-60')}
        data-slot="removal-card-actions"
      >
        {card.primary === 'confirm' ? [confirm, cancel] : [cancel, confirm]}
      </div>
    </Alert>
  )
}

function RemovalResult({ result }: { result: RemovalResultView }): ReactElement {
  return (
    <p
      className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground"
      data-operation-id={result.operationId}
      data-slot="removal-result"
      role="status"
    >
      <ChatPlatformIcon decorative platform={result.platform} />
      <span className="shrink-0 font-medium text-foreground">{result.authorName}</span>
      <span className="min-w-0 truncate" title={result.text}>
        {result.text}
      </span>
    </p>
  )
}
