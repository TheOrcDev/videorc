import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { STATUS_BAR_ACTION_CLASS } from '@/components/status-bar'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Its own module, apart from StatusBar and StatusBarHint: a status bar with
// hints alone never imports it, so its Tooltip stays out of that bundle.

type StatusBarActionProps = {
  icon?: ReactNode
  /** The action's name: what a screen reader says, and the tooltip of an icon alone. */
  label: string
  /** The visible word, when there is room for one ("Clip", "Clear"). */
  text?: ReactNode
  /** More than the name: the tooltip and the button's description. */
  hint?: string
  /** The shortcut as an Electron accelerator, printed per platform. */
  accelerator?: string
  platform?: string
  /** A toggle that is on. */
  pressed?: boolean
} & Omit<ComponentProps<'button'>, 'children' | 'title'>

/**
 * One action in a status bar: an icon, a word, or both, and optionally its
 * shortcut. `label` is the action's name: what a screen reader says, and the
 * tooltip of an icon alone. `text` is the visible word when there is room
 * for one; `hint` says more than the name, in the tooltip and as the
 * button's description. Never a native `title`. `pressed` marks a toggle
 * that is on. Props spread onto the button, so it can be a menu trigger's
 * `render`.
 */
function StatusBarAction({
  icon,
  label,
  text,
  hint,
  accelerator,
  platform,
  pressed,
  className,
  ...props
}: StatusBarActionProps): ReactElement {
  const tip = hint ?? (text ? undefined : label)
  const button = (
    <button
      // A global attribute since ARIA 1.3, and Chromium reads it; the lint's
      // role table predates it.
      // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- see above.
      aria-description={hint}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(STATUS_BAR_ACTION_CLASS, className)}
      type="button"
      {...props}
      // After the spread: a menu or tooltip trigger rendering it keeps the slot.
      data-slot="status-bar-action"
    >
      {icon}
      {accelerator ? (
        // The key in the secondary tier, a step above the tertiary word.
        <span className="text-muted-foreground" data-slot="status-bar-action-keys">
          <ShortcutKeys accelerator={accelerator} platform={platform} variant="text" />
        </span>
      ) : null}
      {text}
    </button>
  )
  if (!tip) {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  )
}

export { StatusBarAction, type StatusBarActionProps }
