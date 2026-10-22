import { createElement, type HTMLAttributes, type ReactElement } from 'react'

import { cn } from '@/lib/utils'

/** The section-label recipe: 11 px / 600 in the tertiary tier. */
export const SECTION_LABEL = 'text-label font-semibold text-subtle'

/**
 * A section label (videorc-design; plan 174 S1.6a): the one recipe for the
 * small name over a group of rows or fields. Renders a span; pass `as` for a
 * heading or a paragraph where the document outline needs one.
 */
export function SectionLabel({
  as = 'span',
  className,
  ...props
}: { as?: 'span' | 'div' | 'p' | 'h3' | 'h4' } & HTMLAttributes<HTMLElement>): ReactElement {
  return createElement(as, {
    ...props,
    className: cn(SECTION_LABEL, className),
    'data-slot': 'section-label'
  })
}
