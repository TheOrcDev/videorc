import type { ReactElement, ReactNode } from 'react'

import { ChevronRightIcon } from '@/components/icons'
import type { AppIcon } from '@/components/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface NavigableRowProps {
  icon?: AppIcon
  label: string
  value: ReactNode
  /**
   * The facts a summarised value stands for, on hover and on focus: only on
   * a row that navigates, since only a button takes focus.
   */
  hint?: ReactNode
  className?: string
  /** When set, the row is a button that jumps to the value's one true home. */
  onNavigate?: () => void
}

/**
 * A fact row with an optional navigate affordance: icon · label · value, and
 * a chevron when clicking jumps to the page that OWNS the value. On the row
 * metrics: 32 px, 12 px padding, flush inside a GroupedList. The Studio's
 * Session rows and Settings' pointer rows are this one component.
 */
function NavigableRow({
  icon: RowIcon,
  label,
  value,
  hint,
  className,
  onNavigate
}: NavigableRowProps): ReactElement {
  const rowClassName = cn(
    'h-row rounded-row flex w-full items-center gap-2.5 px-3 text-sm in-data-[slot=grouped-list]:rounded-none',
    className
  )
  const body = (
    <>
      {RowIcon ? (
        <RowIcon className="text-muted-foreground size-4 shrink-0" weight="duotone" />
      ) : null}
      <span className="text-muted-foreground flex-1 truncate text-left">{label}</span>
      <span className="text-foreground flex min-w-0 items-center gap-1.5 font-medium">
        {typeof value === 'string' ? <span className="truncate">{value}</span> : value}
        {onNavigate ? (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        ) : null}
      </span>
    </>
  )

  if (onNavigate) {
    const button = (
      <button
        className={cn(
          rowClassName,
          'hover:bg-accent focus-visible:ring-ring outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset'
        )}
        data-slot="navigable-row"
        onClick={onNavigate}
        type="button"
      >
        {body}
      </button>
    )
    if (!hint) {
      return button
    }
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
function NavigableRowHintLines({ lines }: { lines: readonly string[] }): ReactElement {
  return (
    <span className="flex flex-col gap-0.5" data-slot="navigable-row-hint">
      {lines.map((line, index) => (
        // Lines may repeat ("1080p", "1080p"), so the position keeps keys unique.
        <span key={`${index}-${line}`}>{line}</span>
      ))}
    </span>
  )
}

export { NavigableRow, NavigableRowHintLines, type NavigableRowProps }
