import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { SectionLabel } from '@/components/section-label'
import { cn } from '@/lib/utils'

/** What every ListRow draws, whatever element it renders as. */
type ListRowOwnProps = {
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
  /**
   * Hover affordance. Off by default: most rows are facts. A row that acts
   * turns it on, or renders `as="button"`, where it is on unless turned off.
   */
  interactive?: boolean
  /** 28 px instead of 32 px. */
  compact?: boolean
  className?: string
  children?: ReactNode
}

/** A row as a plain element (the default); `title` is the row's title, never the tooltip attribute. */
type ListRowDivProps = ListRowOwnProps & { as?: 'div' } & Omit<
    ComponentProps<'div'>,
    keyof ListRowOwnProps
  >

/** A row that is one button: the whole row acts, with the keyboard focus ring. */
type ListRowAsButtonProps = ListRowOwnProps & { as: 'button' } & Omit<
    ComponentProps<'button'>,
    keyof ListRowOwnProps
  >

/**
 * The shared row (plan 050, D4; plan 174 S1.6a): every icon + title + meta
 * list renders through this one anatomy. A 20 px icon tile on the chip radius
 * (larger for platform marks, and YouTube's official icon is never clipped:
 * plan 165), the primary title, inline secondary context, optional alias
 * chips, spring space, then right-aligned status icons and a secondary meta
 * label. 32 px, or 28 px when compact. Selection is the theme's accent block.
 *
 * A row is a fact unless it says otherwise: `interactive` adds the hover, and
 * `as="button"` makes the whole row one button with the focus ring. A row
 * that holds its own controls keeps the div and stretches a ListRowButton
 * over itself instead.
 */
export function ListRow(props: ListRowDivProps | ListRowAsButtonProps): ReactElement {
  const {
    as = 'div',
    icon,
    title,
    context,
    alias,
    statusIcons,
    meta,
    selected = false,
    interactive = as === 'button',
    compact = false,
    className,
    children,
    ...rest
  } = props
  const rowClassName = cn(
    'flex items-center gap-2.5 rounded-row px-3 text-sm in-data-[slot=grouped-list]:rounded-none',
    compact ? 'h-row-compact' : 'h-row',
    interactive && 'cursor-default hover:bg-accent',
    selected && 'bg-accent',
    as === 'button' &&
      'w-full text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50',
    className
  )
  const body = (
    <>
      {icon ? (
        <span
          data-slot="list-row-icon"
          className="flex min-h-5 min-w-5 shrink-0 items-center justify-center overflow-hidden rounded-chip has-data-[slot=platform-mark]:overflow-visible has-data-[slot=platform-mark]:rounded-none [&_svg:not([class*='size-'])]:size-4"
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
          <span data-slot="list-row-meta" className="text-meta text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </span>
    </>
  )

  if (as === 'button') {
    return (
      <button
        data-slot="list-row"
        data-selected={selected || undefined}
        type="button"
        {...(rest as Omit<ComponentProps<'button'>, keyof ListRowOwnProps>)}
        className={rowClassName}
      >
        {body}
      </button>
    )
  }
  return (
    <div
      data-slot="list-row"
      data-selected={selected || undefined}
      {...(rest as Omit<ComponentProps<'div'>, keyof ListRowOwnProps>)}
      className={rowClassName}
    >
      {body}
    </div>
  )
}

/**
 * A grouped list (macOS Settings style): like things in one inset group,
 * split by hairlines. An optional section label names the group. Extra
 * attributes (an `aria-label`, a `data-testid`) land on the list itself.
 */
export function GroupedList({
  label,
  children,
  className,
  ...props
}: {
  label?: ReactNode
  children: ReactNode
  className?: string
} & Omit<ComponentProps<'div'>, 'children' | 'className'>): ReactElement {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? <SectionLabel className="px-1">{label}</SectionLabel> : null}
      <div
        className="flex flex-col divide-y divide-border overflow-hidden rounded-row border border-border bg-inset"
        data-slot="grouped-list"
        {...props}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * A row's title as its button (plan 174 S0.5): stretched over the whole row,
 * so a click anywhere on the row acts, while a control in the row (a switch)
 * stays its sibling instead of nesting inside a button. Give the ListRow
 * `relative`; a control meant to stay clickable must be positioned too, as
 * the Switch is.
 */
export function ListRowButton({ className, ...props }: ComponentProps<'button'>): ReactElement {
  return (
    <button
      className={cn(
        'block max-w-full truncate text-left outline-hidden after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset',
        className
      )}
      data-slot="list-row-button"
      type="button"
      {...props}
    />
  )
}
