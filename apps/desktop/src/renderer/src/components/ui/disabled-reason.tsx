import { useId, type ComponentProps, type ReactElement, type ReactNode } from 'react'

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
 * `focusable={false}` is for items a menu or a select already moves through
 * (they skip disabled items): the item itself takes the hover and is
 * described, with no wrapper in the list. Never use it on a native disabled
 * `<button>`: Chromium sends it no pointer events, so only the wrapper works.
 */
export function DisabledReason({
  reason,
  children,
  id,
  label,
  focusable = true,
  tabIndex = 0,
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
  /**
   * The wrapper's tab stop: -1 keeps it out of the tab order while it still
   * takes the hover (a control in a roving-focus row that isn't the active one).
   */
  tabIndex?: number
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
        {focusable ? (
          <TooltipTrigger
            render={
              <span
                aria-describedby={descriptionId}
                aria-label={label}
                className={cn(
                  'inline-flex rounded-chip outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                  className
                )}
                data-slot="disabled-reason"
                tabIndex={tabIndex}
              />
            }
          >
            {children}
          </TooltipTrigger>
        ) : (
          // The item itself carries the description and takes the hover while
          // disabled: Base UI merges these into the item's own props, its
          // classes first, so the pointer-events override wins.
          <TooltipTrigger
            aria-describedby={descriptionId}
            className="data-disabled:pointer-events-auto"
            render={children}
          />
        )}
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
