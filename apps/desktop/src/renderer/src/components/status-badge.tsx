import type { ReactElement } from 'react'

import type { AppIcon } from '@/components/icons'
import { assertStatusWord, STATUS_TONE_CLASS } from '@/lib/status-word'
import type { StatusTone } from '@/lib/status-word'
import { cn } from '@/lib/utils'

interface StatusBadgeProps {
  /** A muted label before the value: "Chat", "Captions". */
  label?: string
  /** A word in sentence case, already mapped from its state: never recased. */
  value: string
  tone?: StatusTone
  /** Replaces the dot and takes the tone (monochrome on `error` and `live`). */
  icon?: AppIcon
  className?: string
}

/**
 * The status pill: a round glass chip, 22 px tall. The label and value stay
 * monochrome; the tone glows in the dot, or in the leading icon when there is
 * one. An error or an on-air session tints the whole chip instead: it has to
 * interrupt.
 */
function StatusBadge({
  label,
  value,
  tone = 'neutral',
  icon: LeadingIcon,
  className
}: StatusBadgeProps): ReactElement {
  assertStatusWord(value, 'StatusBadge')
  const emphasis = tone === 'error' || tone === 'live'
  let mark: ReactElement | null = null
  if (LeadingIcon) {
    mark = (
      <LeadingIcon
        aria-hidden
        className={cn('size-3.5 shrink-0', !emphasis && 'text-(--chip-tone)')}
        weight="fill"
      />
    )
  } else if (!emphasis) {
    mark = <span aria-hidden className="glass-dot size-1.5 shrink-0 rounded-full" />
  }
  return (
    <span
      className={cn(
        'inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-xs leading-none font-medium whitespace-nowrap',
        emphasis ? 'glass-chip-tinted' : 'glass-chip text-foreground',
        STATUS_TONE_CLASS[tone],
        className
      )}
      data-slot="status-badge"
      data-tone={tone}
    >
      {mark}
      {label ? (
        <span className={cn('font-normal', emphasis ? 'opacity-80' : 'text-muted-foreground')}>
          {label}
        </span>
      ) : null}
      <span className="max-w-40 truncate">{value}</span>
    </span>
  )
}

// The tone vocabulary lives in lib/status-word; it's re-exported here because
// callers that draw their own status (an LCD readout) import it with the badge.
export { STATUS_TONE_CLASS } from '@/lib/status-word'
export type { StatusTone } from '@/lib/status-word'
export { StatusBadge }
export type { StatusBadgeProps }
