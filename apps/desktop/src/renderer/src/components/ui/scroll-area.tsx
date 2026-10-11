import * as React from 'react'
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function ScrollArea({
  className,
  viewportClassName,
  children,
  type = 'scroll',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /**
   * Classes for the viewport, the element that scrolls: a cap (`max-h-64`)
   * goes here, since the root's height follows its content (plan 174 S3.14c).
   */
  viewportClassName?: string
}) {
  // type="scroll": the thumb shows while scrolling, like the macOS overlay
  // scrollbars (plan 050, D6).
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative', className)}
      type={type}
      {...props}
    >
      {/* Radix lays the viewport's content out as a table, which lets one long
          unbreakable row widen every row past the pane (plan 177: Activity's
          ⋯ menus). A block keeps content to the viewport's width. */}
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          'size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 [&>div]:block!',
          viewportClassName
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        // No track and no edge hairline: the gutter is invisible and only the
        // thumb reads. Matches the native scrollbar rules in styles.css so the
        // two populations cannot drift apart.
        'flex touch-none select-none bg-transparent p-[3px] transition-colors data-horizontal:h-2.5 data-horizontal:flex-col data-vertical:h-full data-vertical:w-2.5',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-[var(--scrollbar-thumb)] shadow-[inset_0_0_0_1px_var(--scrollbar-thumb-ring)] transition-colors hover:bg-[var(--scrollbar-thumb-hover)]"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
