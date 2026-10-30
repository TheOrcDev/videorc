import type { ReactElement } from 'react'

import { PinIcon } from '@/components/icons'
import { StatusBarAction } from '@/components/status-bar-action'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The control's one name in every window (plan 174 S1.6b, I-29). */
export const PIN_WINDOW_LABEL = 'Keep on top'

/**
 * Keep on top (plan 174 S1.6b, D-PAT): the pin every detached window shares.
 * One name, one icon, a pressed state a screen reader hears, and the name on
 * hover. A filled pin means the window stays over other apps. The header
 * look sits in a WindowHeader (Notes, the Captions reader); the status-bar
 * look is a StatusBarAction (Stream Manager, whose title row stays bare).
 *
 * It brings its own TooltipProvider, with the desktop delay: the detached
 * windows have no provider of their own.
 */
export function PinWindowButton({
  pinned,
  onPinnedChange,
  variant = 'header',
  className
}: {
  pinned: boolean
  onPinnedChange: (pinned: boolean) => void
  variant?: 'header' | 'status-bar'
  className?: string
}): ReactElement {
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
        pressed={pinned}
        onClick={toggle}
      />
    )
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={PIN_WINDOW_LABEL}
              aria-pressed={pinned}
              className={cn(
                '[-webkit-app-region:no-drag]',
                pinned ? 'text-foreground' : 'text-muted-foreground',
                className
              )}
              data-testid="pin-window-button"
              size="icon"
              type="button"
              variant="ghost"
              onClick={toggle}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent>{PIN_WINDOW_LABEL}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
