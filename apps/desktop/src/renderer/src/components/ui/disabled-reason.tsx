import { cloneElement, useId, type ComponentProps, type ReactElement, type ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Why a control is disabled, on hover and on keyboard focus (plan 174 S1.1,
 * J1-2). A disabled control takes no pointer events and no focus, so a
 * `title=` on it never shows. The wrapper is the tooltip's focusable trigger,
 * and the reason stays in the DOM as its description (`aria-describedby`),
 * not only while the tooltip is open. Locked means disabled, with one reason.
 *
 * Pass the reason only while the control is disabled: with no reason the
 * control renders exactly as it is, with no extra tab stop.
 *
 * `focusable={false}` is for Radix items a menu or a select already moves
 * through (they skip disabled items): the item itself takes the hover and is
 * described, with no wrapper in the list. Never use it on a native disabled
 * `<button>`: Chromium sends it no pointer events, so only the wrapper works.
 */
export function DisabledReason({
  reason,
  children,
  id,
  label,
  focusable = true,
  className,
  side,
  align
}: {
  /** The one reason, in a sentence; null or empty while the control works. */
  reason: ReactNode
  /** The disabled control. */
  children: ReactElement
  /** The description element's id, when a test or a caller needs a stable one. */
  id?: string
  /** The wrapper's accessible name, when the control's own name is not enough. */
  label?: string
  focusable?: boolean
  /** Layout for the wrapper (`flex-1`, `w-full`), never styling. */
  className?: string
  side?: ComponentProps<typeof TooltipContent>['side']
  align?: ComponentProps<typeof TooltipContent>['align']
}): ReactElement {
  const generatedId = useId()
  if (reason === null || reason === undefined || reason === false || reason === '') {
    return children
  }
  const descriptionId = id ?? generatedId
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {focusable ? (
            <span
              aria-describedby={descriptionId}
              aria-label={label}
              className={cn(
                'inline-flex rounded-chip outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                className
              )}
              data-slot="disabled-reason"
              tabIndex={0}
            >
              {children}
            </span>
          ) : (
            withDescription(children, descriptionId)
          )}
        </TooltipTrigger>
        <TooltipContent align={align} side={side}>
          {reason}
        </TooltipContent>
      </Tooltip>
      {/* Out of the reading order, so a screen reader never meets it twice, yet
          still the trigger's description: aria-describedby reads hidden text. */}
      <span data-slot="disabled-reason-text" hidden id={descriptionId}>
        {reason}
      </span>
    </>
  )
}

/** The item itself carries the description and takes the hover while disabled. */
function withDescription(child: ReactElement, descriptionId: string): ReactElement {
  const { className } = child.props as { className?: string }
  return cloneElement(child as ReactElement<{ className?: string; 'aria-describedby'?: string }>, {
    'aria-describedby': descriptionId,
    className: cn(className, 'data-disabled:pointer-events-auto')
  })
}
