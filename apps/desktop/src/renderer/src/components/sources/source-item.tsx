import { ChevronDownIcon, type AppIcon } from '@/components/icons'
import { useId, useState, type ReactElement, type ReactNode } from 'react'

import { ListRow } from '@/components/list-row'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SourceStatus } from '@/lib/source-status'
import { cn } from '@/lib/utils'

// Plan 173: the one shape every Sources row takes, Screen, Camera, Microphone
// and System audio alike. A header row (icon, title, an optional tag, the one
// status chip, the source's quick control, the More chevron), a body indented
// to the title so pickers, facts and meters share one left edge, and a folded
// More area for the rare settings. Built like the Livestream destination rows
// (destination-card.tsx), inside one GroupedList per column.

const MORE_STORAGE_PREFIX = 'videorc.sources.more.'

function readMoreOpen(id: string): boolean {
  try {
    return window.localStorage.getItem(`${MORE_STORAGE_PREFIX}${id}`) === '1'
  } catch {
    return false
  }
}

function writeMoreOpen(id: string, open: boolean): void {
  try {
    if (open) window.localStorage.setItem(`${MORE_STORAGE_PREFIX}${id}`, '1')
    else window.localStorage.removeItem(`${MORE_STORAGE_PREFIX}${id}`)
  } catch {
    // A blocked store only means More opens closed next time.
  }
}

/** The header's chip. Its hint is a visible line in the body (plan 174 C-10). */
export function SourceStatusChip({ status }: { status: SourceStatus }): ReactElement {
  return (
    <span className="inline-flex" data-slot="source-status">
      <StatusBadge tone={status.tone} value={status.label} />
    </span>
  )
}

export function SourceItem({
  id,
  icon: Icon,
  title,
  tag,
  status,
  control,
  more,
  moreLabel,
  defaultMoreOpen,
  disabled = false,
  children,
  className,
  bodyClassName,
  ...props
}: {
  /** Stable id: names the item and keys its More state on this device. */
  id: string
  icon: AppIcon
  title: string
  /** A small outline tag after the title (e.g. a non-default Sync offset). */
  tag?: ReactNode
  status?: SourceStatus | null
  /** The source's one quick control (Mute, the System audio switch). */
  control?: ReactNode
  /** The rare settings, folded away. No chevron without it. */
  more?: ReactNode
  /** The chevron's accessible name, e.g. "More microphone settings". */
  moreLabel?: string
  /** Overrides the remembered state (tests render it open). */
  defaultMoreOpen?: boolean
  disabled?: boolean
  children?: ReactNode
  className?: string
  bodyClassName?: string
} & Record<`data-${string}`, string | undefined>): ReactElement {
  const titleId = useId()
  const moreId = useId()
  const [moreOpen, setMoreOpen] = useState(() => defaultMoreOpen ?? readMoreOpen(id))

  return (
    <Collapsible
      open={more ? moreOpen : false}
      render={
        <section
          aria-labelledby={titleId}
          className={cn('group/source-item flex flex-col', className)}
          data-disabled={disabled || undefined}
          data-slot="source-item"
          data-source={id}
          {...props}
        />
      }
      onOpenChange={(open) => {
        setMoreOpen(open)
        writeMoreOpen(id, open)
      }}
    >
      {/* With More, the whole header row opens it (plan 213 A3): the
          chevron's button stretches over the row, so the chevron stays the
          one labelled trigger. The source's control is positioned above it;
          the tag and the chip are not, so a click on them opens More too. */}
      <ListRow
        className={cn('h-auto min-h-10 py-1.5', more && 'relative')}
        interactive={Boolean(more)}
        icon={
          <Icon
            className="size-4 text-muted-foreground group-data-[disabled]/source-item:text-subtle"
            weight="duotone"
          />
        }
        title={
          <span
            className="group-data-[disabled]/source-item:text-muted-foreground"
            data-slot="source-item-title"
            id={titleId}
          >
            {title}
          </span>
        }
        alias={tag}
      >
        {status ? <SourceStatusChip status={status} /> : null}
        {control ? (
          <span className="relative flex shrink-0 items-center" data-slot="source-item-control">
            {control}
          </span>
        ) : null}
        {more ? (
          <CollapsibleTrigger
            render={
              <Button
                aria-controls={moreId}
                aria-label={moreLabel ?? `More ${title} settings`}
                // Not positioned itself, so its ::after spans the header row.
                // The row's hover is the cue; the chevron doesn't light alone.
                className="static text-muted-foreground after:absolute after:inset-0 hover:bg-transparent dark:hover:bg-transparent"
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <ChevronDownIcon
              className={cn('transition-transform duration-150', moreOpen && 'rotate-180')}
            />
          </CollapsibleTrigger>
        ) : null}
      </ListRow>
      {children || status?.hint ? (
        <div
          className={cn('flex min-w-0 flex-col gap-2 pr-3 pb-3 pl-10.5', bodyClassName)}
          data-slot="source-item-body"
        >
          {children}
          {/* What to do about the chip, in words: it used to hide in a
                tooltip only (plan 174 C-10). */}
          {status?.hint ? (
            <p className="text-xs text-foreground" data-slot="source-status-hint" role="status">
              {status.hint}
            </p>
          ) : null}
        </div>
      ) : null}
      {more ? (
        <CollapsibleContent
          className="flex min-w-0 flex-col gap-3 border-t border-border py-3 pr-3 pl-10.5"
          data-testid="source-item-more"
          id={moreId}
        >
          {more}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}

/**
 * A label, a fader (or any control) and its value on one line:
 * `Gain [——●——] 0.0 dB`. The value column is wide enough for "−60.0 dB", so
 * dragging never resizes the row. With `reset`, the value off its default is
 * a button that puts it back (plan 174 C-38): a double-click on the thumb was
 * the only way, and no one could find it.
 */
export function SourceControlRow({
  label,
  value,
  reset,
  children
}: {
  label: string
  value?: ReactNode
  /** The value is off its default: the readout resets it. */
  reset?: { label: string; onReset: () => void } | null
  children: ReactNode
}): ReactElement {
  const valueClass =
    'min-w-[8ch] shrink-0 justify-end text-right font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums'
  return (
    <div className="flex min-w-0 items-center gap-3" data-slot="source-control-row">
      <span aria-hidden className="w-9 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {value != null ? (
        <span className={cn(valueClass, 'inline-flex')} data-slot="source-control-value">
          {reset ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    className="-mr-2 px-2 font-mono text-muted-foreground tabular-nums hover:text-foreground"
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={reset.onReset}
                  />
                }
              >
                {value}
                <span className="sr-only">. {reset.label}</span>
              </TooltipTrigger>
              <TooltipContent>{reset.label}</TooltipContent>
            </Tooltip>
          ) : (
            value
          )}
        </span>
      ) : null}
    </div>
  )
}

/** The facts line under a picker: secondary text. A warning is an Alert instead. */
export function SourceFacts({ children }: { children: ReactNode }): ReactElement {
  return (
    <p className="text-xs text-muted-foreground tabular-nums" data-slot="source-facts">
      {children}
    </p>
  )
}
