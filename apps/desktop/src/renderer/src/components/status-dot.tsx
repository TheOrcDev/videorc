import type { ReactElement } from 'react'

import type { StatusTone } from '@/components/status-badge'
import { assertStatusWord } from '@/lib/status-word'
import { cn } from '@/lib/utils'

/** The same tones as `StatusBadge` (plan 174 S1.3): one tone API. */
export type StatusDotTone = StatusTone

const toneClass: Record<StatusDotTone, string> = {
  good: 'tone-success',
  warn: 'tone-warning',
  error: 'tone-destructive',
  live: 'tone-live',
  neutral: 'tone-neutral'
}

/**
 * Ambient status: the glass status dot (plan 050, D9), optionally pulsing,
 * and a monochrome label. Replaces the loud header badges. `live` is record
 * and on air; `error` is a failure. The label is a word in sentence case,
 * already mapped from its state (plan 174 S1.3): the dot never recases it.
 */
export function StatusDot({
  tone = 'neutral',
  label,
  pulse = false,
  className
}: {
  tone?: StatusDotTone
  label?: string
  pulse?: boolean
  className?: string
}): ReactElement {
  assertStatusWord(label, 'StatusDot')
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs text-muted-foreground',
        toneClass[tone],
        className
      )}
      data-slot="status-dot"
      data-tone={tone}
    >
      <span className="relative flex size-1.5 shrink-0">
        {pulse ? (
          <span className="absolute inline-flex size-full rounded-full bg-(--chip-tone) opacity-60 motion-safe:animate-ping" />
        ) : null}
        <span className="relative inline-flex size-1.5 rounded-full glass-dot" />
      </span>
      {label ? <span className="truncate">{label}</span> : null}
    </span>
  )
}
