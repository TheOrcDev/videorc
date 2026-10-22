import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'

/** A card that waits on the streamer, as the live region names it. */
export interface BuddyCardNotice {
  id: string
  /** "Buddy asks before removing Ada's message, 18s left". */
  label: string
}

/** The notices for cards not announced yet, in order; pure. */
export function freshBuddyCardLabels(
  seen: ReadonlySet<string>,
  cards: readonly BuddyCardNotice[]
): string[] {
  return cards.filter((card) => !seen.has(card.id)).map((card) => card.label)
}

/**
 * Where the Buddy pane's cards live (plan 174 S3.14c, H-21, H-20): the voice
 * command strip and cards, the removal cards and the proposed posts, in one
 * capped scroll region so a stack of cards never pushes the questions off
 * the pane. A line counts the cards waiting when there is more than one,
 * and a polite live region announces each time-limited card once, when it
 * appears, so a screen reader hears what the eye sees.
 */
export function BuddyCardsArea({
  active,
  cards,
  children
}: {
  /** Something to show; off, the area renders nothing. */
  active: boolean
  cards: readonly BuddyCardNotice[]
  children?: ReactNode
}): ReactElement | null {
  const seenRef = useRef<Set<string>>(new Set())
  const [announcement, setAnnouncement] = useState('')
  const ids = cards.map((card) => card.id).join(' ')
  useEffect(() => {
    const fresh = freshBuddyCardLabels(seenRef.current, cards)
    for (const card of cards) seenRef.current.add(card.id)
    if (fresh.length > 0) setAnnouncement(fresh.join('. '))
    // `cards` is rebuilt every render; its ids say whether anything is new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])
  if (!active) return null
  return (
    <div className="flex shrink-0 flex-col border-b border-border" data-slot="buddy-cards">
      {cards.length > 1 ? (
        <p className="px-3 pt-1.5 text-label text-subtle" data-slot="buddy-cards-waiting">
          {cards.length} waiting
        </p>
      ) : null}
      <ScrollArea viewportClassName="max-h-64">{children}</ScrollArea>
      <p aria-live="polite" className="sr-only" data-slot="buddy-cards-announcement" role="status">
        {announcement}
      </p>
    </div>
  )
}
