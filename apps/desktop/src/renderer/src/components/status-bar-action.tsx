import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { STATUS_BAR_ACTION_CLASS } from '@/components/status-bar'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Its own module, apart from StatusBar and StatusBarHint: the main window's
// status bar never uses it, so its Tooltip stays out of the eager bundle
// (only the Stream Manager's chunk carries it).

/**
 * One action in a status bar (plan 174 S1.6b, H-PAT): an icon, a word, or
 * both, and optionally its shortcut. `label` is the action's name: what a screen
 * reader says, and the tooltip of an icon alone. `text` is the visible
 * word when there is room for one ("Clip", "Clear"); `hint` says more
 * than the name, in the tooltip and as the button's description. Never a
 * native `title` (plan 174 S1.10). `pressed` marks a toggle that is on.
 * Props spread onto the button, so it can be a menu trigger.
 */
export function StatusBarAction({
  icon,
  label,
  text,
  hint,
  accelerator,
  pressed,
  className,
  ...props
}: {
  icon?: ReactNode
  label: string
  text?: ReactNode
  hint?: string
  /** The shortcut as an Electron accelerator, printed per platform (plan 174 S1.2). */
  accelerator?: string
  pressed?: boolean
} & Omit<ComponentProps<'button'>, 'children' | 'title'>): ReactElement {
  const tip = hint ?? (text ? undefined : label)
  const button = (
    <button
      aria-description={hint}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(STATUS_BAR_ACTION_CLASS, className)}
      type="button"
      {...props}
      // After the spread: a menu or tooltip trigger wrapping it keeps the slot.
      data-slot="status-bar-action"
    >
      {icon}
      {accelerator ? (
        <ShortcutKeys
          accelerator={accelerator}
          className="font-medium text-muted-foreground"
          variant="text"
        />
      ) : null}
      {text}
    </button>
  )
  if (!tip) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  )
}
