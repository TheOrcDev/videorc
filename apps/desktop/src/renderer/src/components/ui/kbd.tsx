import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Key chip (plan 050, D9): a glass keycap with a bright top edge and a dark
 * bottom edge, and the secondary-gray glyph. Used beside every primary action
 * ("⌘", "K", "↵", aliases like "st").
 */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-chip border px-1 font-sans text-[11px] font-medium text-muted-foreground select-none glass-keycap',
        className
      )}
      {...props}
    />
  )
}

/** Lays out a sequence of key chips ("⌘ K") with the standard gap. */
function KbdGroup({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
