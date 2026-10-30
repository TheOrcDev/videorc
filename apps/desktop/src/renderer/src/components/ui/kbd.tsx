import { cn } from '@/lib/utils'

/**
 * Inside a filled button (the chrome primary, destructive, the record LED) the
 * gray glass keycap read at 2.38:1: there the chip takes the button's own text
 * colour on a faint fill of it, with no glass. Matched by ancestry, so no call
 * site has to remember it.
 */
const KBD_ON_FILLED_BUTTON = [
  '[[data-slot=button][data-variant=default]_&]:border-current/30',
  '[[data-slot=button][data-variant=default]_&]:bg-current/10',
  '[[data-slot=button][data-variant=default]_&]:bg-none',
  '[[data-slot=button][data-variant=default]_&]:text-current',
  '[[data-slot=button][data-variant=default]_&]:shadow-none',
  '[[data-slot=button][data-variant=destructive]_&]:border-current/30',
  '[[data-slot=button][data-variant=destructive]_&]:bg-current/10',
  '[[data-slot=button][data-variant=destructive]_&]:bg-none',
  '[[data-slot=button][data-variant=destructive]_&]:text-current',
  '[[data-slot=button][data-variant=destructive]_&]:shadow-none',
  '[[data-slot=button][data-variant=record]_&]:border-current/30',
  '[[data-slot=button][data-variant=record]_&]:bg-current/10',
  '[[data-slot=button][data-variant=record]_&]:bg-none',
  '[[data-slot=button][data-variant=record]_&]:text-current',
  '[[data-slot=button][data-variant=record]_&]:shadow-none'
].join(' ')

/**
 * Key chip: a glass keycap with a bright top edge and a dark bottom edge, and
 * the secondary-gray glyph. A shortcut goes through ShortcutKeys, which prints
 * it per platform into this chip.
 */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        "rounded-chip text-muted-foreground glass-keycap inline-flex h-5 w-fit min-w-5 shrink-0 items-center justify-center gap-1 border px-1 font-sans text-[11px] font-medium select-none [&_svg:not([class*='size-'])]:size-3",
        KBD_ON_FILLED_BUTTON,
        className
      )}
      data-slot="kbd"
      {...props}
    />
  )
}

/** Lays out key chips side by side with the standard gap (↑ ↓, or two shortcuts). */
function KbdGroup({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      data-slot="kbd-group"
      {...props}
    />
  )
}

export { Kbd, KbdGroup, KBD_ON_FILLED_BUTTON }
