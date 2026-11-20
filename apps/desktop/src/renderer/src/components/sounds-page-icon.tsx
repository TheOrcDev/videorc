import { IconBase, type IconWeight } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import type { AppIcon } from '@/components/icons'

/**
 * The Sounds page's row (owner 2026-11-20): Phosphor's SpeakerHigh glyph,
 * drawn through Phosphor's own `IconBase` with two of its six weights,
 * regular and fill (the sidebar fills the row while it is the page), for the
 * same reason as `AvatarPageIcon`: the sidebar is eager, and a whole glyph
 * module carries all six weights into the bundle every window loads at
 * start. Any other weight draws regular. Import it from `@/components/icons`.
 */
const REGULAR = (
  <path d="M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z" />
)
const FILL = (
  <path d="M160,32.25V223.69a8.29,8.29,0,0,1-3.91,7.18,8,8,0,0,1-9-.56l-65.57-51A4,4,0,0,1,80,176.16V79.84a4,4,0,0,1,1.55-3.15l65.57-51a8,8,0,0,1,10,.16A8.27,8.27,0,0,1,160,32.25ZM60,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H60a4,4,0,0,0,4-4V84A4,4,0,0,0,60,80Zm126.77,20.84a8,8,0,0,0-.72,11.3,24,24,0,0,1,0,31.72,8,8,0,1,0,12,10.58,40,40,0,0,0,0-52.88A8,8,0,0,0,186.74,100.84Zm40.89-26.17a8,8,0,1,0-11.92,10.66,64,64,0,0,1,0,85.34,8,8,0,1,0,11.92,10.66,80,80,0,0,0,0-106.66Z" />
)
const WEIGHTS = new Map<IconWeight, ReactElement>(
  (['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const).map((weight) => [
    weight,
    weight === 'fill' ? FILL : REGULAR
  ])
)

export const SoundsPageIcon: AppIcon = (props) => <IconBase {...props} weights={WEIGHTS} />
