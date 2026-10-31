'use client'

import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { useRender } from '@base-ui/react/use-render'
import * as React from 'react'

import { CheckIcon, ChevronRightIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

// The popup is portalled, but React still bubbles its events through the
// trigger's ancestors: a wheel over a long menu would reach a fader or a
// scrolling pane behind it. The wheel stops here, and overscroll-contain keeps
// the end of the menu's own scroll from chaining to the page.
function containWheel(event: React.WheelEvent): void {
  event.stopPropagation()
}

// True inside a DropdownMenuGroup or DropdownMenuRadioGroup. Base UI's group
// label throws outside a group, but a menu often opens with a heading of its
// own ("Send to"), so a label outside one renders as a plain heading row.
const DropdownMenuGroupContext = React.createContext(false)

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

// The popup tier of the float glass at 10 px, fading and scaling from 0.98
// in 100 ms, with no slide. It sizes to its items.
function DropdownMenuContent({
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  className,
  onWheelCapture,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            'glass-float text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] z-50 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border p-1 duration-100 outline-none data-closed:overflow-hidden',
            className
          )}
          data-slot="dropdown-menu-content"
          onWheelCapture={(event) => {
            onWheelCapture?.(event)
            containWheel(event)
          }}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return (
    <DropdownMenuGroupContext.Provider value>
      <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
    </DropdownMenuGroupContext.Provider>
  )
}

// A label outside any group: the same row, labelling nothing.
function DropdownMenuHeading({
  className,
  style,
  render,
  ...props
}: MenuPrimitive.GroupLabel.Props) {
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

function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  const Part = React.useContext(DropdownMenuGroupContext)
    ? MenuPrimitive.GroupLabel
    : DropdownMenuHeading
  return (
    <Part
      className={cn('text-muted-foreground px-2 py-1 text-xs', className)}
      data-slot="dropdown-menu-label"
      {...props}
    />
  )
}

// 28 px items with a 6 px radius, concentric inside the menu's 4 px inset.
function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & {
  variant?: 'default' | 'destructive'
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "group/dropdown-menu-item focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:*:[svg]:text-destructive rounded-chip relative flex min-h-7 cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="dropdown-menu-item"
      data-variant={variant}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        "focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground rounded-chip flex min-h-7 cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="dropdown-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  align = 'start',
  alignOffset = -3,
  side = 'right',
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      align={align}
      alignOffset={alignOffset}
      className={cn('w-auto min-w-24', className)}
      data-slot="dropdown-menu-sub-content"
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground rounded-chip relative flex min-h-7 cursor-default items-center gap-2 py-1 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="dropdown-menu-checkbox-item"
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <DropdownMenuGroupContext.Provider value>
      <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
    </DropdownMenuGroupContext.Provider>
  )
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground rounded-chip relative flex min-h-7 cursor-default items-center gap-2 py-1 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="dropdown-menu-radio-item"
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

// One separator strength in every float: the hairline itself.
function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      data-slot="dropdown-menu-separator"
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground ml-auto text-xs',
        className
      )}
      data-slot="dropdown-menu-shortcut"
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
}
