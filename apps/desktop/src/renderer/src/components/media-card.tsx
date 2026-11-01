'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import type { ReactElement } from 'react'

import { cn } from '@/lib/utils'

type MediaCardProps = useRender.ComponentProps<'div'> & {
  /** The one in use: a brighter rim on the chrome plate, never a color. */
  selected?: boolean
  /** Takes the hover block, for a card that is a button or a link. */
  interactive?: boolean
}

/**
 * A card for an object with a picture: a scene thumbnail, a background, a
 * takeover screen. Lists of like things stay rows; only a picture earns a
 * card. One recipe: the row radius (8 px), a 4% fill, a 1 px hairline and no
 * shadow. `render` puts the look on another element, so a card can be a
 * button.
 */
function MediaCard({
  selected = false,
  interactive = false,
  className,
  render,
  ...props
}: MediaCardProps): ReactElement {
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {
        className: cn(
          'rounded-row border-border bg-foreground/4 flex min-w-0 flex-col border',
          interactive && 'hover:bg-accent transition-colors duration-100',
          selected && 'chrome-plate border-foreground/25',
          className
        ),
        // The card's own slot, on whichever element carries the look.
        'data-selected': selected || undefined,
        'data-slot': 'media-card'
      } as useRender.ElementProps<'div'>,
      props
    ),
    render
  })
}

export { MediaCard }
export type { MediaCardProps }
