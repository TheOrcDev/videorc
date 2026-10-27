import { Slot } from 'radix-ui'
import type { ComponentProps, ReactElement } from 'react'

import { cn } from '@/lib/utils'

/**
 * A card for an object with a picture (plan 174 S1.6b, J1-19): a scene
 * thumbnail, a takeover screen, a Buddy. Lists of like things stay rows
 * (`GroupedList`); only a picture earns a card. The skill's one recipe: the
 * row radius (8 px), a 4% fill, a 1 px hairline and no shadow. `selected`
 * is the one in use (a brighter rim on the chrome plate, plan 208 S4, never
 * a colour); `interactive` gives the hover block. `asChild` puts the look on
 * the child, so a card can be a button.
 */
export function MediaCard({
  selected = false,
  interactive = false,
  asChild = false,
  className,
  ...props
}: ComponentProps<'div'> & {
  selected?: boolean
  interactive?: boolean
  asChild?: boolean
}): ReactElement {
  const card = {
    className: cn(
      'flex min-w-0 flex-col rounded-row border border-border bg-foreground/[0.04]',
      interactive && 'transition-colors duration-100 hover:bg-accent',
      selected && 'border-foreground/25 chrome-plate',
      className
    ),
    'data-selected': selected || undefined,
    // The card's own slot, on whichever element carries the look.
    'data-slot': 'media-card',
    ...props
  }
  return asChild ? <Slot.Root {...card} /> : <div {...card} />
}
