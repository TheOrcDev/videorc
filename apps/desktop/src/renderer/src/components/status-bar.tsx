import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

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

/** One clickable hint: the shortcut in the secondary tier, the action in the tertiary. */
export function StatusBarHint({
  keys,
  label,
  onClick,
  className
}: {
  keys: string
  label: string
  onClick: () => void
  className?: string
}): ReactElement {
  return (
    <button
      className={cn(
        'flex h-5 shrink-0 items-center gap-1 rounded-chip px-1.5 text-[11px] text-subtle transition-colors duration-100 hover:bg-accent hover:text-foreground',
        className
      )}
      data-slot="status-bar-hint"
      type="button"
      onClick={onClick}
    >
      <span className="font-medium text-muted-foreground">{keys}</span>
      {label}
    </button>
  )
}
