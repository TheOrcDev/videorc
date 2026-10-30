'use client'

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { useRender } from '@base-ui/react/use-render'
import * as React from 'react'

import { CheckIcon, ChevronRightIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

// shadcn's context menu brought to the desktop scale of ui/dropdown-menu: the
// popup tier of the float glass at 10 px, and 28 px items with a 6 px radius.

// The popup is portalled, but React still bubbles its events through the
// trigger's ancestors: a wheel over a long menu would reach a fader or a
// scrolling pane behind it. The wheel stops here, and overscroll-contain keeps
// the end of the menu's own scroll from chaining to the page.
function containWheel(event: React.WheelEvent): void {
  event.stopPropagation()
}

// True inside a ContextMenuGroup or ContextMenuRadioGroup. Base UI's group
// label throws outside a group, but a context menu often opens with a heading
// of its own (the message it acts on), so a label outside one renders as a
// plain heading row.
const ContextMenuGroupContext = React.createContext(false)

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      className={cn('select-none', className)}
      data-slot="context-menu-trigger"
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  align = 'start',
  alignOffset = 4,
  side = 'right',
  sideOffset = 0,
  onWheelCapture,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<ContextMenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          className={cn(
            'glass-float text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] z-50 max-h-(--available-height) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border p-1 duration-100 outline-none data-closed:overflow-hidden',
            className
          )}
          data-slot="context-menu-content"
          onWheelCapture={(event) => {
            onWheelCapture?.(event)
            containWheel(event)
          }}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return (
    <ContextMenuGroupContext.Provider value>
      <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
    </ContextMenuGroupContext.Provider>
  )
}

// A label outside any group: the same row, labelling nothing.
function ContextMenuHeading({
  className,
  style,
  render,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props) {
  const state = {}
  return useRender({
    defaultTagName: 'div',
    props: {
      ...props,
      className: typeof className === 'function' ? className(state) : className,
      style: typeof style === 'function' ? style(state) : style
    },
    render,
    state
  })
}

function ContextMenuLabel({ className, ...props }: ContextMenuPrimitive.GroupLabel.Props) {
  const Part = React.useContext(ContextMenuGroupContext)
    ? ContextMenuPrimitive.GroupLabel
    : ContextMenuHeading
  return (
    <Part
      className={cn('text-muted-foreground px-2 py-1 text-xs', className)}
      data-slot="context-menu-label"
      {...props}
    />
  )
}

// 28 px items with a 6 px radius, concentric inside the menu's 4 px inset.
function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: ContextMenuPrimitive.Item.Props & {
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "group/context-menu-item focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 focus:*:[svg]:text-accent-foreground data-[variant=destructive]:*:[svg]:text-destructive rounded-chip relative flex min-h-7 cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="context-menu-item"
      data-variant={variant}
      {...props}
    />
  )
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground rounded-chip flex min-h-7 cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="context-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  )
}

function ContextMenuSubContent({
  align = 'start',
  alignOffset = -3,
  side = 'right',
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuContent>) {
  return (
    <ContextMenuContent
      align={align}
      alignOffset={alignOffset}
      className={cn('min-w-32', className)}
      data-slot="context-menu-sub-content"
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground rounded-chip relative flex min-h-7 cursor-default items-center gap-2 py-1 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="context-menu-checkbox-item"
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex items-center justify-center">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup({ ...props }: ContextMenuPrimitive.RadioGroup.Props) {
  return (
    <ContextMenuGroupContext.Provider value>
      <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
    </ContextMenuGroupContext.Provider>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: ContextMenuPrimitive.RadioItem.Props) {
  return (
    <ContextMenuPrimitive.RadioItem
      className={cn(
        "focus:bg-accent focus:text-accent-foreground rounded-chip relative flex min-h-7 cursor-default items-center gap-2 py-1 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="context-menu-radio-item"
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex items-center justify-center">
        <ContextMenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

// One separator strength in every float: the hairline itself.
function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      data-slot="context-menu-separator"
      {...props}
    />
  )
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'text-muted-foreground group-focus/context-menu-item:text-accent-foreground ml-auto text-xs',
        className
      )}
      data-slot="context-menu-shortcut"
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup
}
