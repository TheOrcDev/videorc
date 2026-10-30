'use client'

import { useId } from 'react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface DisabledReasonProps {
  /** The one reason, in a sentence; null or empty while the control works. */
  reason: ReactNode
  /** The disabled control. */
  children: ReactElement
  /** The description element's id, when a test or a caller needs a stable one. */
  id?: string
  /** The wrapper's accessible name, when the control's own name is not enough. */
  label?: string
  /** False for a menu or select item, which takes the highlight itself. */
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
}

/**
 * Why a control is disabled, on hover and on keyboard focus. A disabled
 * control takes no pointer events and no focus, so a `title=` on it never
 * shows. The wrapper is the tooltip's focusable trigger, and the reason stays
 * in the DOM as its description (`aria-describedby`), not only while the
 * tooltip is open. Locked means disabled, with one reason.
 *
 * Pass the reason only while the control is disabled: with no reason the
 * control renders exactly as it is, with no extra tab stop.
 *
 * `focusable={false}` is for the items of a menu or a select. Base UI keeps a
 * disabled item in the arrow-key order (it is `aria-disabled`, and the
 * highlight lands on it), so the item itself takes the hover and the focus and
 * is described, with no wrapper and no second stop in the list. Never use it
 * on a native disabled `<button>`: Chromium sends it no pointer events and it
 * takes no focus, so only the wrapper works.
 */
function DisabledReason({
  reason,
  children,
  id,
  label,
  focusable = true,
  tabIndex = 0,
  className,
  side,
  align
}: DisabledReasonProps): ReactElement {
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
                  'rounded-chip focus-visible:ring-ring/30 inline-flex outline-none focus-visible:ring-3',
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

export { DisabledReason }
