import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, UIEvent } from 'react'

import type {
  LiveChatMessage,
  LiveChatProviderConnectionState,
  LiveChatProviderState,
  LiveChatSnapshot,
  StreamPlatform
} from '@/lib/backend'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  LIVE_CHAT_PLATFORMS,
  MAX_RENDERED_LIVE_CHAT_MESSAGES,
  filterMessagesByPlatform,
  nextUnreadCount,
  shouldAutoscroll,
  visibleMessages
} from '@/lib/live-chat-view'
import { cn } from '@/lib/utils'

const PLATFORM_LABELS: Record<StreamPlatform, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  x: 'X',
  custom: 'Custom'
}

const BOTTOM_THRESHOLD_PX = 48

function providerToneClass(state: LiveChatProviderConnectionState): string {
  switch (state) {
    case 'connected':
      return 'border-emerald-500/40 text-emerald-300'
    case 'connecting':
    case 'reconnecting':
    case 'waiting':
      return 'border-amber-500/40 text-amber-300'
    case 'failed':
      return 'border-red-500/40 text-red-300'
    default:
      return 'border-border text-muted-foreground'
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ProviderPill({ provider }: { provider: LiveChatProviderState }): ReactElement {
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 font-normal', providerToneClass(provider.state))}
      title={provider.message}
    >
      <span className="font-medium">{PLATFORM_LABELS[provider.platform]}</span>
      <span className="opacity-70">· {provider.state}</span>
    </Badge>
  )
}

function MessageRow({ message }: { message: LiveChatMessage }): ReactElement {
  const isPaid = message.eventType === 'paid'
  const isSystem =
    message.eventType === 'system' ||
    message.eventType === 'moderation' ||
    message.eventType === 'membership'
  return (
    <div
      className={cn(
        'rounded-md px-2 py-1 text-sm leading-snug',
        isPaid && 'bg-amber-500/10 ring-1 ring-amber-500/30',
        isSystem && 'text-muted-foreground italic',
        message.isDeleted && 'text-muted-foreground line-through'
      )}
    >
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {formatTime(message.receivedAt)}{' '}
      </span>
      <span className="text-[10px] font-medium uppercase text-muted-foreground/80">
        {PLATFORM_LABELS[message.platform]}{' '}
      </span>
      <span className="font-semibold">{message.authorName}</span>
      {message.amountText ? (
        <Badge variant="secondary" className="mx-1 px-1 py-0 text-[10px]">
          {message.amountText}
        </Badge>
      ) : null}
      <span className="text-muted-foreground"> · </span>
      <span>{message.messageText}</span>
    </div>
  )
}

export function LiveChatPanel({
  snapshot,
  onClearLocal
}: {
  snapshot: LiveChatSnapshot
  onClearLocal: () => Promise<void> | void
}): ReactElement {
  const [activePlatforms, setActivePlatforms] = useState<StreamPlatform[]>([])
  const [paused, setPaused] = useState(false)
  const [unread, setUnread] = useState(0)
  const feedRef = useRef<HTMLDivElement>(null)
  const previousCount = useRef(snapshot.messages.length)

  const enabled = useMemo(() => new Set(activePlatforms), [activePlatforms])
  const messages = useMemo(
    () => filterMessagesByPlatform(snapshot.messages, enabled),
    [snapshot.messages, enabled]
  )
  const filterablePlatforms = useMemo(
    () =>
      LIVE_CHAT_PLATFORMS.filter((platform) =>
        snapshot.providers.some((p) => p.platform === platform)
      ),
    [snapshot.providers]
  )

  // Count messages that arrived while paused so the "jump to latest" pill can show them.
  useEffect(() => {
    const delta = snapshot.messages.length - previousCount.current
    previousCount.current = snapshot.messages.length
    if (delta > 0) {
      setUnread((current) => nextUnreadCount(current, paused, delta))
    }
  }, [snapshot.messages.length, paused])

  // Stick to the newest message unless the user scrolled up.
  // Stick the FEED (not the page) to its newest message. Using scrollIntoView here would
  // scroll every scrollable ancestor — including the app's <main> — to the bottom on mount.
  useEffect(() => {
    if (shouldAutoscroll(paused) && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
      setUnread(0)
    }
  }, [messages, paused])

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD_PX
    setPaused(!atBottom)
    if (atBottom) setUnread(0)
  }

  function jumpToLatest(): void {
    setPaused(false)
    setUnread(0)
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
  }

  const hasProviders = snapshot.providers.length > 0
  const hasMessages = messages.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {hasProviders ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {snapshot.providers.map((provider) => (
            <ProviderPill key={provider.platform} provider={provider} />
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        {filterablePlatforms.length > 1 ? (
          <ToggleGroup
            type="multiple"
            size="sm"
            value={activePlatforms}
            onValueChange={(value) => setActivePlatforms(value as StreamPlatform[])}
            className="flex-wrap"
          >
            {filterablePlatforms.map((platform) => (
              <ToggleGroupItem key={platform} value={platform} className="px-2 text-xs">
                {PLATFORM_LABELS[platform]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <span className="text-xs text-muted-foreground">
            {activePlatforms.length ? 'Filtered' : 'All platforms'}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => void onClearLocal()}
          disabled={!hasMessages}
        >
          Clear
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={feedRef}
          onScroll={handleScroll}
          className="flex h-full max-h-[28rem] min-h-[8rem] flex-col gap-0.5 overflow-y-auto rounded-lg border border-border p-1.5"
        >
          {hasMessages ? (
            visibleMessages(messages, MAX_RENDERED_LIVE_CHAT_MESSAGES).map((message) => (
              <MessageRow key={message.id} message={message} />
            ))
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
              {hasProviders
                ? 'No comments yet. Comments appear here once you go live.'
                : 'Connect a YouTube or Twitch account to read live comments.'}
            </div>
          )}
        </div>

        {paused && unread > 0 ? (
          <Button
            size="sm"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs shadow-lg"
            onClick={jumpToLatest}
          >
            {unread} new ↓
          </Button>
        ) : null}
      </div>
    </div>
  )
}
