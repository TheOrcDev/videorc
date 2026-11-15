import { IconBase, type IconWeight } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import type { AppIcon } from '@/components/icons'

/**
 * The Avatar page's row (plan 239): Phosphor's Smiley glyph, drawn through
 * Phosphor's own `IconBase` with two of its six weights, regular and fill
 * (the sidebar fills the row while it is the page). A whole glyph module
 * carries all six weights into the eager bundle, which every window loads at
 * start, and the sidebar is eager: two weights keep the row inside the
 * renderer budget. Any other weight draws regular. Import it from
 * `@/components/icons`, like every icon.
 */
const REGULAR = (
  <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216ZM80,108a12,12,0,1,1,12,12A12,12,0,0,1,80,108Zm96,0a12,12,0,1,1-12-12A12,12,0,0,1,176,108Zm-1.07,48c-10.29,17.79-27.4,28-46.93,28s-36.63-10.2-46.92-28a8,8,0,1,1,13.84-8c7.47,12.91,19.21,20,33.08,20s25.61-7.1,33.07-20a8,8,0,0,1,13.86,8Z" />
)
const FILL = (
  <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24ZM92,96a12,12,0,1,1-12,12A12,12,0,0,1,92,96Zm82.92,60c-10.29,17.79-27.39,28-46.92,28s-36.63-10.2-46.92-28a8,8,0,1,1,13.84-8c7.47,12.91,19.21,20,33.08,20s25.61-7.1,33.08-20a8,8,0,1,1,13.84,8ZM164,120a12,12,0,1,1,12-12A12,12,0,0,1,164,120Z" />
)
const WEIGHTS = new Map<IconWeight, ReactElement>(
  (['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const).map((weight) => [
    weight,
    weight === 'fill' ? FILL : REGULAR
  ])
)

export const AvatarPageIcon: AppIcon = (props) => <IconBase {...props} weights={WEIGHTS} />
