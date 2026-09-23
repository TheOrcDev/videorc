import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The shared row (plan 050, D4): every icon + title + meta list renders
 * through this one anatomy. A 20 px icon tile, the primary title, inline
 * secondary context, optional alias chips, spring space, then right-aligned
 * status icons and a secondary meta label. 32 px, or 28 px when compact.
 * Selection is the theme's accent block.
 */
export function ListRow({
  icon,
  title,
  context,
  alias,
  statusIcons,
  meta,
  selected = false,
  interactive = true,
  compact = false,
  className,
  children,
  ...props
}: {
  /** The icon tile content (app/source icon: the colourful slot). */
  icon?: ReactNode
  title: ReactNode
  /** Inline secondary context after the title (platform, owner, kind). */
  context?: ReactNode
  /** Optional key chips right after the context (e.g. an alias). */
  alias?: ReactNode
  /** Small status icons just before the meta label. */
  statusIcons?: ReactNode
  /** Right-aligned secondary metadata ("Command", "Connected"). */
  meta?: ReactNode
  selected?: boolean
  /** Render hover/active affordances; rows inside cmdk manage their own. */
  interactive?: boolean
  /** 28 px instead of 32 px. */
  compact?: boolean
  children?: ReactNode
} & ComponentProps<'div'>): ReactElement {
  return (
    <div
      data-slot="list-row"
      data-selected={selected || undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-row px-3 text-sm in-data-[slot=grouped-list]:rounded-none',
        compact ? 'h-row-compact' : 'h-row',
        interactive && 'cursor-default hover:bg-accent',
        selected && 'bg-accent',
        className
      )}
      {...props}
    >
      {icon ? (
        <span
          data-slot="list-row-icon"
          className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px] [&_svg:not([class*='size-'])]:size-4"
        >
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 items-baseline gap-2">
        <span data-slot="list-row-title" className="truncate font-medium text-foreground">
          {title}
        </span>
        {context ? (
          <span data-slot="list-row-context" className="truncate text-muted-foreground">
            {context}
          </span>
        ) : null}
        {alias}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {children}
        {statusIcons ? (
          <span className="flex items-center gap-1.5 text-muted-foreground [&_svg:not([class*='size-'])]:size-4">
            {statusIcons}
          </span>
        ) : null}
        {meta ? (
          <span data-slot="list-row-meta" className="text-xs text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/**
 * A grouped list (macOS Settings style): like things in one inset group,
 * split by hairlines. An optional 11 px label names the group.
 */
export function GroupedList({
  label,
  children,
  className
}: {
  label?: ReactNode
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <div className="px-1 text-[11px] font-semibold text-subtle" data-slot="grouped-list-label">
          {label}
        </div>
      ) : null}
      <div
        className="flex flex-col divide-y divide-border overflow-hidden rounded-row border border-border bg-foreground/[0.03]"
        data-slot="grouped-list"
      >
        {children}
      </div>
    </div>
  )
}
