import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/*
 * The page vocabulary. There is no page column: every page fills its pane
 * edge to edge, under the pane's toolbar, and only `PaneBody` scrolls. Pages
 * compose these helpers instead of hand-rolling grids.
 *
 *   Stage        the Studio: the preview pane leads. Bespoke.
 *   Bench        Scene: a flush stage pane beside the inspector. Bespoke.
 *   Config grid  Sources, Livestream, Output, Settings: flush sections in
 *                <ConfigGrid>, one column, two at `lg`, split by hairlines.
 *   Gallery      Assets, Screens: picture cards in <Gallery>.
 *   Browse       Library: a flush list or table in the pane body.
 *   Inspect      Health: dense sections of metric rows. Bespoke.
 *
 * `lg` is the one layout breakpoint. Inner form sub-grids use `sm` and `md`.
 */

interface PageHeaderProps {
  /** The page's name for assistive tech: the toolbar already shows it. */
  title: string
  description?: ReactNode
  action?: ReactNode
  media?: ReactNode
  className?: string
}

/**
 * A page's intro: the toolbar already names the page, so the title is for
 * assistive tech; the description is a flush intro line, with any action at
 * its end (never in the toolbar's corner). `media` leads the line: a page
 * with its own mark (the Buddy tab's emblem) puts it there.
 */
function PageHeader({
  title,
  description,
  action,
  media,
  className
}: PageHeaderProps): ReactElement {
  return (
    <div
      className={cn('px-gutter flex items-center gap-3 pt-3 pb-1', className)}
      data-slot="page-header"
    >
      <h2 className="sr-only">{title}</h2>
      {media}
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">{description}</p>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

/**
 * The config grid: flush sections in one column, two at `lg`, with a hairline
 * between the columns. Grid rows stretch, which is harmless because sections
 * are flush: a short section simply leaves pane background below it.
 */
function ConfigGrid({
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
 * is. Stacked, the rows keep their content height.
 */
const CONFIG_GRID_PAIR = 'flex-1 content-start lg:content-stretch lg:[&>*]:border-b-0'

/** The gallery's tracks: 180 px cards, 10 rem when dense, five a row at most. */
function galleryColumns(dense: boolean, rowsOfFive: boolean): string {
  if (dense) {
    return '[grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))]'
  }
  if (rowsOfFive) {
    // A track is never narrower than a fifth of the row less its four 12 px
    // gaps (and a pixel, against rounding), so auto-fill never fits a sixth.
    return '[grid-template-columns:repeat(auto-fill,minmax(max(11rem,calc((100%_-_3rem)/5_-_1px)),1fr))]'
  }
  return '[grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]'
}

type GalleryProps = ComponentProps<'div'> & {
  children: ReactNode
  /** Smaller cards (10 rem), for a picker inside a dialog. */
  dense?: boolean
  /**
   * At most five cards a row, shrinking to 11 rem so five fit the default
   * window: ten cards read as two rows of five, and a narrower pane wraps.
   */
  rowsOfFive?: boolean
}

/**
 * The gallery: picture cards that fill by available width. `dense` packs
 * smaller cards, and `rowsOfFive` holds a row to five cards.
 */
function Gallery({
  children,
  className,
  dense = false,
  rowsOfFive = false,
  ...props
}: GalleryProps): ReactElement {
  return (
    <div
      className={cn('grid gap-3', galleryColumns(dense, rowsOfFive), className)}
      data-slot="gallery"
      {...props}
    >
      {children}
    </div>
  )
}

/** A single column of flush sections. */
function PageStack({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('flex flex-col', className)} data-slot="page-stack">
      {children}
    </div>
  )
}

export {
  PageHeader,
  ConfigGrid,
  CONFIG_GRID_PAIR,
  Gallery,
  PageStack,
  type PageHeaderProps,
  type GalleryProps
}
