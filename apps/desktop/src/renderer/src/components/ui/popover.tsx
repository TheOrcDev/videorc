'use client'

import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { useRender } from '@base-ui/react/use-render'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The element a PopoverAnchor registered, so the popover positions against it
 * instead of its trigger. Base UI takes an `anchor` on the Positioner and has
 * no Anchor part; this keeps the part, so a popover can open from a status
 * bar's button and still line up with the whole bar.
 */
interface PopoverAnchorValue {
  anchor: Element | null
  setAnchor: (element: Element | null) => void
}

const PopoverAnchorContext = React.createContext<PopoverAnchorValue | null>(null)

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  const [anchor, setAnchor] = React.useState<Element | null>(null)
  const value = React.useMemo(() => ({ anchor, setAnchor }), [anchor])
  return (
    <PopoverAnchorContext.Provider value={value}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </PopoverAnchorContext.Provider>
  )
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** What the popover lines up with, when that isn't its trigger. Renders a `<div>`. */
function PopoverAnchor({ render, ref, ...props }: useRender.ComponentProps<'div'>) {
  const setAnchor = React.useContext(PopoverAnchorContext)?.setAnchor ?? null
  return useRender({
    defaultTagName: 'div',
    props: { 'data-slot': 'popover-anchor', ...props },
    ref: [ref ?? null, setAnchor],
    render
  })
}

// The popup tier of the float glass at 10 px, fading and scaling from 0.98
// in 100 ms, with no slide.
function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  anchor,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'anchor' | 'side' | 'sideOffset'
  >) {
  const registered = React.useContext(PopoverAnchorContext)?.anchor
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor ?? registered ?? undefined}
        className="isolate z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            'glass-float text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] z-50 flex w-72 origin-(--transform-origin) flex-col gap-3 rounded-lg border p-3 text-sm outline-hidden duration-100',
            className
          )}
          data-slot="popover-content"
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-1 text-sm', className)}
      data-slot="popover-header"
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn('text-base font-medium', className)}
      data-slot="popover-title"
      {...props}
    />
  )
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      className={cn('text-muted-foreground', className)}
      data-slot="popover-description"
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
}
