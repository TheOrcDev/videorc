import type { ReactElement } from 'react'

import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * A control's tooltip with its shortcut, when one is bound (keyboard-first,
 * quietly; plan 174 S1.1, promoted from the Sources mixer). The trigger is a
 * wrapper, so the trigger's own attributes (`data-popup-open`, its handlers)
 * never land on the control, a Switch whose track styles read its state.
 */
export function ShortcutTooltip({
  label,
  accelerator,
  platform,
  className,
  children
}: {
  label: string
  /** The bound shortcut as an Electron accelerator; empty or absent when none is bound. */
  accelerator?: string
  platform?: string
  /** Layout for the wrapper (`flex flex-col` around a whole row), never styling. */
  className?: string
  children: ReactElement
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-flex', className)} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {accelerator ? <ShortcutKeys accelerator={accelerator} platform={platform} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}
