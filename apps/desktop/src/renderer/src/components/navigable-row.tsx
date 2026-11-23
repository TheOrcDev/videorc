import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { ChevronRightIcon } from '@/components/icons'
import type { AppIcon } from '@/components/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface NavigableRowProps extends Omit<ComponentProps<'button'>, 'children' | 'value'> {
  icon?: AppIcon
  /**
   * A small visual in the icon's place, when the row shows a picture rather
   * than an icon (a thumbnail of the pick). Keep it 16 px tall.
   */
  leading?: ReactNode
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
 *
 * A row that opens a popover is the same row: the popover's trigger renders
 * it (`render={<NavigableRow … />}`), and the button takes the trigger's
 * props, ref and click.
 */
function NavigableRow({
  icon: RowIcon,
  leading,
  label,
  value,
  hint,
  className,
  onNavigate,
  onClick,
  ...buttonProps
}: NavigableRowProps): ReactElement {
  const navigates = onNavigate !== undefined || onClick !== undefined
  const rowClassName = cn(
    'h-row rounded-row flex w-full items-center gap-2.5 px-3 text-sm in-data-[slot=grouped-list]:rounded-none',
    className
  )
  // A text value gives way first: the label keeps its width and the value
  // truncates ("Microphone" beside "Microphone (HD Pro Webcam C920)", never
  // "Mic…"). A control value (a Stop button) keeps its width instead, and the
  // label truncates.
  const textValue = typeof value === 'string'
  const body = (
    <>
      {RowIcon ? (
        <RowIcon className="text-muted-foreground size-4 shrink-0" weight="duotone" />
      ) : (
        leading
      )}
      <span
        className={cn(
          'text-muted-foreground truncate text-left',
          textValue ? 'max-w-full shrink-0' : 'flex-1'
        )}
        data-slot="navigable-row-label"
      >
        {label}
      </span>
      <span
        className={cn(
          'text-foreground flex min-w-0 items-center gap-1.5 font-medium',
          textValue && 'flex-1 justify-end'
        )}
        data-slot="navigable-row-value"
      >
        {textValue ? <span className="truncate">{value}</span> : value}
        {navigates ? (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        ) : null}
      </span>
    </>
  )

  if (navigates) {
    const button = (
      <button
        {...buttonProps}
        className={cn(
          rowClassName,
          'hover:bg-accent focus-visible:ring-ring outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset'
        )}
        data-slot="navigable-row"
        onClick={(event) => {
          onClick?.(event)
          onNavigate?.()
        }}
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
