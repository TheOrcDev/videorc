import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Desktop structure (plan 050, D4). A pane is a flush column: a 40 px toolbar
// that never scrolls, then a body that does. Panes are split by hairlines and
// nothing inside a window floats.

/**
 * The pane toolbar: the page title (14 px / 600) on the window's drag band.
 * No buttons in its top-right corner (owner call, 2026-09-23): actions live
 * with the content they act on.
 */
export function Toolbar({
  title,
  className
}: {
  title?: ReactNode
  className?: string
}): ReactElement {
  return (
    <header
      className={cn(
        'flex h-toolbar shrink-0 items-center gap-2 border-b border-border px-gutter select-none [-webkit-app-region:drag]',
        className
      )}
      data-slot="toolbar"
    >
      {title ? (
        <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h1>
      ) : null}
    </header>
  )
}

/** A flush pane: toolbar + body, filling its parent. */
export function Pane({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)} data-slot="pane">
      {children}
    </div>
  )
}

/**
 * The pane's scroll container: the only thing that scrolls. Pass
 * `scroll={false}` for a body that owns its scroll (Library's table).
 */
export function PaneBody({
  children,
  className,
  scroll = true
}: {
  children: ReactNode
  className?: string
  scroll?: boolean
}): ReactElement {
  return (
    <div
      className={cn(
        'min-h-0 flex-1',
        scroll ? 'overflow-y-auto overscroll-contain' : 'flex flex-col',
        className
      )}
      data-slot="pane-body"
    >
      {children}
    </div>
  )
}
