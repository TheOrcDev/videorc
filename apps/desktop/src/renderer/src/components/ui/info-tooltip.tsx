'use client'

import { useId } from 'react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface InfoTooltipProps {
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
}

/**
 * What a chip, a dot or a short status word means, on hover and on keyboard
 * focus. A badge is not focusable, so a `title=` on it never reaches the
 * keyboard or a screen reader: the wrapper is the tooltip's focusable
 * trigger, and the text stays in the DOM as its description
 * (`aria-describedby`), not only while the tooltip is open. Base UI's tooltip
 * is visual only and describes nothing itself.
 *
 * `focusable={false}` is for a control that takes focus itself (a button
 * whose outcome or reason needs a sentence): it becomes the trigger and is
 * described, with no wrapper. A plain hint on a control is `Tooltip`; a
 * disabled control's reason is `DisabledReason`. Pass the text only when
 * there is one: with none the child renders exactly as it is.
 */
function InfoTooltip({
  content,
  children,
  focusable = true,
  tabIndex = 0,
  className,
  side,
  align
}: InfoTooltipProps): ReactElement {
  const descriptionId = useId()
  if (content === null || content === undefined || content === false || content === '') {
    return children
  }
  return (
    <>
      <Tooltip>
        {focusable ? (
          <TooltipTrigger
            render={
              <span
                aria-describedby={descriptionId}
                className={cn(
                  'rounded-chip focus-visible:ring-ring/30 inline-flex outline-none focus-visible:ring-3',
                  className
                )}
                data-slot="info-tooltip"
                tabIndex={tabIndex}
              />
            }
          >
            {children}
          </TooltipTrigger>
        ) : (
          // Base UI merges the trigger's props into the child's, so the child
          // is the trigger and the text stays its description while the
          // tooltip is closed too. A describedby of the child's own wins.
          <TooltipTrigger aria-describedby={descriptionId} render={children} />
        )}
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

export { InfoTooltip }
