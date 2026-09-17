import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Shared page-layout vocabulary for the archetype system (Page Layout Redesign
 * plan). North star: a focused creator tool (Riverside / Loom / Ecamm) — calm,
 * preview-forward, progressive disclosure; NOT OBS dock-density. Pages compose
 * these helpers instead of hand-rolling grids, so the 2-col / 1-col choice is
 * consistent and intentional rather than per-screen drift.
 *
 * Archetypes (each page is assigned exactly one):
 *   Stage       — Studio: preview hero + a clear transport band. Bespoke.
 *   Bench       — Layout: a sticky preview pane beside grouped controls. Bespoke.
 *   Config-grid — Sources / Streaming / Recording / Settings: grouped
 *                 PanelSections via <ConfigGrid>, in a fixed reading order.
 *   Gallery     — Assets / Screens: a responsive card grid via <Gallery>.
 *   Browse      — Library / AI: a <PageHeader> over a list/grid.
 *   Inspect     — Diagnostics: dense, sectioned metric rows. Bespoke.
 *
 * Breakpoints (one set): `lg` is THE archetype breakpoint — Config-grid, Bench,
 * and the custom-ratio 2-col pages (Streaming 1.5/1, Layout 1.3/1, Assets
 * 1fr/360) split at `lg`, and their sticky panes (preview, readiness) engage
 * only there; below `lg` every page is a single column. Galleries are
 * breakpoint-free (auto-fill). The dense Inspect page (Diagnostics) may split
 * later, at `xl`. Inner form sub-grids use `sm`/`md`. Min card width (180px)
 * keeps galleries usable on narrow windows.
 */

/** Page header: title + optional description + optional primary affordance. */
export function PageHeader({
  title,
  description,
  action,
  className
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-xl leading-none font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/**
 * Config-grid archetype: grouped sections in a responsive grid that collapses
 * to one column below `lg`. Reading order is top-to-bottom, then left-to-right.
 *
 * `items-start` is the default on purpose: a grid row stretches its items to
 * the tallest one, so a short card (e.g. Settings' Remote control when it is
 * off) grew a lake of empty glass next to a tall neighbour. Every card is now
 * exactly as tall as its own content. Pages that want balanced columns stack
 * their sections in `flex flex-col gap-5` children instead of relying on the
 * grid to even them out.
 */
export function ConfigGrid({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return <div className={cn('grid items-start gap-5 lg:grid-cols-2', className)}>{children}</div>
}

/** Gallery archetype: a responsive card grid that fills by available width. */
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
        'grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** The default vertical rhythm for single-column pages. */
export function PageStack({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return <div className={cn('flex flex-col gap-5', className)}>{children}</div>
}
