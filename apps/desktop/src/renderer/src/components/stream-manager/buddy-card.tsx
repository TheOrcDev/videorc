import type { ComponentProps, KeyboardEvent, ReactElement, ReactNode } from 'react'

import type { AppIcon } from '@/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { shortcutLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'

// The one Buddy card (plan 174 S3.14c, H-23): every card that waits on the
// streamer in the Buddy pane (a removal, a voice command's chooser or
// confirm, a proposed post) is this Alert group. One title row with a timer
// slot, one description, one actions row in a fixed order: the primary action
// first, then the decline. One key contract: on a focused card ↵ is the
// primary action (never from a button, which has its own click), Esc
// declines, and ⌫ or Delete declines too. The key chips sit on the card the
// window-level keys answer (`buddy-card-keys.ts`).

export type BuddyCardKey = 'primary' | 'decline'

const EDITABLE_OR_BUTTON =
  'button, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/**
 * What a key means on a focused card, or null to leave it alone. Never with a
 * modifier, a held key or during IME composition, and never once another
 * handler took it.
 */
export function buddyCardKey(
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
  target: Element | null
): BuddyCardKey | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (event.key === 'Escape') return 'decline'
  if (target?.closest(EDITABLE_OR_BUTTON)) return null
  if (event.key === 'Enter') return 'primary'
  if (event.key === 'Backspace' || event.key === 'Delete') return 'decline'
  return null
}

/** One of the card's two buttons. */
export interface BuddyCardAction {
  label: string
  testId: string
  variant?: 'secondary' | 'destructive' | 'ghost'
}

export function BuddyCard({
  label,
  icon,
  title,
  timer = null,
  busy = false,
  keys = false,
  testId,
  primary = null,
  decline = null,
  onPrimary,
  onDecline,
  onKeyDown,
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof Alert>, 'title' | 'role' | 'variant'> & {
  /** The card's accessible name. */
  label: string
  icon?: AppIcon | null
  title: ReactNode
  /** The time left, in the title row ("Expires in 18s"). */
  timer?: string | null
  /** Running, or an answer is on its way: the buttons wait. */
  busy?: boolean
  /** Show the key chips: this is the card the window-level keys answer. */
  keys?: boolean
  testId: string
  /** The primary action, first in the row; null for a card with none. */
  primary?: BuddyCardAction | null
  /** The decline, second in the row. */
  decline?: BuddyCardAction | null
  onPrimary?: () => void
  onDecline?: () => void
  /** A card's own keys (the chooser's 1 to 3), before the shared contract. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}): ReactElement {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (event.defaultPrevented || busy) return
    const key = buddyCardKey(event.nativeEvent, event.target as Element)
    if (key === 'primary' && onPrimary) {
      event.preventDefault()
      onPrimary()
    } else if (key === 'decline' && onDecline) {
      event.preventDefault()
      onDecline()
    }
  }
  return (
    <Alert
      aria-busy={busy || undefined}
      aria-label={label}
      className={cn('outline-none focus-visible:ring-2 focus-visible:ring-ring/40', className)}
      data-testid={testId}
      role="group"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      icon={icon}
      {...rest}
    >
      <AlertTitle className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate" data-slot="buddy-card-title">
          {title}
        </span>
        {timer ? (
          <span
            className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums"
            data-slot="buddy-card-timer"
          >
            {timer}
          </span>
        ) : null}
      </AlertTitle>
      {children ? (
        <AlertDescription className="flex min-w-0 flex-col gap-1 text-xs">
          {children}
        </AlertDescription>
      ) : null}
      {primary || decline ? (
        <div
          className={cn('col-start-2 mt-1.5 flex flex-wrap gap-1', busy && 'opacity-60')}
          data-slot="buddy-card-actions"
        >
          {primary ? (
            <Button
              data-testid={primary.testId}
              disabled={busy}
              size="xs"
              title={`${primary.label} (${shortcutLabel('Enter')})`}
              type="button"
              variant={primary.variant ?? 'secondary'}
              onClick={onPrimary}
            >
              {primary.label}
              {keys ? <ShortcutKeys accelerator="Enter" /> : null}
            </Button>
          ) : null}
          {decline ? (
            <Button
              data-testid={decline.testId}
              disabled={busy}
              size="xs"
              title={`${decline.label} (${shortcutLabel('Escape')})`}
              type="button"
              variant={decline.variant ?? 'ghost'}
              onClick={onDecline}
            >
              {decline.label}
              {keys ? <ShortcutKeys accelerator="Escape" /> : null}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Alert>
  )
}
