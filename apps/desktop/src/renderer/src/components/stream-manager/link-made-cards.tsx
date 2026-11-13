import type { ReactElement } from 'react'

import { LinkIcon } from '@/components/icons'
import { BuddyCard } from '@/components/stream-manager/buddy-card'
import type { CohostLinkMade } from '@/lib/backend'
import { platformLabel } from '@/lib/platform-copy'

/** "Linked Ada (Twitch) and ada_dev (YouTube)" (plan 225 D4 b). */
export function linkMadeTitle(link: CohostLinkMade): string {
  const [first, second] = link.names
  const [a, b] = link.platforms
  return `Linked ${first} (${platformLabel(a)}) and ${second} (${platformLabel(b)})`
}

/** A link card's id, for the pane's live region and its local Keep. */
export function linkMadeId(link: CohostLinkMade): string {
  return `link:${link.accountKey}:${link.at}`
}

/**
 * The viewers' own `!link`s (plan 225 D4 b): one card each, with Undo for
 * the 15 minutes the backend keeps it. Undo splits the second account off
 * again (`cohost.community.unlink`); Keep only hides the card here. Nothing
 * here posts to chat.
 */
export function LinkMadeCards({
  links,
  busyId,
  onUndo,
  onKeep
}: {
  links: readonly CohostLinkMade[]
  busyId: string | null
  onUndo: (link: CohostLinkMade) => void
  onKeep: (link: CohostLinkMade) => void
}): ReactElement | null {
  if (links.length === 0) return null
  return (
    <div className="flex flex-col gap-1 p-2" data-slot="link-made-cards">
      {links.map((link) => {
        const id = linkMadeId(link)
        return (
          <BuddyCard
            key={id}
            busy={busyId === id}
            decline={{ label: 'Keep', testId: 'link-made-keep' }}
            icon={LinkIcon}
            label={linkMadeTitle(link)}
            primary={{ label: 'Undo', testId: 'link-made-undo' }}
            testId="link-made-card"
            title={linkMadeTitle(link)}
            onDecline={() => onKeep(link)}
            onPrimary={() => onUndo(link)}
          >
            They typed !link in both chats. Their streams now count as one person.
          </BuddyCard>
        )
      })}
    </div>
  )
}
