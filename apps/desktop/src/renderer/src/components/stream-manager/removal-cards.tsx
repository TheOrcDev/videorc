import { useCallback, useEffect, useRef, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { DeleteIcon } from '@/components/icons'
import { BuddyCard } from '@/components/stream-manager/buddy-card'
import { useBuddyCardKeys } from '@/components/stream-manager/buddy-card-keys'
import { Badge } from '@/components/ui/badge'
import type {
  RemovalAnswer,
  RemovalCardView,
  RemovalPaneView,
  RemovalResultView
} from '@/lib/chat-removal-view'

// Buddy's removal cards (plan 140, S6), in the Stream Manager's Buddy pane:
// what Buddy is about to remove because you asked, and how to stop it. The
// backend owns the timing; a card only counts down to it, and leaves a
// one-line result behind when the operation ends.
//
// Keyboard (plan 174 S3.14c): a focused card answers its own keys through the
// one BuddyCard contract (↵ confirms, Esc or ⌫ cancels). Otherwise the
// topmost open card answers through the shared window listener
// (`buddy-card-keys.ts`, after a voice command card and before a proposed
// post), but only when nothing else could want the key: Enter needs no focus
// at all (the page body), so it never confirms from the chat composer, the
// search field, a chat row or a menu; Esc works anywhere except a text field
// or an open menu, dialog or list, which close themselves with it. Cancelling
// is the safe direction. Never with a modifier, a held key (repeat) or during
// IME composition, and never once another handler took the key.

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

/**
 * The chooser's pick key ("1" to "3" as 0 to 2), on the same terms as Enter:
 * only while nothing else has focus, so a digit typed in the composer or the
 * search field is always just a digit. Null to leave the key alone.
 */
export function buddyCardPickIndex(
  event: Parameters<typeof removalKeyAnswer>[0],
  activeElement: Element | null,
  body: Element | null,
  count: number
): number | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (activeElement && activeElement !== body) return null
  const index = ['1', '2', '3'].indexOf(event.key)
  return index >= 0 && index < count ? index : null
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

  const handleWindowKey = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!topmostId) return false
      const answer = removalKeyAnswer(event, document.activeElement, document.body)
      if (!answer) return false
      event.preventDefault()
      onAnswerRef.current(topmostId, answer)
      return true
    },
    [topmostId]
  )
  useBuddyCardKeys('removal', topmostId ? handleWindowKey : null)

  if (!view.active) return null
  return (
    <div
      aria-label="Removals Buddy is waiting on"
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

/**
 * One removal card on the shared BuddyCard: Remove first, then Cancel, in
 * that order whatever the mode; the mode only decides which one is
 * emphasised (Remove when confirming, Cancel while counting down).
 */
function RemovalCard({
  card,
  topmost,
  onAnswer
}: {
  card: RemovalCardView
  topmost: boolean
  onAnswer: (answer: RemovalAnswer) => void
}): ReactElement {
  return (
    <BuddyCard
      busy={card.busy}
      data-mode={card.mode}
      data-operation-id={card.operationId}
      data-topmost={topmost || undefined}
      decline={{
        label: 'Cancel',
        testId: 'removal-cancel',
        variant: card.primary === 'cancel' ? 'secondary' : 'ghost'
      }}
      icon={DeleteIcon}
      keys={topmost && !card.busy}
      label={`Remove ${card.authorName}'s message from ${card.platformLabel}?`}
      primary={{
        label: card.confirmLabel,
        testId: 'removal-confirm',
        variant: card.primary === 'confirm' ? 'destructive' : 'ghost'
      }}
      testId="removal-card"
      timer={card.timer}
      title={<span data-slot="removal-card-title">{card.title}</span>}
      onDecline={() => onAnswer('cancel')}
      onPrimary={() => onAnswer('confirm')}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <ChatPlatformIcon platform={card.platform} />
        <span className="min-w-0 truncate font-medium text-foreground">{card.authorName}</span>
        {card.reason ? (
          <Badge className="shrink-0" data-testid="removal-card-reason" variant="outline">
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
    </BuddyCard>
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
