import { Robot } from '@phosphor-icons/react'
import { useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import type { CohostState } from '@/lib/backend'
import { cohostPresenceView, type CohostPresenceView } from '@/lib/cohost-presence'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { cn } from '@/lib/utils'

/**
 * The PERMANENT co-host presence element in the Comments window toolbar. It is
 * always rendered — the whole point of W2 is that "is the co-host even there?"
 * is never a question a streamer has to ask mid-stream.
 *
 * Click behaviour splits on one axis: a co-host that exists takes you to it
 * (scroll + expand the pane); a co-host that is OFF offers the one action that
 * changes that, in a popover, gated exactly like the pane is.
 */
export function CohostStatus({
  state,
  gate,
  consented,
  enabled,
  nowMs,
  starting = false,
  unread = 0,
  flash = null,
  onOpenPane,
  onEnable,
  onEnableConsent,
  onUpgrade
}: {
  state: CohostState | null
  gate: EntitlementUiGate
  consented: boolean
  enabled: boolean
  /** Ticking clock for the relative tooltip lines. */
  nowMs: number
  starting?: boolean
  unread?: number
  /** One-shot "grouped 2 questions" delta, shown in place of the label. */
  flash?: string | null
  onOpenPane?: () => void
  onEnable?: (enabled: boolean) => void
  onEnableConsent?: () => void
  onUpgrade?: (url: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const view = cohostPresenceView(state, nowMs, { starting, unread })
  const tooltip = view.tooltipLines.join('\n')
  const offPopover = view.kind === 'off'

  const body = <CohostStatusBody flash={flash} label={view.label} view={view} />

  if (!offPopover) {
    return (
      <button
        aria-label={view.label}
        className={STATUS_TRIGGER}
        data-slot="cohost-status"
        data-state-kind={view.kind}
        title={tooltip || undefined}
        type="button"
        onClick={onOpenPane}
      >
        {body}
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={view.label}
        className={STATUS_TRIGGER}
        data-slot="cohost-status"
        data-state-kind={view.kind}
        title={tooltip || undefined}
      >
        {body}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverHeader>
          <PopoverTitle className="flex items-center gap-2 text-sm">
            <Robot aria-hidden className="size-4 shrink-0" weight="duotone" />
            Live Chat Co-host
          </PopoverTitle>
          <PopoverDescription>
            Groups the questions your chat is repeating and drafts a reply for each. Nothing sends
            without you.
          </PopoverDescription>
        </PopoverHeader>
        {!gate.allowed ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{gate.reason}</p>
            {gate.upgradeUrl && onUpgrade ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setOpen(false)
                  onUpgrade(gate.upgradeUrl as string)
                }}
              >
                View Premium
              </Button>
            ) : null}
          </div>
        ) : !consented ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Co-host reads live chat with Videorc cloud AI. Turn on cloud AI to use it.
            </p>
            {onEnableConsent ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setOpen(false)
                  onEnableConsent()
                }}
              >
                Turn on cloud AI
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Label className="min-w-0 flex-1 text-xs font-normal" htmlFor="cohost-status-enable">
              Read live chat during this stream
            </Label>
            <Switch
              checked={enabled}
              disabled={!onEnable}
              id="cohost-status-enable"
              onCheckedChange={(next) => onEnable?.(next)}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const STATUS_TRIGGER =
  'flex shrink-0 items-center gap-1.5 rounded-chip px-1.5 py-0.5 text-xs transition-colors duration-100 hover:bg-accent/60 [-webkit-app-region:no-drag]'

function CohostStatusBody({
  view,
  label,
  flash
}: {
  view: CohostPresenceView
  label: string
  flash: string | null
}): ReactElement {
  return (
    <>
      <CohostPresenceDot view={view} />
      {/* The DOT carries the error; the label stays chrome. The logo has two
          red eyes, not a red face. */}
      <span
        className={cn('truncate', view.kind === 'off' ? 'text-subtle' : 'text-muted-foreground')}
      >
        {flash ?? label}
      </span>
      {view.dots ? <CohostTypingDots fast={view.kind === 'thinking'} /> : null}
      {view.unreadBadge ? (
        <span
          aria-label={`${view.unreadBadge} new questions`}
          className="shrink-0 rounded-chip bg-foreground/10 px-1 text-[10px] font-medium tabular-nums text-foreground"
        >
          {view.unreadBadge}
        </span>
      ) : null}
    </>
  )
}

/**
 * The presence dot. Green ONLY while the engine is really listening, red ONLY
 * on a real error; everything else is the muted chrome gray (videorc-design:
 * color is information, never decoration).
 */
export function CohostPresenceDot({
  view,
  className
}: {
  view: CohostPresenceView
  className?: string
}): ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        view.dotTone === 'live'
          ? 'bg-success'
          : view.dotTone === 'destructive'
            ? 'bg-destructive'
            : 'bg-muted-foreground',
        view.pulse && 'animate-pulse',
        className
      )}
      data-slot="cohost-presence-dot"
      data-tone={view.dotTone}
    />
  )
}

/** Three shimmering dots — "someone is typing", read instantly as "working". */
export function CohostTypingDots({ fast = false }: { fast?: boolean }): ReactElement {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-0.5" data-slot="cohost-typing-dots">
      {[0, 1, 2].map((index) => (
        <span
          className={cn('typing-dot size-1 rounded-full bg-current', fast && 'typing-dot-fast')}
          key={index}
        />
      ))}
    </span>
  )
}
