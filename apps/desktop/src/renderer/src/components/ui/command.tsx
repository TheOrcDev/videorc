'use client'

import { Command as CommandPrimitive } from 'cmdk'
import * as React from 'react'

import { CheckIcon, SearchIcon } from '@/components/icons'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

// Command always sits inside a Dialog or a Popover, so it paints no coat of
// its own: one surface per float.
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        'rounded-panel text-popover-foreground flex size-full flex-col overflow-hidden',
        className
      )}
      data-slot="command"
      {...props}
    />
  )
}

/**
 * The ⌘K palette: the one surface at the Raycast scale, a `lg` dialog in the
 * upper part of the window. `value` and `onValueChange` are cmdk's selected
 * item, so a CommandFooter can name the action Return runs.
 */
function CommandDialog({
  // ⌘K is "Search" everywhere it is named.
  title = 'Search',
  description = 'Search for a command to run…',
  children,
  className,
  showCloseButton = false,
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, 'children'> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  value?: string
  onValueChange?: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn('rounded-panel! top-[20%] translate-y-0 overflow-hidden p-0', className)}
        showCloseButton={showCloseButton}
        size="lg"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Every cmdk part (Input, List, Item…) reads the store this root
            provides: children outside it crash cmdk on its first render, and
            an uncaught render error unmounts the whole React root. */}
        <Command onValueChange={onValueChange} value={value}>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    // The borderless search header: the panel is the input's surface, with a
    // 24 px leading icon, an 18 px field and a hairline below. No box.
    <div
      className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-4"
      data-slot="command-input-wrapper"
    >
      <SearchIcon className="text-muted-foreground size-6 shrink-0" />
      <CommandPrimitive.Input
        className={cn(
          'placeholder:text-muted-foreground h-full w-full bg-transparent text-lg outline-hidden disabled:opacity-50',
          className
        )}
        data-slot="command-input"
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn(
        'max-h-96 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none',
        className
      )}
      data-slot="command-list"
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cn('text-muted-foreground py-6 text-center text-sm', className)}
      data-slot="command-empty"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        'text-foreground **:[[cmdk-group-heading]]:text-subtle overflow-hidden p-1.5 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-2 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:leading-none **:[[cmdk-group-heading]]:font-semibold',
        className
      )}
      data-slot="command-group"
      {...props}
    />
  )
}

// One separator strength in every float: the hairline itself.
function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      className={cn('bg-border my-1 h-px', className)}
      data-slot="command-separator"
      {...props}
    />
  )
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        // A 40 px row: icon, title, secondary context, then right-aligned
        // metadata. Selection is the theme's 8% block at the row radius, and
        // rows highlight instantly. cmdk always writes data-selected ("true"
        // or "false"), so the match must be =true: the bare data-selected
        // variant highlights every row at once and hides the keyboard cursor.
        "group/command-item rounded-row data-[selected=true]:bg-accent data-[selected=true]:text-foreground data-[selected=true]:*:[svg]:text-foreground relative flex min-h-10 cursor-default items-center gap-3 px-2.5 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="command-item"
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'text-muted-foreground group-data-[selected=true]/command-item:text-foreground ml-auto text-xs',
        className
      )}
      data-slot="command-shortcut"
      {...props}
    />
  )
}

/** The palette's footer: the selected action on the left, its key chip on the right. */
function CommandFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'border-border text-muted-foreground flex h-10 shrink-0 items-center justify-between gap-3 border-t px-4 text-xs',
        className
      )}
      data-slot="command-footer"
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  CommandFooter
}
