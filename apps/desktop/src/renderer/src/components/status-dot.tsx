import type { ReactElement } from 'react'

import { cn } from '@/lib/utils'

export type StatusDotTone = 'good' | 'warn' | 'error' | 'neutral'

const toneClass: Record<StatusDotTone, string> = {
  good: 'tone-success',
  warn: 'tone-warning',
  error: 'tone-live',
  neutral: 'tone-neutral'
}

/**
 * Ambient status: the glass status dot (plan 050, D9), optionally pulsing,
 * and a monochrome label. Replaces the loud header badges.
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
      {label ? <span className="truncate capitalize">{label}</span> : null}
    </span>
  )
}
