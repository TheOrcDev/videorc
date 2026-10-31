import type { ReactElement, ReactNode } from 'react'

import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { cn } from '@/lib/utils'

/**
 * Every clickable thing in a status bar: 20 px, 11 px tertiary text that
 * brightens on hover, a pressed state for a toggle, 14 px icons.
 * StatusBarHint and StatusBarAction (`status-bar-action.tsx`) share it. The
 * 11 px is the label size at the body's weight: quiet, never a section label.
 */
const STATUS_BAR_ACTION_CLASS =
  'flex h-5 shrink-0 items-center gap-1 rounded-chip px-1.5 text-label font-normal text-subtle transition-colors duration-100 hover:bg-accent hover:text-foreground aria-pressed:text-foreground [&_svg]:size-3.5'

interface StatusBarProps {
  /** The state, on the left: the session's own words. */
  leading?: ReactNode
  /** The hints and actions, on the right. */
  children?: ReactNode
  className?: string
}

/**
 * The window's status bar: 26 px, state on the left and quiet shortcut hints
 * on the right. It replaces a footer shortcut bar; the hints stay clickable,
 * so the app is still keyboard-first, only quieter.
 */
function StatusBar({ leading, children, className }: StatusBarProps): ReactElement {
  return (
    <footer
      className={cn(
        'h-status-bar border-border text-muted-foreground text-label flex shrink-0 items-center gap-3 border-t pr-1.5 pl-3 font-normal select-none',
        className
      )}
      data-slot="status-bar"
    >
      <div className="flex min-w-0 items-center gap-3" data-slot="status-bar-leading">
        {leading}
      </div>
      <div className="ml-auto flex min-w-0 items-center" data-slot="status-bar-trailing">
        {children}
      </div>
    </footer>
  )
}

interface StatusBarHintProps {
  /** The shortcut as an Electron accelerator, printed per platform. */
  accelerator: string
  platform?: string
  label: string
  /** The label's own classes: one that hides it keeps the key alone in a narrow window. */
  labelClassName?: string
  /** The window this hint opens is open (the hint then closes it). */
  pressed?: boolean
  onClick: () => void
  className?: string
}

/**
 * One clickable hint: the shortcut in the secondary tier, the action in the
 * tertiary. `pressed` marks a window that is open (the action then closes it).
 */
function StatusBarHint({
  accelerator,
  platform,
  label,
  labelClassName,
  pressed,
  onClick,
  className
}: StatusBarHintProps): ReactElement {
  return (
    <button
      aria-pressed={pressed}
      className={cn(STATUS_BAR_ACTION_CLASS, className)}
      data-slot="status-bar-hint"
      onClick={onClick}
      type="button"
    >
      {/* The key in the secondary tier, a step above its tertiary label. */}
      <span className="text-muted-foreground" data-slot="status-bar-hint-keys">
        <ShortcutKeys accelerator={accelerator} platform={platform} variant="text" />
      </span>
      {labelClassName ? <span className={labelClassName}>{label}</span> : label}
    </button>
  )
}

export {
  StatusBar,
  StatusBarHint,
  STATUS_BAR_ACTION_CLASS,
  type StatusBarProps,
  type StatusBarHintProps
}
