import { CaretRight } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Fact row with an optional navigate affordance (videorc-design): icon · label
 * · value, and a chevron when clicking jumps to the page that OWNS the value.
 * Shared home for the pattern SessionPanel introduced — Settings and Publish
 * rows must render identically (UX rework E0 primitive).
 */
export function NavigableRow({
  icon: RowIcon,
  label,
  value,
  className,
  onNavigate
}: {
  icon?: Icon
  label: string
  value: ReactNode
  className?: string
  /** When set, the row is a button that jumps to the value's one true home. */
  onNavigate?: () => void
}): ReactElement {
  const body = (
    <>
      {RowIcon ? (
        <RowIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      ) : null}
      <span className="flex-1 truncate text-left text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        {typeof value === 'string' ? <span className="truncate">{value}</span> : value}
        {onNavigate ? <CaretRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      </span>
    </>
  )

  if (onNavigate) {
    return (
      <button
        className={cn(
          'flex w-full items-center gap-3 rounded-row px-2.5 py-2 text-sm transition-colors hover:bg-accent',
          className
        )}
        type="button"
        onClick={onNavigate}
      >
        {body}
      </button>
    )
  }
  return (
    <div className={cn('flex items-center gap-3 rounded-row px-2.5 py-2 text-sm', className)}>
      {body}
    </div>
  )
}
