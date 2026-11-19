import { IconBase, type IconWeight } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import type { AppIcon } from '@/components/icons'

/**
 * The bell that opens Notifications (plan 250): Phosphor's Bell glyph, drawn
 * through Phosphor's own `IconBase` with two of its six weights, regular and
 * fill, like `AvatarPageIcon`. The bell sits in the status bar, which every
 * window paints first: a whole glyph module would carry all six weights into
 * the eager bundle. Any other weight draws regular. Import it from
 * `@/components/icons`, like every icon.
 */
const REGULAR = (
  <path d="M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z" />
)
const FILL = (
  <path d="M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216Z" />
)
const WEIGHTS = new Map<IconWeight, ReactElement>(
  (['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const).map((weight) => [
    weight,
    weight === 'fill' ? FILL : REGULAR
  ])
)

export const NotificationsIcon: AppIcon = (props) => <IconBase {...props} weights={WEIGHTS} />
