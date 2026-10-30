import type { ReactElement } from 'react'

import { PinIcon } from '@/components/icons'
import { StatusBarAction } from '@/components/status-bar-action'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The control's one name in every window. */
const PIN_WINDOW_LABEL = 'Keep on top'

interface PinWindowButtonProps {
  pinned: boolean
  onPinnedChange: (pinned: boolean) => void
  /** `header` in a WindowHeader; `status-bar` where the title row stays bare. */
  variant?: 'header' | 'status-bar'
  className?: string
}

/**
 * Keep on top: the pin every detached window shares. One name, one icon, a
 * pressed state a screen reader hears, and the name on hover. A filled pin
 * means the window stays over other apps. The header look sits in a
 * WindowHeader (Notes, the Captions reader); the status-bar look is a
 * StatusBarAction (Stream Manager, whose title row stays bare).
 *
 * Base UI's Tooltip needs no provider, so it works in a window that has
 * none; under one it joins that window's delay group.
 */
function PinWindowButton({
  pinned,
  onPinnedChange,
  variant = 'header',
  className
}: PinWindowButtonProps): ReactElement {
  const icon = <PinIcon aria-hidden weight={pinned ? 'fill' : 'regular'} />
  const toggle = (): void => onPinnedChange(!pinned)
  if (variant === 'status-bar') {
    // A StatusBarAction names an icon alone in its own tooltip.
    return (
      <StatusBarAction
        className={className}
        data-testid="pin-window-button"
        icon={icon}
        label={PIN_WINDOW_LABEL}
        onClick={toggle}
        pressed={pinned}
      />
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={PIN_WINDOW_LABEL}
            aria-pressed={pinned}
            className={cn(
              '[-webkit-app-region:no-drag]',
              // Unpinned reads a tier quieter; ghost's hover still brightens it.
              // oxlint-disable-next-line shadcn/no-restyle -- see above.
              pinned ? 'text-foreground' : 'text-muted-foreground',
              className
            )}
            data-testid="pin-window-button"
            onClick={toggle}
            size="icon"
            type="button"
            variant="ghost"
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent>{PIN_WINDOW_LABEL}</TooltipContent>
    </Tooltip>
  )
}

export { PinWindowButton, PIN_WINDOW_LABEL, type PinWindowButtonProps }
