import { PushPin } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import type {
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot,
  StreamPlatform
} from '@/lib/backend'
import { sortMessagesChronological } from '@/lib/live-chat-view'
import { cn } from '@/lib/utils'

const PLATFORM_LABELS: Record<StreamPlatform, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  x: 'X',
  custom: 'Custom'
}

const BOTTOM_THRESHOLD_PX = 64

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// The detached Comments window's reader: a glanceable, big-text feed for a
// second monitor — minimal chrome (a drag bar with pin + clear), no filter
// chips. Deliberately distinct from the dense in-app LiveChatPanel
// (purpose-built reader, per the plan's Auto-Grill Verdict). Live data arrives
// via IPC relay; this renders whatever snapshot it is handed.
export function CommentsReader({
  snapshot,
  onClear,
  alwaysOnTop = false,
  onToggleAlwaysOnTop
}: {
  snapshot: LiveChatSnapshot
  onClear?: () => void
  alwaysOnTop?: boolean
  onToggleAlwaysOnTop?: () => void
}): ReactElement {
  const messages = sortMessagesChronological(snapshot.messages)
  const savedTranscript = messages.length > 0 && snapshot.providers.length === 0
  const feedRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [unread, setUnread] = useState(0)
  const previousCount = useRef(messages.length)

  // Auto-scroll while pinned to the bottom; otherwise count what arrived.
  useEffect(() => {
    const added = messages.length - previousCount.current
    previousCount.current = messages.length
    if (pinned) {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
    } else if (added > 0) {
      setUnread((value) => value + added)
    }
  }, [messages.length, pinned])

  const onScroll = (): void => {
    const element = feedRef.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX
    setPinned(atBottom)
    if (atBottom) setUnread(0)
  }

  const jumpToLatest = (): void => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
    setPinned(true)
    setUnread(0)
  }

  return (
    <div className="relative flex h-screen flex-col bg-background text-foreground">
      {/* The whole drag bar moves the window (hiddenInset titlebar); the
          controls opt back out of the drag region. */}
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 [-webkit-app-region:drag]">
        <span className="text-xs font-medium text-subtle">
          {savedTranscript ? 'Saved comments' : 'Comments'}
        </span>
        <div className="flex items-center gap-0.5">
          {onToggleAlwaysOnTop ? (
            <Button
              aria-label="Keep this window on top"
              aria-pressed={alwaysOnTop}
              className={cn(
                'size-7 [-webkit-app-region:no-drag]',
                alwaysOnTop && 'text-foreground'
              )}
              size="icon"
              variant="ghost"
              onClick={onToggleAlwaysOnTop}
            >
              <PushPin className="size-4" weight={alwaysOnTop ? 'fill' : 'regular'} />
            </Button>
          ) : null}
          {onClear ? (
            <Button
              className="h-7 [-webkit-app-region:no-drag]"
              size="sm"
              variant="ghost"
              onClick={onClear}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </header>

      <div ref={feedRef} className="flex-1 overflow-y-auto px-3 py-2" onScroll={onScroll}>
        {messages.length === 0 ? (
          <OffAir providers={snapshot.providers} />
        ) : (
          <ol className="flex flex-col gap-2">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </ol>
        )}
      </div>

      {unread > 0 ? (
        <button
          type="button"
          className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-chip border border-border bg-popover px-3 py-1 text-xs font-medium shadow-soft"
          onClick={jumpToLatest}
        >
          {unread} new {unread === 1 ? 'message' : 'messages'} ↓
        </button>
      ) : null}
    </div>
  )
}

// Off-air / waiting state: show platform readiness if any provider is attached,
// otherwise prompt to start a livestream. Mirrors the in-app panel's copy.
function OffAir({ providers }: { providers: LiveChatProviderState[] }): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {providers.length > 0 ? (
        <>
          <div className="flex flex-wrap justify-center gap-1.5">
            {providers.map((provider) => (
              <ProviderPill key={provider.platform} provider={provider} />
            ))}
          </div>
          <p className="text-sm text-subtle">Waiting for comments…</p>
        </>
      ) : (
        <p className="text-sm text-subtle">Start a livestream to see comments here.</p>
      )}
    </div>
  )
}

function ProviderPill({ provider }: { provider: LiveChatProviderState }): ReactElement {
  const tone =
    provider.state === 'connected'
      ? 'text-success'
      : provider.state === 'failed'
        ? 'text-destructive'
        : 'text-warning'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-chip border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <span className={cn('size-1.5 shrink-0 rounded-full bg-current', tone)} />
      {PLATFORM_LABELS[provider.platform]}
    </span>
  )
}

function MessageRow({ message }: { message: LiveChatMessage }): ReactElement {
  const isPaid = message.eventType === 'paid'
  const isSystem =
    message.eventType === 'system' ||
    message.eventType === 'moderation' ||
    message.eventType === 'membership'
  return (
    <li
      className={cn(
        'rounded-row px-2 py-1.5 text-[15px] leading-snug',
        isPaid && 'bg-warning/10 ring-1 ring-warning/30',
        isSystem && 'text-muted-foreground italic',
        message.isDeleted && 'text-muted-foreground line-through'
      )}
    >
      <span className="mr-1.5 align-baseline text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
        {PLATFORM_LABELS[message.platform]}
      </span>
      <span className="font-semibold">{message.authorName}</span>
      {message.amountText ? (
        <span className="mx-1 rounded-chip bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">
          {message.amountText}
        </span>
      ) : null}{' '}
      <span className="text-foreground">{message.messageText}</span>
      <span className="ml-1.5 align-baseline text-[10px] text-muted-foreground/60 tabular-nums">
        {formatTime(message.receivedAt)}
      </span>
    </li>
  )
}
