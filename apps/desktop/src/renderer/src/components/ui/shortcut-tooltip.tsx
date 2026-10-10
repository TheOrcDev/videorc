import type { ReactElement } from 'react'

import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * A control's tooltip with its shortcut, when one is bound (keyboard-first,
 * quietly; plan 174 S1.1, promoted from the Sources mixer). The trigger is a
 * wrapper: Radix's TooltipTrigger writes `data-state` onto its child, which
 * would replace a Switch's checked/unchecked, the hook its track styles use.
 */
export function ShortcutTooltip({
  label,
  keys,
  children
}: {
  label: string
  /** Key chips of the bound shortcut; empty when none is bound. */
  keys: readonly string[]
  children: ReactElement
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keys.length > 0 ? (
          <KbdGroup>
            {keys.map((glyph, index) => (
              <Kbd key={`${glyph}-${index}`}>{glyph}</Kbd>
            ))}
          </KbdGroup>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
