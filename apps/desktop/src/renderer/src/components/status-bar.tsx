import type { ReactElement, ReactNode } from 'react'

import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { cn } from '@/lib/utils'

/**
 * Every clickable thing in a status bar (plan 174 S1.6b, H-PAT): 20 px, 11 px
 * tertiary text that brightens on hover, a pressed state for a toggle, 14 px
 * icons. StatusBarHint and StatusBarAction (`status-bar-action.tsx`) share it.
 */
export const STATUS_BAR_ACTION_CLASS =
  'flex h-5 shrink-0 items-center gap-1 rounded-chip px-1.5 text-[11px] text-subtle transition-colors duration-100 hover:bg-accent hover:text-foreground aria-pressed:text-foreground [&_svg]:size-3.5'

/**
 * The window's status bar (plan 050, D4): 26 px, state on the left and quiet
 * shortcut hints on the right. It replaces the footer shortcut bar; the hints
 * stay clickable, so the app is still keyboard-first, only quieter.
 */
export function StatusBar({
  leading,
  children,
  className
}: {
  leading?: ReactNode
  children?: ReactNode
  className?: string
}): ReactElement {
  return (
    <footer
      className={cn(
        'flex h-status-bar shrink-0 items-center gap-3 border-t border-border pr-1.5 pl-3 text-[11px] text-muted-foreground select-none',
        className
      )}
      data-slot="status-bar"
    >
      <div className="flex min-w-0 items-center gap-3">{leading}</div>
      <div className="ml-auto flex min-w-0 items-center">{children}</div>
    </footer>
  )
}

/**
 * One clickable hint: the shortcut in the secondary tier, the action in the
 * tertiary. `pressed` marks a window that is open (the action then closes it).
 */
export function StatusBarHint({
  accelerator,
  platform,
  label,
  labelClassName,
  pressed,
  onClick,
  className
}: {
  /** The shortcut as an Electron accelerator, printed per platform (plan 174 S1.2). */
  accelerator: string
  platform?: string
  label: string
  /** The label's own classes: `COMPACT_LABEL` keeps the key alone in a narrow window. */
  labelClassName?: string
  pressed?: boolean
  onClick: () => void
  className?: string
}): ReactElement {
  return (
    <button
      aria-pressed={pressed}
      className={cn(STATUS_BAR_ACTION_CLASS, className)}
      data-slot="status-bar-hint"
      type="button"
      onClick={onClick}
    >
      <ShortcutKeys
        accelerator={accelerator}
        className="text-muted-foreground"
        platform={platform}
        variant="text"
      />
      {labelClassName ? <span className={labelClassName}>{label}</span> : label}
    </button>
  )
}
