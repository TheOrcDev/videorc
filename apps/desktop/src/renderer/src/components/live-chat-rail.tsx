import { ArrowSquareOut, ChatCircle, X } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { LiveChatPanel } from '@/components/live-chat-panel'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { displayKeyGlyph } from '@/lib/platform'
import type { LiveChatSnapshot } from '../../../shared/backend'

// The chat rail is live while streaming and can stay mounted after stop while
// the retained in-memory transcript has comments.
// When the detached Comments window is open the feed lives there (one live
// feed at a time, mirroring how the preview detaches); the rail shows a
// bring-back placeholder.
export function LiveChatRail({
  snapshot,
  onClearLocal,
  onClose,
  windowOpen,
  onPopOut,
  highlightedId = null,
  onHighlight,
  platform
}: {
  snapshot: LiveChatSnapshot
  onClearLocal: () => void
  onClose: () => void
  windowOpen: boolean
  onPopOut: () => void | Promise<void>
  highlightedId?: string | null
  onHighlight?: (message: import('../../../shared/backend').LiveChatMessage) => void
  platform?: string
}): ReactElement {
  const modKey = displayKeyGlyph('⌘', platform)
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-3 rounded-panel border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <ChatCircle className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <span className="flex-1 text-sm font-medium">Live chat</span>
        <Kbd>{modKey}J</Kbd>
        <Button
          aria-label={windowOpen ? 'Bring comments back into the app' : 'Open comments in a window'}
          aria-keyshortcuts="Meta+Shift+J"
          className="size-7"
          size="icon"
          variant="ghost"
          onClick={() => void onPopOut()}
        >
          <ArrowSquareOut className="size-4" />
        </Button>
        <Button
          aria-label="Close live chat"
          className="size-7"
          size="icon"
          variant="ghost"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {windowOpen ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-row border border-dashed bg-muted/20 px-4 py-8 text-center">
          <ArrowSquareOut className="size-5 text-muted-foreground" weight="duotone" />
          <p className="text-sm text-muted-foreground">Comments are open in a separate window.</p>
          <Button size="sm" variant="outline" onClick={() => void onPopOut()}>
            Bring back into the app
          </Button>
        </div>
      ) : (
        <LiveChatPanel
          highlightedId={highlightedId}
          snapshot={snapshot}
          onClearLocal={onClearLocal}
          onHighlight={onHighlight}
        />
      )}
    </aside>
  )
}
