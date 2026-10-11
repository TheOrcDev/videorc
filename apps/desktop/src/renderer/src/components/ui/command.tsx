import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { CheckIcon, SearchIcon } from '@/components/icons'
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-panel text-popover-foreground',
        className
      )}
      {...props}
    />
  )
}

/**
 * The ⌘K palette (videorc-design, "⌘K palette scale"): the one surface in
 * the app at the Raycast scale, a lg dialog in the upper third of the window
 * (plan 174 V-9). `value` / `onValueChange` is cmdk's selected item, so the
 * footer can name the action Return runs.
 */
function CommandDialog({
  // ⌘K is "Search" everywhere it is named (status bar, docs/ui-copy.md).
  title = 'Search',
  description = 'Search for a command to run…',
  children,
  className,
  showCloseButton = false,
  value,
  onValueChange,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  value?: string
  onValueChange?: (value: string) => void
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn('top-[20%] translate-y-0 overflow-hidden rounded-panel! p-0', className)}
        showCloseButton={showCloseButton}
        size="lg"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Every cmdk part (Input, List, Item...) reads the store this root
            provides — children OUTSIDE it crash cmdk on first render, and an
            uncaught render error unmounts the whole React root. */}
        <Command value={value} onValueChange={onValueChange}>
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
    // Borderless search header (videorc-design): the panel IS the input
    // surface — a 24 px leading icon, an 18 px field, a hairline below. No box.
    <div
      data-slot="command-input-wrapper"
      className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4"
    >
      <SearchIcon className="size-6 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'h-full w-full bg-transparent text-lg outline-hidden placeholder:text-muted-foreground disabled:opacity-50',
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'max-h-96 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none',
        className
      )}
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
      data-slot="command-empty"
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
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
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1.5 text-foreground **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-2 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:leading-none **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:text-subtle',
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('my-1 h-px bg-border', className)}
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
      data-slot="command-item"
      className={cn(
        // A 40 px row: icon, title, secondary context, then right-aligned
        // metadata. Row selection is the theme's 8% block at the row radius
        // tier; rows highlight instantly (no transition on selection). cmdk
        // always emits data-selected ("true" OR "false"), so the match MUST
        // be =true — the bare data-selected: variant highlights every row at
        // once and the keyboard cursor becomes invisible.
        "group/command-item relative flex min-h-10 cursor-default items-center gap-3 rounded-row px-2.5 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[selected=true]:*:[svg]:text-foreground",
        className
      )}
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
      data-slot="command-shortcut"
      className={cn(
        'ml-auto text-xs text-muted-foreground group-data-[selected=true]/command-item:text-foreground',
        className
      )}
      {...props}
    />
  )
}

/** The palette's footer: the selected action on the left, its key chip on the right. */
function CommandFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        'flex h-10 shrink-0 items-center justify-between gap-3 border-t border-border px-4 text-xs text-muted-foreground',
        className
      )}
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
