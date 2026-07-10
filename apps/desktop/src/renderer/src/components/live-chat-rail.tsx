import { ArrowSquareOut, ChatCircle, X } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { LiveChatPanel } from '@/components/live-chat-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { displayKeyGlyph } from '@/lib/platform'
import type { CommentHighlightState, LiveChatSnapshot } from '../../../shared/backend'

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
  highlightState,
  highlightApplyingId = null,
  highlightFailure = null,
  onHighlight,
  platform
}: {
  snapshot: LiveChatSnapshot
  onClearLocal: () => void
  onClose: () => void
  windowOpen: boolean
  onPopOut: () => void | Promise<void>
  highlightedId?: string | null
  highlightState?: CommentHighlightState
  highlightApplyingId?: string | null
  highlightFailure?: { messageId: string; reason: string } | null
  onHighlight?: (message: import('../../../shared/backend').LiveChatMessage) => void
  platform?: string
}): ReactElement {
  const modKey = displayKeyGlyph('⌘', platform)
  const live = Boolean(snapshot.sessionId)
  const mode = live ? 'Live' : snapshot.messages.length > 0 ? 'History' : 'Idle'
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-3 rounded-panel border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <ChatCircle className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <span className="text-sm font-medium">Comments</span>
        <Badge
          className="h-4 px-1.5 text-[10px]"
          variant={mode === 'Live' ? 'success' : mode === 'History' ? 'secondary' : 'outline'}
        >
          {mode}
        </Badge>
        <span className="flex-1" />
        <Kbd>{modKey}⇧J</Kbd>
        <Button
          aria-label={windowOpen ? 'Bring comments back into the app' : 'Open comments in a window'}
          aria-keyshortcuts="Meta+Shift+J"
          className="size-7"
          size="icon"
          variant="ghost"
          onClick={() => void onPopOut()}
        >
          <ArrowSquareOut data-icon="inline-start" />
        </Button>
        <Button
          aria-label="Close comments"
          className="size-7"
          size="icon"
          variant="ghost"
          onClick={onClose}
        >
          <X data-icon="inline-start" />
        </Button>
      </div>
      <Separator />
      {windowOpen ? (
        <Empty className="border-0 px-4 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ArrowSquareOut weight="duotone" />
            </EmptyMedia>
            <EmptyDescription>Comments are open in a separate window.</EmptyDescription>
          </EmptyHeader>
          <Button size="sm" variant="outline" onClick={() => void onPopOut()}>
            Bring back into the app
          </Button>
        </Empty>
      ) : (
        <LiveChatPanel
          highlightedId={highlightedId}
          highlightApplyingId={highlightApplyingId}
          highlightFailure={highlightFailure}
          highlightState={highlightState}
          snapshot={snapshot}
          onClearLocal={onClearLocal}
          onHighlight={live && snapshot.sessionId ? onHighlight : undefined}
        />
      )}
    </aside>
  )
}
