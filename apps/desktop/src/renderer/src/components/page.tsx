import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Page vocabulary (plan 050, D4). There is no page column: every page fills
 * its pane edge to edge, under the pane's toolbar, and only `PaneBody`
 * scrolls. Pages compose these helpers instead of hand-rolling grids.
 *
 *   Stage       — Studio: the preview pane leads. Bespoke.
 *   Bench       — Scene: a flush stage pane beside the inspector. Bespoke.
 *   Config-grid — Sources / Livestream / Output / Settings: flush sections via
 *                 <ConfigGrid>, one column, two at `lg`, split by hairlines.
 *   Gallery     — Assets / Screens: picture cards via <Gallery>.
 *   Browse      — Library: a flush list or table in the pane body.
 *   Inspect     — Health: dense sections of metric rows. Bespoke.
 *
 * `lg` is the one layout breakpoint. Inner form sub-grids use `sm`/`md`.
 */

/**
 * A page's intro: the toolbar already names the page, so the title is for
 * assistive tech; the description is a flush intro line, with any action at
 * its end (never in the toolbar's corner). `media` leads the line: a page
 * with its own mark (the Orcle tab's emblem, plan 149) puts it there.
 */
export function PageHeader({
  title,
  description,
  action,
  media,
  className
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  media?: ReactNode
  className?: string
}): ReactElement {
  return (
    <div
      className={cn('flex items-center gap-3 px-gutter pt-3 pb-1', className)}
      data-slot="page-header"
    >
      <h2 className="sr-only">{title}</h2>
      {media}
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{description}</p>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

/**
 * Config-grid archetype: flush sections in one column, two at `lg`, with a
 * hairline between the columns. Grid rows stretch, which is harmless now that
 * sections are flush: a short section simply leaves pane background below it.
 */
export function ConfigGrid({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div
      className={cn('grid lg:grid-cols-2 lg:[&>*:nth-child(odd)]:border-r', className)}
      data-slot="config-grid"
    >
      {children}
    </div>
  )
}

/**
 * A config grid of exactly two sections that fills the visible height at
 * `lg`, so the column hairline runs the full height however short the tab
 * is (Settings' tabs, plan 064; the Orcle tab's, plan 150). Stacked, the rows
 * keep their content height.
 */
export const CONFIG_GRID_PAIR = 'flex-1 content-start lg:content-stretch lg:[&>*]:border-b-0'

/** Gallery archetype: picture cards that fill by available width. */
export function Gallery({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div
      className={cn(
        'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** A single column of flush sections. */
export function PageStack({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return <div className={cn('flex flex-col', className)}>{children}</div>
}
