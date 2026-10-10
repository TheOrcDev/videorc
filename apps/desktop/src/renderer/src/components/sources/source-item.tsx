import { ChevronDownIcon, WarningIcon, type AppIcon } from '@/components/icons'
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

/** The header's chip: its hint is the tooltip, and is read out with it. */
export function SourceStatusChip({ status }: { status: SourceStatus }): ReactElement {
  const chip = <StatusBadge tone={status.tone} value={status.label} />
  if (!status.hint) return <span data-slot="source-status">{chip}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" data-slot="source-status">
          {chip}
          <span className="sr-only">{status.hint}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{status.hint}</TooltipContent>
    </Tooltip>
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
      asChild
      open={more ? moreOpen : false}
      onOpenChange={(open) => {
        setMoreOpen(open)
        writeMoreOpen(id, open)
      }}
    >
      <section
        aria-labelledby={titleId}
        className={cn('group/source-item flex flex-col', className)}
        data-disabled={disabled || undefined}
        data-slot="source-item"
        data-source={id}
        {...props}
      >
        <ListRow
          className="h-auto min-h-10 py-1.5"
          icon={
            <Icon
              className="size-4 text-muted-foreground group-data-[disabled]/source-item:text-subtle"
              weight="duotone"
            />
          }
          interactive={false}
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
          {control}
          {more ? (
            <CollapsibleTrigger asChild>
              <Button
                aria-controls={moreId}
                aria-label={moreLabel ?? `More ${title} settings`}
                className="text-muted-foreground"
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <ChevronDownIcon
                  className={cn('transition-transform duration-150', moreOpen && 'rotate-180')}
                />
              </Button>
            </CollapsibleTrigger>
          ) : null}
        </ListRow>
        {children ? (
          <div
            className={cn('flex min-w-0 flex-col gap-2 pr-3 pb-3 pl-10.5', bodyClassName)}
            data-slot="source-item-body"
          >
            {children}
          </div>
        ) : null}
        {more ? (
          <CollapsibleContent
            className="flex min-w-0 flex-col gap-3 border-t border-border py-3 pr-3 pl-10.5"
            data-slot="source-item-more"
            id={moreId}
          >
            {more}
          </CollapsibleContent>
        ) : null}
      </section>
    </Collapsible>
  )
}

/**
 * A label, a fader (or any control) and its value on one line:
 * `Gain [——●——] 0.0 dB`. The value column is wide enough for "−60.0 dB", so
 * dragging never resizes the row.
 */
export function SourceControlRow({
  label,
  value,
  children
}: {
  label: string
  value?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-3" data-slot="source-control-row">
      <span aria-hidden className="w-9 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {value != null ? (
        <span
          className="min-w-[8ch] shrink-0 text-right font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums"
          data-slot="source-control-value"
        >
          {value}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The facts line under a picker, or the warning that replaces it. Colour is
 * information: a warning's tone is its icon, the words stay monochrome.
 */
export function SourceFacts({
  children,
  tone = 'neutral'
}: {
  children: ReactNode
  tone?: 'neutral' | 'warning'
}): ReactElement {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-xs tabular-nums',
        tone === 'warning' ? 'text-foreground' : 'text-muted-foreground'
      )}
      data-slot="source-facts"
      data-tone={tone}
    >
      {tone === 'warning' ? (
        <WarningIcon className="mt-0.5 size-3.5 shrink-0 text-warning" weight="fill" />
      ) : null}
      <span className="min-w-0">{children}</span>
    </p>
  )
}
