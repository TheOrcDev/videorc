import { PushPin } from '@phosphor-icons/react'
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import type { CaptionStyleId, CaptionsStatus, CaptionsUpdate } from '@/lib/backend'
import { captionStyleDefinition } from '@/lib/caption-overlay'
import { latestFinalCaptionText } from '@/lib/captions-ui'
import { cn } from '@/lib/utils'

/**
 * Big-text caption display for the detached Captions window: a dark glass
 * reader meant for a second monitor — or to be captured into the scene as a
 * caption bar. Minimal chrome (drag bar + pin); the newest line is emphasized.
 */
export function CaptionsReader({
  lines,
  status = { state: 'idle' },
  styleId = 'classic',
  position = 'bottom',
  textSize = 'm',
  alwaysOnTop = false,
  onToggleAlwaysOnTop
}: {
  lines: CaptionsUpdate[]
  status?: CaptionsStatus
  styleId?: CaptionStyleId
  position?: 'top' | 'bottom'
  textSize?: 's' | 'm' | 'l'
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
  const latestFinal = latestFinalCaptionText(lines)
  const statusLabel = readerStatusLabel(status)
  const latestTextClass = textSize === 's' ? 'text-xl' : textSize === 'l' ? 'text-4xl' : 'text-3xl'
  const readerAppearance = captionReaderAppearance(styleId)

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* The whole drag bar moves the window (hiddenInset titlebar); the
          controls opt back out of the drag region. */}
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 [-webkit-app-region:drag]">
        <span className="flex items-center gap-2 text-xs font-medium text-subtle">
          Live captions
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className={cn(
                'size-1.5 rounded-full bg-muted-foreground',
                (status.state === 'listening' || status.state === 'live') && 'bg-success',
                (status.state === 'reconnecting' || status.state === 'degraded') && 'bg-warning',
                (status.state === 'blocked' || status.state === 'error') && 'bg-destructive'
              )}
            />
            {statusLabel}
          </span>
        </span>
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
        className={cn(
          'flex flex-1 flex-col gap-2 overflow-y-auto px-5 py-4',
          position === 'top' ? 'justify-start' : 'justify-end'
        )}
        ref={feedRef}
      >
        {recent.length === 0 ? (
          <p className="text-lg text-muted-foreground">
            Waiting for captions — turn on Live captions, then record or go live. Captions
            transcribe your microphone during a session.
          </p>
        ) : (
          recent.map((line, index) => {
            const latest = index === recent.length - 1
            return (
              <p
                className={cn(
                  'leading-snug transition-colors',
                  latest ? latestTextClass : 'text-xl text-muted-foreground',
                  latest && 'font-semibold text-foreground',
                  latest && line.kind === 'partial' && 'text-muted-foreground',
                  latest && readerAppearance.className
                )}
                key={`${line.sessionClientId}-${line.seq}`}
                style={
                  latest
                    ? { ...readerAppearance.style, opacity: line.kind === 'partial' ? 0.72 : 1 }
                    : undefined
                }
              >
                {line.text}
              </p>
            )
          })
        )}
      </div>
      <span aria-live="polite" className="sr-only">
        {latestFinal ? `Final caption: ${latestFinal}` : ''}
      </span>
    </div>
  )
}

/** CSS projection of the shared canvas style registry for the detached reader. */
export function captionReaderAppearance(styleId: CaptionStyleId): {
  className: string
  style: CSSProperties
} {
  const definition = captionStyleDefinition(styleId)
  const hasPlate = definition.plate !== 'none'
  return {
    className: cn(
      hasPlate && 'border border-white/10 shadow-xl',
      definition.plate === 'glass' && 'backdrop-blur-xl',
      definition.wide && 'w-full'
    ),
    style: {
      backgroundColor: hasPlate ? definition.backgroundColor : 'transparent',
      borderRadius: `${definition.radiusFactor}em`,
      color: definition.textColor,
      fontWeight: definition.fontWeight,
      padding: hasPlate
        ? `${definition.paddingYFactor}em ${definition.paddingXFactor}em`
        : undefined,
      textAlign: definition.align,
      textShadow: '0 2px 3px rgba(0, 0, 0, 0.58)',
      WebkitTextStroke:
        definition.strokeColor && definition.strokeWidthFactor
          ? `${Math.max(1, definition.strokeWidthFactor * 14)}px ${definition.strokeColor}`
          : undefined
    }
  }
}

function readerStatusLabel(status: CaptionsStatus): string {
  switch (status.state) {
    case 'listening':
    case 'live':
      return 'Listening'
    case 'starting':
      return 'Starting'
    case 'reconnecting':
      return 'Reconnecting'
    case 'degraded':
      return 'Higher delay'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return 'Error'
    case 'ready':
      return 'Ready'
    default:
      return 'Idle'
  }
}
