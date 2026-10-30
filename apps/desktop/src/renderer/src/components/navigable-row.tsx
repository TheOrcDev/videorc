import { AppIcon, ChevronRightIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Fact row with an optional navigate affordance (videorc-design): icon · label
 * · value, and a chevron when clicking jumps to the page that OWNS the value.
 * On the row metrics (plan 174 S1.6a, A-15 and B-25): 32 px, 12 px padding,
 * flush inside a GroupedList. Studio's Session rows and Settings' pointer rows
 * are this one component.
 */
export function NavigableRow({
  icon: RowIcon,
  label,
  value,
  hint,
  className,
  onNavigate
}: {
  icon?: AppIcon
  label: string
  value: ReactNode
  /**
   * The facts a summarised value stands for, on hover and on focus (plan 174
   * S1.10): only on a row that navigates, since only a button takes focus.
   */
  hint?: ReactNode
  className?: string
  /** When set, the row is a button that jumps to the value's one true home. */
  onNavigate?: () => void
}): ReactElement {
  const rowClassName = cn(
    'flex h-row w-full items-center gap-2.5 rounded-row px-3 text-sm in-data-[slot=grouped-list]:rounded-none',
    className
  )
  const body = (
    <>
      {RowIcon ? (
        <RowIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      ) : null}
      <span className="flex-1 truncate text-left text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        {typeof value === 'string' ? <span className="truncate">{value}</span> : value}
        {onNavigate ? (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
    </>
  )

  if (onNavigate) {
    const button = (
      <button
        className={cn(
          rowClassName,
          'outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
        )}
        data-slot="navigable-row"
        type="button"
        onClick={onNavigate}
      >
        {body}
      </button>
    )
    if (!hint) return button
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipContent align="start">{hint}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <div className={rowClassName} data-slot="navigable-row">
      {body}
    </div>
  )
}

/** A hint of several facts, one per line (the tooltip lays out a row by default). */
export function NavigableRowHintLines({ lines }: { lines: readonly string[] }): ReactElement {
  return (
    <span className="flex flex-col gap-0.5">
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>{line}</span>
      ))}
    </span>
  )
}
