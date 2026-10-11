import { cloneElement, useId, type ComponentProps, type ReactElement, type ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * What a chip, a dot or a short status word means, on hover and on keyboard
 * focus (plan 174 S1.10, J1-6). A badge is not focusable, so a `title=` on it
 * never reaches the keyboard or a screen reader: the wrapper is the tooltip's
 * focusable trigger, and the text stays in the DOM as its description
 * (`aria-describedby`), not only while the tooltip is open.
 *
 * `focusable={false}` is for a control that takes focus itself (a button
 * whose outcome or reason needs a sentence): it becomes the trigger and is
 * described, with no wrapper. A plain hint on a control is `Tooltip`; a
 * disabled control's reason is `DisabledReason`. Pass the text only when
 * there is one: with none the child renders exactly as it is.
 */
export function InfoTooltip({
  content,
  children,
  focusable = true,
  tabIndex = 0,
  className,
  side,
  align
}: {
  /** The explanation, in a sentence; null or empty when there is none. */
  content: ReactNode
  /** The chip, dot or status word it explains. */
  children: ReactElement
  /** False when the child is a control that takes focus itself. */
  focusable?: boolean
  /**
   * The wrapper's tab stop: -1 keeps it out of the tab order while it still
   * takes the hover (a chip in a roving-focus row that isn't the active one).
   */
  tabIndex?: number
  /** Layout for the wrapper (`shrink-0`, `min-w-0`), never styling. */
  className?: string
  side?: ComponentProps<typeof TooltipContent>['side']
  align?: ComponentProps<typeof TooltipContent>['align']
}): ReactElement {
  const descriptionId = useId()
  if (content === null || content === undefined || content === false || content === '') {
    return children
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {focusable ? (
            <span
              aria-describedby={descriptionId}
              className={cn(
                'inline-flex rounded-chip outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                className
              )}
              data-slot="info-tooltip"
              tabIndex={tabIndex}
            >
              {children}
            </span>
          ) : (
            // The child's own prop wins over the trigger's, so the text stays
            // its description while the tooltip is closed too.
            cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
              'aria-describedby': descriptionId
            })
          )}
        </TooltipTrigger>
        <TooltipContent align={align} side={side}>
          {content}
        </TooltipContent>
      </Tooltip>
      {/* Out of the reading order, so a screen reader never meets it twice, yet
          still the trigger's description: aria-describedby reads hidden text. */}
      <span data-slot="info-tooltip-text" hidden id={descriptionId}>
        {content}
      </span>
    </>
  )
}
