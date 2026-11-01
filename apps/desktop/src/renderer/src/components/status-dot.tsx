import type { ReactElement } from 'react'

import { assertStatusWord, STATUS_TONE_CLASS } from '@/lib/status-word'
import type { StatusTone } from '@/lib/status-word'
import { cn } from '@/lib/utils'

/** The same tones as `StatusBadge`: one tone vocabulary. */
type StatusDotTone = StatusTone

interface StatusDotProps {
  tone?: StatusDotTone
  /** A word in sentence case, already mapped from its state: never recased. */
  label?: string
  /** Rings out from the dot while something runs (reduced motion stills it). */
  pulse?: boolean
  className?: string
}

/**
 * Ambient status: the glass status dot, optionally pulsing, and a monochrome
 * label. It replaces a loud header badge. `live` is recording and on air;
 * `error` is a failure.
 */
function StatusDot({
  tone = 'neutral',
  label,
  pulse = false,
  className
}: StatusDotProps): ReactElement {
  assertStatusWord(label, 'StatusDot')
  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1.5 text-xs',
        STATUS_TONE_CLASS[tone],
        className
      )}
      data-slot="status-dot"
      data-tone={tone}
    >
      <span className="relative flex size-1.5 shrink-0">
        {pulse ? (
          <span className="absolute inline-flex size-full rounded-full bg-(--chip-tone) opacity-60 motion-safe:animate-ping" />
        ) : null}
        <span className="glass-dot relative inline-flex size-1.5 rounded-full" />
      </span>
      {label ? <span className="truncate">{label}</span> : null}
    </span>
  )
}

export { StatusDot }
export type { StatusDotProps, StatusDotTone }
