import type { ReactElement, ReactNode } from 'react'

import { Popover, PopoverContent } from '@/components/ui/popover'

// The bell's popover (plan 250). It lives in the list's lazy chunk, not with
// the bell: Base UI's popover is 12 KB gzip, and the bell is in every
// window's first paint. So there is no PopoverTrigger: the bell's own button
// opens and closes it, and this positions against that button.

export interface NotificationPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bell's button: where focus returns, and whose press is its own toggle. */
  trigger: HTMLElement | null
  /** What the list lines up with, when that is not the bell. */
  anchor?: Element | null
  children: ReactNode
}

export function NotificationPopover({
  open,
  onOpenChange,
  trigger,
  anchor,
  children
}: NotificationPopoverProps): ReactElement {
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // A press on the bell is the bell's toggle: closing here too would
        // let the click that follows open the list again.
        if (
          !next &&
          details.reason === 'outside-press' &&
          details.event.target instanceof Node &&
          trigger?.contains(details.event.target)
        ) {
          details.cancel()
          return
        }
        onOpenChange(next)
      }}
    >
      <PopoverContent
        align="end"
        anchor={anchor ?? trigger ?? undefined}
        className="w-[380px] max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0"
        data-videorc-notification-list=""
        finalFocus={() => trigger}
        side="top"
        sideOffset={8}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
