'use client'

import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { createContext, useContext } from 'react'

import { cn } from '@/lib/utils'

/**
 * When the thumb shows. `scroll` (the default) shows it while scrolling, like
 * the macOS overlay scrollbars; `hover` also while the pointer is over the
 * area; `auto` whenever the content overflows; `always` even when it doesn't.
 */
type ScrollAreaType = 'scroll' | 'hover' | 'auto' | 'always'

const ScrollAreaTypeContext = createContext<ScrollAreaType>('scroll')

// Base UI marks the scrollbar with data-scrolling and data-hovering; the thumb
// fades out 150 ms after the scroll ends and appears at once when it starts.
// A hovered scrollbar stays visible, so it can still be dragged.
const SCROLLBAR_VISIBILITY: Record<ScrollAreaType, string> = {
  always: '',
  auto: '',
  hover:
    'opacity-0 hover:opacity-100 data-hovering:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0',
  scroll: 'opacity-0 hover:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0'
}

function ScrollArea({
  className,
  viewportClassName,
  children,
  type = 'scroll',
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  /** When the thumb shows. */
  type?: ScrollAreaType
  /**
   * Classes for the viewport, the element that scrolls: a cap (`max-h-64`)
   * goes here, since the root's height follows its content.
   */
  viewportClassName?: string
}) {
  return (
    <ScrollAreaTypeContext value={type}>
      <ScrollAreaPrimitive.Root
        className={cn('relative', className)}
        data-slot="scroll-area"
        data-type={type}
        {...props}
      >
        <ScrollAreaPrimitive.Viewport
          className={cn(
            'focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-3 focus-visible:outline-1',
            viewportClassName
          )}
          data-slot="scroll-area-viewport"
        >
          {children}
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    </ScrollAreaTypeContext>
  )
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  const type = useContext(ScrollAreaTypeContext)
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        // No track and no edge hairline: the gutter is invisible and only the
        // thumb reads, as the macOS overlay scrollbars of every native
        // scroller do.
        'flex touch-none bg-transparent p-[3px] transition-opacity duration-150 ease-out select-none data-horizontal:h-2.5 data-horizontal:flex-col data-vertical:h-full data-vertical:w-2.5',
        SCROLLBAR_VISIBILITY[type],
        className
      )}
      data-orientation={orientation}
      data-slot="scroll-area-scrollbar"
      keepMounted={type === 'always'}
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-(--scrollbar-thumb) shadow-[inset_0_0_0_1px_var(--scrollbar-thumb-ring)] transition-colors duration-100 hover:bg-(--scrollbar-thumb-hover)"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
