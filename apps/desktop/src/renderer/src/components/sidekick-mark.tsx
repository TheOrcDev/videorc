import { BuddyPageIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { cn } from '@/lib/utils'

/**
 * Sidekick's mark (plan 239 D7): its page glyph on a quiet tile, where the
 * helper shows large: the Sidekick page's status row and the Sidekick Live
 * consent dialog. The owner's stone character is the default avatar now, so
 * its artwork (`BuddyEmblem`, `BuddyIcon`) shows on avatar surfaces only.
 * Monochrome on purpose: the chrome carries no colour (videorc-design).
 */
const SIZES = {
  md: { tile: 'size-8 rounded-row', glyph: 'size-4' },
  lg: { tile: 'size-14 rounded-panel', glyph: 'size-7' }
} as const

export type SidekickMarkSize = keyof typeof SIZES

export function SidekickMark({
  size = 'md',
  className
}: {
  size?: SidekickMarkSize
  className?: string
}): ReactElement {
  const { tile, glyph } = SIZES[size]
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center bg-muted text-foreground ring-1 ring-border',
        tile,
        className
      )}
      data-slot="sidekick-mark"
    >
      <BuddyPageIcon className={glyph} />
    </span>
  )
}
