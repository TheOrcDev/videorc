import { SettingsIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'

export function OpenPageCog({
  label,
  onOpen
}: {
  /** "Open {Page}": the tooltip and the name a screen reader says. */
  label: string
  onOpen: () => void
}): ReactElement {
  return (
    <ShortcutTooltip label={label}>
      <Button
        aria-label={label}
        data-testid="open-page-cog"
        size="icon-xs"
        type="button"
        variant="ghost"
        onClick={onOpen}
      >
        <SettingsIcon />
      </Button>
    </ShortcutTooltip>
  )
}
