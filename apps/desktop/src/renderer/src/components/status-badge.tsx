import { AppIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { assertStatusWord } from '@/lib/status-word'
import { cn } from '@/lib/utils'

export type StatusTone = 'good' | 'warn' | 'error' | 'live' | 'neutral'

/** The tone utilities that set `--chip-tone`; the Studio's LCD status uses them too (plan 197). */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  good: 'tone-success',
  warn: 'tone-warning',
  error: 'tone-destructive',
  live: 'tone-live',
  neutral: 'tone-neutral'
}

/**
 * The status pill (plan 050, D9): a round glass chip. The label and value stay
 * monochrome; the tone glows in the dot, or in the leading icon when there is
 * one. An error or an on-air session tints the whole chip instead: it has to
 * interrupt. `value` is a word in sentence case, already mapped from its state
 * (plan 174 S1.3): the chip never recases it.
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
  assertStatusWord(value, 'StatusBadge')
  const emphasis = tone === 'error' || tone === 'live'
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        'inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-xs leading-none font-medium whitespace-nowrap',
        emphasis ? 'glass-chip-tinted' : 'glass-chip text-foreground',
        STATUS_TONE_CLASS[tone]
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
      <span className="max-w-40 truncate">{value}</span>
    </span>
  )
}
