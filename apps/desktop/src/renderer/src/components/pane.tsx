import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Desktop structure (plan 050, D4). A pane is a flush column: a 40 px toolbar
// that never scrolls, then a body that does. Panes are split by hairlines and
// nothing inside a window floats.

/**
 * The one title recipe (plan 174 S1.6b, J1-18): 14 px / 600 primary text, as
 * the page's `h1`. The main window's Toolbar and every single-pane window's
 * WindowHeader set their title with it.
 */
export const WINDOW_TITLE_CLASS = 'min-w-0 truncate text-sm font-semibold text-foreground'

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
      {/* Focusable by script only (plan 174 S3.21, A-18): the shell moves the
          focus here after keyboard navigation, so the new page is announced
          and the next Tab starts at its top. */}
      {title ? (
        <h1 className={cn(WINDOW_TITLE_CLASS, 'outline-none')} tabIndex={-1}>
          {title}
        </h1>
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
 * The attribute a page puts on its root when it owns its scroll (plan 174
 * S1.6b, A-14): a pinned strip with only the region under it scrolling
 * (`PageTabs`), or Library's pinned header over its table. PaneBody sees it
 * and stops scrolling, so the shell keeps no list of such pages.
 */
export const PANE_OWNS_SCROLL = { 'data-pane-scroll': 'own' } as const

/**
 * The pane's scroll container: the only thing that scrolls. A page whose root
 * carries `PANE_OWNS_SCROLL` turns it into a flex column instead, so the
 * page's own scroll region gets the height; `scroll={false}` does the same
 * for a body that always owns its scroll.
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
        scroll
          ? 'overflow-y-auto overscroll-contain has-[>[data-pane-scroll=own]]:flex has-[>[data-pane-scroll=own]]:flex-col has-[>[data-pane-scroll=own]]:overflow-y-hidden'
          : 'flex flex-col',
        className
      )}
      data-slot="pane-body"
    >
      {children}
    </div>
  )
}

/**
 * A strip pinned under the toolbar (plan 174 S1.6b, A-14): a page's tabs, or
 * its filter bar. A hairline below, the gutter at the sides, and it never
 * scrolls away; the page owns its scroll (`PANE_OWNS_SCROLL`) and only the
 * region under the strip scrolls.
 */
export function PaneStrip({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      className={cn('shrink-0 border-b border-border px-gutter py-2', className)}
      data-slot="pane-strip"
      {...props}
    />
  )
}
