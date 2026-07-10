import { ChatCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { CommentRow, commentHighlightPresentationForMessage } from '@/components/comment-row'
import { CommentsDestinationStatus } from '@/components/comments-destination-status'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type {
  CommentHighlightState,
  LiveChatMessage,
  LiveChatSnapshot,
  StreamPlatform
} from '@/lib/backend'
import {
  LIVE_CHAT_PLATFORMS,
  MAX_RENDERED_LIVE_CHAT_MESSAGES,
  filterMessagesByPlatform,
  liveChatEmptyMessage,
  nextUnreadCount,
  shouldAutoscroll,
  visibleMessages
} from '@/lib/live-chat-view'

const BOTTOM_THRESHOLD_PX = 48

function scrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
}

export function LiveChatPanel({
  snapshot,
  onClearLocal,
  highlightedId = null,
  highlightState,
  highlightApplyingId = null,
  highlightFailure = null,
  onHighlight
}: {
  snapshot: LiveChatSnapshot
  onClearLocal: () => Promise<void> | void
  highlightedId?: string | null
  highlightState?: CommentHighlightState
  highlightApplyingId?: string | null
  highlightFailure?: { messageId: string; reason: string } | null
  onHighlight?: (message: LiveChatMessage) => void
}): ReactElement {
  const [activePlatforms, setActivePlatforms] = useState<StreamPlatform[]>([])
  const [paused, setPaused] = useState(false)
  const [unread, setUnread] = useState(0)
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const previousCount = useRef(snapshot.messages.length)

  const enabled = useMemo(() => new Set(activePlatforms), [activePlatforms])
  const messages = useMemo(
    () => filterMessagesByPlatform(snapshot.messages, enabled),
    [snapshot.messages, enabled]
  )
  const filterablePlatforms = useMemo(
    () =>
      LIVE_CHAT_PLATFORMS.filter((platform) =>
        snapshot.providers.some((provider) => provider.platform === platform)
      ),
    [snapshot.providers]
  )

  useEffect(() => {
    const viewport = scrollViewport(scrollRootRef.current)
    viewportRef.current = viewport
    if (!viewport) return

    const handleScroll = (): void => {
      const atBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < BOTTOM_THRESHOLD_PX
      setPaused(!atBottom)
      if (atBottom) setUnread(0)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const delta = snapshot.messages.length - previousCount.current
    previousCount.current = snapshot.messages.length
    if (delta > 0) {
      setUnread((current) => nextUnreadCount(current, paused, delta))
    }
  }, [snapshot.messages.length, paused])

  useEffect(() => {
    const viewport = viewportRef.current
    if (shouldAutoscroll(paused) && viewport) {
      viewport.scrollTop = viewport.scrollHeight
      setUnread(0)
    }
  }, [messages, paused])

  const jumpToLatest = (): void => {
    const viewport = viewportRef.current
    setPaused(false)
    setUnread(0)
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
  }

  const hasMessages = messages.length > 0
  const emptyMessage =
    activePlatforms.length > 0
      ? 'No comments from the selected destinations.'
      : liveChatEmptyMessage(snapshot)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <CommentsDestinationStatus providers={snapshot.providers} />

      <div className="flex items-center justify-between gap-2">
        {filterablePlatforms.length > 1 ? (
          <ToggleGroup
            className="flex-wrap"
            size="sm"
            type="multiple"
            value={activePlatforms}
            onValueChange={(value) => setActivePlatforms(value as StreamPlatform[])}
          >
            {filterablePlatforms.map((platform) => (
              <ToggleGroupItem
                key={platform}
                aria-label={`Filter ${CHAT_PLATFORM_LABELS[platform]} comments`}
                className="px-2 text-xs"
                value={platform}
              >
                <ChatPlatformIcon decorative platform={platform} />
                {CHAT_PLATFORM_LABELS[platform]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <span className="text-xs text-muted-foreground">
            {activePlatforms.length ? 'Filtered' : 'All destinations'}
          </span>
        )}
        <Button
          disabled={!hasMessages}
          size="sm"
          title="Clears this view only; saved Library history remains."
          type="button"
          variant="ghost"
          onClick={() => void onClearLocal()}
        >
          Clear view
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">Clear view keeps Library history.</p>
      <Separator />

      <div className="relative min-h-0 flex-1">
        <ScrollArea ref={scrollRootRef} className="h-full max-h-[28rem] min-h-[8rem]">
          {hasMessages ? (
            <ol aria-label="Comments" className="flex flex-col gap-0.5 py-1">
              {visibleMessages(messages, MAX_RENDERED_LIVE_CHAT_MESSAGES).map((message) => (
                <CommentRow
                  key={message.id}
                  highlight={commentHighlightPresentationForMessage({
                    messageId: message.id,
                    highlightedId,
                    state: highlightState,
                    applyingId: highlightApplyingId,
                    failure: highlightFailure
                  })}
                  message={message}
                  onHighlight={onHighlight}
                />
              ))}
            </ol>
          ) : (
            <Empty className="min-h-[8rem] border-0 p-4">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ChatCircle weight="duotone" />
                </EmptyMedia>
                <EmptyTitle className="text-sm">No comments yet</EmptyTitle>
                <EmptyDescription className="text-xs">{emptyMessage}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </ScrollArea>

        {paused && unread > 0 ? (
          <Button
            className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs shadow-lg"
            size="sm"
            type="button"
            variant="secondary"
            onClick={jumpToLatest}
          >
            {unread} new ↓
          </Button>
        ) : null}
      </div>
    </div>
  )
}
