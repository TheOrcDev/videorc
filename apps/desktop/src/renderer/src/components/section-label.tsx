import type { HTMLAttributes, ReactElement } from 'react'

import { cn } from '@/lib/utils'

/** The section-label recipe: 11 px / 600 in the tertiary tier. */
const SECTION_LABEL = 'text-label font-semibold text-subtle'

type SectionLabelProps = {
  /** The element: a span by default, a heading or a paragraph where the outline needs one. */
  as?: 'span' | 'div' | 'p' | 'h3' | 'h4'
} & HTMLAttributes<HTMLElement>

/**
 * A section label: the one recipe for the small name over a group of rows or
 * fields. Renders a span; pass `as` for a heading or a paragraph where the
 * document outline needs one.
 */
function SectionLabel({
  as: Element = 'span',
  className,
  ...props
}: SectionLabelProps): ReactElement {
  return <Element {...props} className={cn(SECTION_LABEL, className)} data-slot="section-label" />
}

export { SECTION_LABEL, SectionLabel, type SectionLabelProps }
