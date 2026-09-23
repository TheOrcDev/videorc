import { AppIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { cn } from '@/lib/utils'

export type StatusTone = 'good' | 'warn' | 'error' | 'neutral'

const toneClass: Record<Exclude<StatusTone, 'error'>, string> = {
  good: 'tone-success',
  warn: 'tone-warning',
  neutral: 'tone-neutral'
}

/**
 * The status pill (plan 050, D9): a round glass chip. The label and value stay
 * monochrome; the tone glows in the dot, or in the leading icon when there is
 * one. An error tints the whole chip instead: it has to interrupt.
 */
export function StatusBadge({
  label,
  value,
  tone = 'neutral',
  icon: LeadingIcon
}: {
  label?: string
  value: string
  tone?: StatusTone
  icon?: AppIcon
}): ReactElement {
  const emphasis = tone === 'error'
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        'inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-xs leading-none font-medium whitespace-nowrap',
        emphasis
          ? 'glass-chip-tinted tone-destructive'
          : `glass-chip text-foreground ${toneClass[tone]}`
      )}
    >
      {LeadingIcon ? (
        <LeadingIcon
          aria-hidden
          className={cn('size-3.5 shrink-0', !emphasis && 'text-(--chip-tone)')}
          weight="fill"
        />
      ) : emphasis ? null : (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full glass-dot" />
      )}
      {label ? (
        <span className={cn('font-normal', emphasis ? 'opacity-80' : 'text-muted-foreground')}>
          {label}
        </span>
      ) : null}
      <span className="max-w-40 truncate capitalize">{value}</span>
    </span>
  )
}
