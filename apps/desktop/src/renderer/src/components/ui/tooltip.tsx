'use client'

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'

import { cn } from '@/lib/utils'

// Desktop tooltips wait for a deliberate hover. Under a provider, tooltips
// share its delay group: moving from one to the next opens at once. Base UI
// needs no provider, so a Tooltip rendered outside every window's provider
// (a test, a stray portal root) still mounts, with the trigger's own 600 ms.
function TooltipProvider({ delay = 600, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

// The tooltip tier of the float glass: never an inverted pill, and no arrow.
// It fades and scales from 0.98 in 100 ms, with no slide.
function TooltipContent({
  className,
  side = 'top',
  sideOffset = 0,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            'rounded-row glass-float-tooltip text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 border px-2 py-1 text-xs duration-100 has-data-[slot=kbd]:pr-1 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50',
            className
          )}
          data-slot="tooltip-content"
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
