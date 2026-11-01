'use client'

import { Select as SelectPrimitive } from '@base-ui/react/select'
import * as React from 'react'

import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '@/components/icons'
import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'
import { cn } from '@/lib/utils'

// The popup is portalled, but React still bubbles its events through the
// trigger's ancestors: a wheel over a long list would reach a fader or a
// scrolling pane behind it. The wheel stops here, and overscroll-contain keeps
// the end of the list's own scroll from chaining to the page.
function containWheel(event: React.WheelEvent): void {
  event.stopPropagation()
}

const Select = SelectPrimitive.Root

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      className={cn('scroll-my-1.5 p-1', className)}
      data-slot="select-group"
      {...props}
    />
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      className={cn('flex flex-1 text-left', className)}
      data-slot="select-value"
      {...props}
    />
  )
}

/**
 * The trigger's look, on its own: a picker that opens a popover from a button
 * (DevicePicker) must look exactly like this trigger, so it reads it here.
 * 28 px by default; `xs` (24 px) is the one compact size, for dense rows.
 */
const selectTriggerClassName =
  "bg-input/50 focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 rounded-chip data-[size=default]:h-control flex w-fit items-center justify-between gap-1.5 border border-transparent px-2.5 py-0 text-sm whitespace-nowrap transition-[color,box-shadow] duration-150 outline-none focus-visible:ring-3 disabled:opacity-50 aria-invalid:ring-3 data-[size=xs]:h-6 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

// Inside a Field it registers its id, so the FieldLabel names it, and the
// Field's descriptions describe it.
function SelectTrigger({
  className,
  size = 'default',
  children,
  id,
  'aria-describedby': ariaDescribedBy,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: 'xs' | 'default'
}) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(ariaDescribedBy)
  return (
    <SelectPrimitive.Trigger
      aria-describedby={describedBy}
      className={cn(selectTriggerClassName, className)}
      data-size={size}
      data-slot="select-trigger"
      id={controlId}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="text-muted-foreground pointer-events-none size-4" />}
      />
    </SelectPrimitive.Trigger>
  )
}

// The popup tier of the float glass at 10 px, fading and scaling from 0.98
// in 100 ms, with no slide. Aligned over the trigger (the default) it opens
// in place, unanimated. It is at least as wide as the trigger, and the list
// inside scrolls.
function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  alignItemWithTrigger = true,
  onWheelCapture,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'alignItemWithTrigger'
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        alignOffset={alignOffset}
        className="isolate z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className={cn(
            'glass-float text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] relative isolate z-50 min-w-36 origin-(--transform-origin) overflow-hidden rounded-lg border duration-100 data-[align-trigger=true]:animate-none',
            className
          )}
          data-align-trigger={alignItemWithTrigger}
          data-slot="select-content"
          onWheelCapture={(event) => {
            onWheelCapture?.(event)
            containWheel(event)
          }}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="max-h-(--available-height) min-w-(--anchor-width) overflow-x-hidden overflow-y-auto overscroll-contain">
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn('text-muted-foreground px-2 py-1 text-xs', className)}
      data-slot="select-label"
      {...props}
    />
  )
}

// 28 px items with a 6 px radius, concentric inside the group's 4 px inset.
function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground rounded-chip relative flex min-h-7 w-full cursor-default items-center gap-2 py-1 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

// One separator strength in every float: the hairline itself.
function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      data-slot="select-separator"
      {...props}
    />
  )
}

// The arrows float over the list's ends, so they take the popup's own glass.
function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-inherit py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="select-scroll-up-button"
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-inherit py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="select-scroll-down-button"
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectTriggerClassName
}
