import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'

import { ErrorIcon } from '@/components/icons'
import { PinWindowButton } from '@/components/pin-window-button'
import { StatusDot } from '@/components/status-dot'
import { WindowHeader } from '@/components/window-frame'
import type { CaptionStyleId, CaptionsStatus, CaptionsUpdate } from '@/lib/backend'
import { captionStyleDefinition } from '@/lib/caption-overlay'
import { captionsReaderNotice } from '@/lib/captions-page-view'
import { latestFinalCaptionText } from '@/lib/captions-ui'
import { captionsStatusLabel, captionsStatusTone } from '@/lib/state-labels'
import { cn } from '@/lib/utils'
import { WINDOW_NAMES } from '../../../shared/window-names'

/**
 * Big-text caption display for the detached Captions reader window: a dark glass
 * reader meant for a second monitor — or to be captured into the scene as a
 * caption bar. Minimal chrome (the window header: its name, one status dot and
 * Keep on top); the newest line is emphasized, and the body says what is
 * happening while there is nothing to read.
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
  // The body follows the state (D-25, J2-18): off, waiting, starting, or a
  // failure with its reason, which shows even over earlier captions.
  const notice = captionsReaderNotice(status, recent.length)
  const latestFinal = latestFinalCaptionText(lines)
  const statusLabel = captionsStatusLabel(status)
  const latestTextClass = textSize === 's' ? 'text-xl' : textSize === 'l' ? 'text-4xl' : 'text-3xl'
  const readerAppearance = captionReaderAppearance(styleId)

  return (
    <div className="flex h-screen flex-col text-foreground">
      {/* The shared window header (plan 174 S1.6b): the title on the traffic
          lights' line, the state as a status dot, and Keep on top. */}
      <WindowHeader
        meta={<StatusDot label={statusLabel} tone={captionsStatusTone(status)} />}
        title={WINDOW_NAMES.captions}
      >
        {onToggleAlwaysOnTop ? (
          <PinWindowButton pinned={alwaysOnTop} onPinnedChange={() => onToggleAlwaysOnTop()} />
        ) : null}
      </WindowHeader>

      <div
        className={cn(
          'flex flex-1 flex-col gap-2 overflow-y-auto px-5 py-4',
          position === 'top' ? 'justify-start' : 'justify-end'
        )}
        ref={feedRef}
      >
        {notice ? (
          <p
            className={cn(
              'flex items-start gap-2 text-lg select-text',
              notice.failed ? 'text-foreground' : 'text-muted-foreground'
            )}
            data-testid="captions-reader-notice"
            role={notice.failed ? 'alert' : undefined}
          >
            {notice.failed ? (
              <ErrorIcon
                aria-hidden
                className="mt-1 size-4 shrink-0 text-destructive"
                weight="fill"
              />
            ) : null}
            <span>{notice.text}</span>
          </p>
        ) : null}
        {recent.map((line, index) => {
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
        })}
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
      // The glass plate is its translucent colour alone: CSS backdrop-filter
      // on a vibrancy window wedged the compositor (plan 050), so the
      // renderer has none.
      hasPlate && 'border border-white/10',
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
