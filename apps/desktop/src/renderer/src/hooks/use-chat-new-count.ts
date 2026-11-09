import { useMemo, useState } from 'react'

import type { LiveChatSnapshot } from '@/lib/backend'
import { chatNewSinceSeen, chatSeenMark, type ChatSeenMark } from '@/lib/studio-chat'

/**
 * The Studio's Chat row while live (plan 213 B1): chat messages that arrived
 * since the Stream Manager last showed. While it shows, nothing is new; when
 * it hides, chat as it was then is what the streamer saw. Renderer state
 * only: the window's open and visible flags stand in for its focus.
 */
export function useChatNewCount(snapshot: LiveChatSnapshot, streamManagerShowing: boolean): number {
  const [seen, setSeen] = useState<{ showing: boolean; mark: ChatSeenMark | null }>(() => ({
    showing: streamManagerShowing,
    mark: null
  }))
  // Marked during render on the show or hide itself, so no message slips
  // between the window hiding and an effect running.
  if (seen.showing !== streamManagerShowing) {
    setSeen({ showing: streamManagerShowing, mark: chatSeenMark(snapshot) })
  }
  return useMemo(
    () => (streamManagerShowing ? 0 : chatNewSinceSeen(snapshot, seen.mark)),
    [seen.mark, snapshot, streamManagerShowing]
  )
}
