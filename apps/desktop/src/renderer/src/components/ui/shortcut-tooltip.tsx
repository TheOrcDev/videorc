import type { ReactElement } from 'react'

import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ShortcutTooltipProps {
  label: string
  /** The bound shortcut as an Electron accelerator; empty or absent when none is bound. */
  accelerator?: string
  platform?: string
  /** Layout for the wrapper (`flex flex-col` around a whole row), never styling. */
  className?: string
  children: ReactElement
}

/**
 * A control's tooltip with its shortcut, when one is bound: keyboard-first,
 * quietly. The trigger is a wrapper, so the tooltip's handlers and its
 * `data-popup-open` land on a span and never on the control: a Switch keeps
 * its own `data-checked`, a Button its own `render`.
 */
function ShortcutTooltip({
  label,
  accelerator,
  platform,
  className,
  children
}: ShortcutTooltipProps): ReactElement {
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

export { ShortcutTooltip, type ShortcutTooltipProps }
