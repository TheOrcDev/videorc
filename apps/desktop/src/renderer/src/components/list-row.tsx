import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { SectionLabel } from '@/components/section-label'
import { cn } from '@/lib/utils'

/** What every ListRow draws, whatever element it renders as. */
interface ListRowOwnProps {
  /** A control before the title (a sound's play button), never clipped like the icon tile. */
  leading?: ReactNode
  /** The icon tile content (an app or source icon: the colourful slot). */
  icon?: ReactNode
  title: ReactNode
  /** Inline secondary context after the title (platform, owner, kind). */
  context?: ReactNode
  /** Optional key chips right after the context (an alias). */
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

type ListRowProps = ListRowDivProps | ListRowAsButtonProps

/**
 * The shared row: every icon + title + meta list renders through this one
 * anatomy. A 20 px icon tile on the chip radius (larger for platform marks,
 * which are never clipped), the primary title, inline secondary context,
 * optional alias chips, spring space, then right-aligned status icons and a
 * secondary meta label. 32 px, or 28 px when compact. Selection is the
 * theme's accent block.
 *
 * A row is a fact unless it says otherwise: `interactive` adds the hover, and
 * `as="button"` makes the whole row one button with the focus ring. A row
 * that holds its own controls keeps the div and stretches a ListRowButton
 * over itself instead.
 */
function ListRow(props: ListRowProps): ReactElement {
  const {
    as = 'div',
    leading,
    icon,
    title,
    context,
    alias,
    statusIcons,
    meta,
    selected = false,
    interactive: interactiveProp,
    compact = false,
    className,
    children,
    ...rest
  } = props
  const interactive = interactiveProp ?? as === 'button'
  const rowClassName = cn(
    'rounded-row flex items-center gap-2.5 px-3 text-sm in-data-[slot=grouped-list]:rounded-none',
    compact ? 'h-row-compact' : 'h-row',
    interactive && 'hover:bg-accent cursor-default',
    selected && 'bg-accent',
    as === 'button' &&
      'focus-visible:ring-ring w-full text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50',
    className
  )
  const body = (
    <>
      {leading}
      {icon ? (
        <span
          className="rounded-chip flex min-h-5 min-w-5 shrink-0 items-center justify-center overflow-hidden has-data-[slot=platform-mark]:overflow-visible has-data-[slot=platform-mark]:rounded-none [&_svg:not([class*='size-'])]:size-4"
          data-slot="list-row-icon"
        >
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="text-foreground truncate font-medium" data-slot="list-row-title">
          {title}
        </span>
        {context ? (
          <span className="text-muted-foreground truncate" data-slot="list-row-context">
            {context}
          </span>
        ) : null}
        {alias}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {children}
        {statusIcons ? (
          <span className="text-muted-foreground flex items-center gap-1.5 [&_svg:not([class*='size-'])]:size-4">
            {statusIcons}
          </span>
        ) : null}
        {meta ? (
          <span className="text-meta text-muted-foreground" data-slot="list-row-meta">
            {meta}
          </span>
        ) : null}
      </span>
    </>
  )

  if (as === 'button') {
    return (
      <button
        data-selected={selected || undefined}
        data-slot="list-row"
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
      data-selected={selected || undefined}
      data-slot="list-row"
      {...(rest as Omit<ComponentProps<'div'>, keyof ListRowOwnProps>)}
      className={rowClassName}
    >
      {body}
    </div>
  )
}

type GroupedListProps = {
  /** The group's name, as a SectionLabel over it. */
  label?: ReactNode
  children: ReactNode
  className?: string
} & Omit<ComponentProps<'div'>, 'children' | 'className'>

/**
 * A grouped list (macOS Settings style): like things in one inset group,
 * split by hairlines. An optional section label names the group. Extra
 * attributes (an `aria-label`, a `data-testid`) land on the list itself.
 */
function GroupedList({ label, children, className, ...props }: GroupedListProps): ReactElement {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? <SectionLabel className="px-1">{label}</SectionLabel> : null}
      <div
        className="divide-border rounded-row border-border bg-inset flex flex-col divide-y overflow-hidden border"
        data-slot="grouped-list"
        {...props}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * A row's title as its button: stretched over the whole row, so a click
 * anywhere on the row acts, while a control in the row (a switch) stays its
 * sibling instead of nesting inside a button. Give the ListRow `relative`; a
 * control meant to stay clickable must be positioned too, as the Switch is.
 */
function ListRowButton({ className, ...props }: ComponentProps<'button'>): ReactElement {
  return (
    <button
      className={cn(
        'focus-visible:after:ring-ring block max-w-full truncate text-left outline-hidden after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset',
        className
      )}
      data-slot="list-row-button"
      type="button"
      {...props}
    />
  )
}

export { ListRow, GroupedList, ListRowButton, type ListRowProps, type GroupedListProps }
