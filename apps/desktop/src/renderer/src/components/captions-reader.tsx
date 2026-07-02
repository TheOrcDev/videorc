import { PushPin } from '@phosphor-icons/react'
import { useEffect, useRef, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import type { CaptionsUpdate } from '@/lib/backend'
import { cn } from '@/lib/utils'

/**
 * Big-text caption display for the detached Captions window: a dark glass
 * reader meant for a second monitor — or to be captured into the scene as a
 * caption bar. Minimal chrome (drag bar + pin); the newest line is emphasized.
 */
export function CaptionsReader({
  lines,
  alwaysOnTop = false,
  onToggleAlwaysOnTop
}: {
  lines: CaptionsUpdate[]
  alwaysOnTop?: boolean
  onToggleAlwaysOnTop?: () => void
}): ReactElement {
  const feedRef = useRef<HTMLDivElement | null>(null)

  // Captions always track the latest speech — no unread state, just follow.
  useEffect(() => {
    const feed = feedRef.current
    if (feed) {
      feed.scrollTop = feed.scrollHeight
    }
  }, [lines])

  const recent = lines.slice(-8)

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* The whole drag bar moves the window (hiddenInset titlebar); the
          controls opt back out of the drag region. */}
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 [-webkit-app-region:drag]">
        <span className="text-xs font-medium text-subtle">Live captions</span>
        {onToggleAlwaysOnTop ? (
          <Button
            aria-label="Keep this window on top"
            aria-pressed={alwaysOnTop}
            className={cn('size-7 [-webkit-app-region:no-drag]', alwaysOnTop && 'text-foreground')}
            size="icon"
            variant="ghost"
            onClick={onToggleAlwaysOnTop}
          >
            <PushPin className="size-4" weight={alwaysOnTop ? 'fill' : 'regular'} />
          </Button>
        ) : null}
      </header>

      <div
        aria-live="polite"
        className="flex flex-1 flex-col justify-end gap-2 overflow-y-auto px-5 py-4"
        ref={feedRef}
      >
        {recent.length === 0 ? (
          <p className="text-lg text-muted-foreground">
            Waiting for captions — enable Live captions in the Streaming tab.
          </p>
        ) : (
          recent.map((line, index) => (
            <p
              className={cn(
                'text-2xl leading-snug',
                index === recent.length - 1
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground'
              )}
              key={`${line.sessionClientId}-${line.seq}`}
            >
              {line.text}
            </p>
          ))
        )}
      </div>
    </div>
  )
}
