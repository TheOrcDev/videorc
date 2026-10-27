import type { ReactElement } from 'react'

import { ArrowDownIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'

/**
 * The one way back to the newest message while a chat list is not following
 * it (owner call, 2026-10-21): "12 new", "New chat" when the count is
 * unknown, or "Latest". A glass chip, not an ad-hoc pill (plan 174 H-17): the
 * Badge is the button. Shared by the Stream Manager's chat and the Studio's
 * Chat section (plan 204); it sits over the bottom of the list.
 */
export function ChatJumpChip({
  unread,
  incomplete,
  onFollow
}: {
  unread: number
  incomplete: boolean
  onFollow: () => void
}): ReactElement {
  return (
    <Badge asChild className="absolute inset-x-0 bottom-2 mx-auto">
      <button
        aria-label={`Chat paused: ${incomplete ? 'New chat' : unread > 0 ? `${unread} new` : 'reading back'}. Jump to the newest`}
        data-testid="chat-paused"
        type="button"
        onClick={onFollow}
      >
        {incomplete ? 'New chat' : unread > 0 ? `${unread} new` : 'Latest'}
        <ArrowDownIcon data-icon="inline-end" />
      </button>
    </Badge>
  )
}
