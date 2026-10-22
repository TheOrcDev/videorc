import type { ReactElement } from 'react'

import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * A control's tooltip with its shortcut, when one is bound (keyboard-first,
 * quietly; plan 174 S1.1, promoted from the Sources mixer). The trigger is a
 * wrapper: Radix's TooltipTrigger writes `data-state` onto its child, which
 * would replace a Switch's checked/unchecked, the hook its track styles use.
 */
export function ShortcutTooltip({
  label,
  accelerator,
  platform,
  children
}: {
  label: string
  /** The bound shortcut as an Electron accelerator; empty or absent when none is bound. */
  accelerator?: string
  platform?: string
  children: ReactElement
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {accelerator ? <ShortcutKeys accelerator={accelerator} platform={platform} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}
