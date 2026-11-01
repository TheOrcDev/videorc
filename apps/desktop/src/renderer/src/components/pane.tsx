import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

// The desktop structure. A pane is a flush column: a 40 px toolbar that never
// scrolls, then a body that does. Panes are split by hairlines and nothing
// inside a window floats.

/**
 * The one title recipe: 14 px / 600 primary text, as the page's `h1`. The
 * main window's Toolbar and every single-pane window's WindowHeader set
 * their title with it.
 */
const WINDOW_TITLE_CLASS = 'min-w-0 truncate text-sm font-semibold text-foreground'

/**
 * The pane toolbar: the page title (14 px / 600) on the window's drag band.
 * No buttons in its top-right corner: actions live with the content they act
 * on.
 */
function Toolbar({ title, className }: { title?: ReactNode; className?: string }): ReactElement {
  return (
    <header
      className={cn(
        'h-toolbar border-border px-gutter flex shrink-0 items-center gap-2 border-b select-none [-webkit-app-region:drag]',
        className
      )}
      data-slot="toolbar"
    >
      {/* Focusable by script only: the shell moves the focus here after
          keyboard navigation, so the new page is announced and the next Tab
          starts at its top. */}
      {title ? (
        <h1 className={cn(WINDOW_TITLE_CLASS, 'outline-none')} tabIndex={-1}>
          {title}
        </h1>
      ) : null}
    </header>
  )
}

/** A flush pane: toolbar + body, filling its parent. */
function Pane({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)} data-slot="pane">
      {children}
    </div>
  )
}

/**
 * The attribute a page puts on its root when it owns its scroll: a pinned
 * strip with only the region under it scrolling (`PageTabs`), or a pinned
 * header over a table. PaneBody sees it and stops scrolling, so the shell
 * keeps no list of such pages.
 */
const PANE_OWNS_SCROLL = { 'data-pane-scroll': 'own' } as const

/**
 * The attribute a page puts on its root when its width must not move as it
 * grows past the pane's height: PaneBody keeps the scrollbar's gutter
 * (`scrollbar-gutter: stable`), so a classic scrollbar (Linux, Windows)
 * showing up never narrows the page. Overlay scrollbars (macOS) take no
 * gutter, so nothing changes there.
 */
const PANE_STABLE_GUTTER = { 'data-pane-gutter': 'stable' } as const

/**
 * The pane's scroll container: the only thing that scrolls. A page whose root
 * carries `PANE_OWNS_SCROLL` turns it into a flex column instead, so the
 * page's own scroll region gets the height; `scroll={false}` does the same
 * for a body that always owns its scroll. It is `relative`, the containing
 * block of what it scrolls: an absolute descendant with no other positioned
 * ancestor (an `sr-only` label) would otherwise be placed against <body>,
 * escape this clip and give the window a scrollbar.
 */
function PaneBody({
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
        'relative min-h-0 flex-1',
        scroll
          ? 'overflow-y-auto overscroll-contain has-[>[data-pane-gutter=stable]]:[scrollbar-gutter:stable] has-[>[data-pane-scroll=own]]:flex has-[>[data-pane-scroll=own]]:flex-col has-[>[data-pane-scroll=own]]:overflow-y-hidden'
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
 * A strip pinned under the toolbar: a page's tabs, or its filter bar. A
 * hairline below, the gutter at the sides, and it never scrolls away; the
 * page owns its scroll (`PANE_OWNS_SCROLL`) and only the region under the
 * strip scrolls.
 */
function PaneStrip({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      className={cn('border-border px-gutter shrink-0 border-b py-2', className)}
      data-slot="pane-strip"
      {...props}
    />
  )
}

export {
  Pane,
  Toolbar,
  PaneBody,
  PaneStrip,
  PANE_OWNS_SCROLL,
  PANE_STABLE_GUTTER,
  WINDOW_TITLE_CLASS
}
