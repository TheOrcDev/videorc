import { SettingsIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'

/**
 * A Studio section's way to the page that owns it (plan 235 D4): one small
 * cog, named by its tooltip and its accessible name ("Open Sources", "Open
 * Assets"). It sits at the end of a row, or in a section's header, in the
 * compact 24 px size a row's trailing action takes. The Retro LCD twin is
 * `LcdPanelCog`.
 */
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
