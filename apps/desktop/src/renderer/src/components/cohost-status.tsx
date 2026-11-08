import { MicrophoneIcon } from '@/components/icons'
import { useId, type ComponentProps, type ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CohostListening, CohostState } from '@/lib/backend'
import { cohostPresenceView, type CohostPresenceView } from '@/lib/cohost-presence'
import { cohostListeningView } from '@/lib/cohost-view'
import { CHAT_HEADER_TIGHT_HIDDEN, CHAT_HEADER_TIGHT_SR_ONLY } from '@/lib/chat-header-tiers'
import { cn } from '@/lib/utils'

/**
 * The PERMANENT co-host presence element in the Stream Manager's Buddy pane
 * header. It is always rendered: the whole point of W2 is that "is the
 * co-host even there?" is never a question a streamer has to ask mid-stream.
 *
 * With a pane to go to it is a button that takes you there (scroll + expand);
 * otherwise it is a plain status line. Turning Buddy on and off is the
 * `BuddyLiveSwitch` beside it (plan 174 S3.14a), never a popover here.
 */
export function CohostStatus({
  state,
  nowMs,
  starting = false,
  unread = 0,
  flash = null,
  onOpenPane
}: {
  state: CohostState | null
  /** Ticking clock for the relative tooltip lines. */
  nowMs: number
  starting?: boolean
  unread?: number
  /** One-shot "grouped 2 questions" delta, shown in place of the label. */
  flash?: string | null
  onOpenPane?: () => void
}): ReactElement {
  const view = cohostPresenceView(state, nowMs, { starting, unread })
  const descriptionId = useId()
  // The label leads the tooltip: in a narrow Chat header the dot is all that
  // shows, and hovering it must still say what the co-host is doing. The
  // facts after it are the trigger's description too (plan 174 S1.10).
  const lines = [flash ?? view.label, ...view.tooltipLines]

  const body = <CohostStatusBody flash={flash} label={view.label} view={view} />
  const described = view.tooltipLines.length > 0 ? descriptionId : undefined

  const trigger = onOpenPane ? (
    <button
      aria-describedby={described}
      aria-label={view.label}
      className={STATUS_TRIGGER}
      data-testid="cohost-status"
      data-state-kind={view.kind}
      type="button"
      onClick={onOpenPane}
    >
      {body}
    </button>
  ) : (
    <span
      aria-describedby={described}
      aria-label={view.label}
      className={STATUS_TRIGGER}
      data-testid="cohost-status"
      data-state-kind={view.kind}
      role="status"
    >
      {body}
    </span>
  )

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent className="flex-col items-start gap-0.5" side="bottom">
          {lines.map((line, index) => (
            <span key={`${line}:${index}`}>{line}</span>
          ))}
        </TooltipContent>
      </Tooltip>
      {described ? (
        <span data-slot="cohost-status-detail" hidden id={descriptionId}>
          {view.tooltipLines.join('. ')}
        </span>
      ) : null}
    </>
  )
}

/**
 * The Buddy Live switch (plan 174 S3.14a, D7): on and off, nothing else. It
 * never grants cloud AI or the microphone: without consent the caller opens
 * the consent dialog instead, and listening has its own switch and card. A
 * locked account can still turn Buddy off, never on, and the switch says why.
 */
export function BuddyLiveSwitch({
  checked,
  disabledReason = null,
  id = 'buddy-live-switch',
  size = 'sm',
  className,
  onCheckedChange
}: {
  checked: boolean
  /** Why the switch cannot move, while it cannot (Premium, loading). */
  disabledReason?: string | null
  id?: string
  size?: 'sm' | 'default'
  className?: string
  onCheckedChange: (on: boolean) => void
}): ReactElement {
  return (
    <div
      className={cn('flex shrink-0 items-center gap-1.5', className)}
      data-slot="buddy-live-switch"
    >
      <Label className="text-xs font-medium text-foreground" htmlFor={id}>
        Buddy Live
      </Label>
      <DisabledReason reason={disabledReason}>
        <Switch
          checked={checked}
          disabled={disabledReason !== null}
          id={id}
          size={size}
          onCheckedChange={onCheckedChange}
        />
      </DisabledReason>
    </div>
  )
}

// Shrinks and truncates instead of pushing the header's other items out: a
// paused label with its reason is the longest thing the header can hold.
const STATUS_TRIGGER =
  'flex min-w-0 max-w-40 shrink items-center gap-1.5 rounded-chip px-1.5 py-0.5 text-xs transition-colors duration-100 hover:bg-accent/60 [-webkit-app-region:no-drag]'

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
        className={cn(
          'min-w-0 truncate',
          view.kind === 'off' ? 'text-subtle' : 'text-muted-foreground',
          CHAT_HEADER_TIGHT_SR_ONLY
        )}
        data-slot="cohost-status-label"
      >
        {flash ?? label}
      </span>
      {view.dots ? (
        <CohostTypingDots className={CHAT_HEADER_TIGHT_HIDDEN} fast={view.kind === 'thinking'} />
      ) : null}
      {view.unreadBadge ? (
        <Badge aria-label={`${view.unreadBadge} new questions`} className="tabular-nums">
          {view.unreadBadge}
        </Badge>
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
        'size-1.5 shrink-0 rounded-full glass-dot',
        view.dotTone === 'live'
          ? 'tone-success'
          : view.dotTone === 'destructive'
            ? 'tone-destructive'
            : 'tone-neutral',
        view.pulse && 'animate-pulse',
        className
      )}
      data-slot="cohost-presence-dot"
      data-tone={view.dotTone}
    />
  )
}

/**
 * Whether Buddy hears the streamer (plan 068): a microphone and a few words
 * beside Buddy's status, nothing at all while listening is off. The icon
 * carries the tone (green on, amber blocked) and the words stay chrome; in a
 * tight header only the icon shows and the words move to the tooltip.
 */
export function CohostListeningIndicator({
  listening,
  className
}: {
  listening: CohostListening | null | undefined
  className?: string
}): ReactElement | null {
  const view = cohostListeningView(listening)
  if (!view) return null
  // The words fold to the icon in a tight header; the sentence stays the
  // tooltip and, for a screen reader, text beside the label (plan 174 S1.10).
  return (
    <Tooltip>
      <TooltipTrigger render={<ListeningChip className={className} view={view} />} />
      <TooltipContent>{view.detail}</TooltipContent>
    </Tooltip>
  )
}

function ListeningChip({
  view,
  className,
  ...props
}: {
  view: NonNullable<ReturnType<typeof cohostListeningView>>
  className?: string
} & Omit<ComponentProps<'span'>, 'children'>): ReactElement {
  return (
    <span
      {...props}
      className={cn('flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground', className)}
      data-listening-state={view.state}
      data-slot="cohost-listening"
    >
      <MicrophoneIcon
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          view.state === 'on'
            ? 'text-success'
            : view.state === 'blocked'
              ? 'text-warning'
              : 'text-muted-foreground'
        )}
        weight={view.state === 'on' ? 'fill' : 'regular'}
      />
      <span className={cn('min-w-0 truncate', CHAT_HEADER_TIGHT_SR_ONLY)}>{view.label}</span>
      {view.detail ? <span className="sr-only">{`. ${view.detail}`}</span> : null}
    </span>
  )
}

/** Three shimmering dots — "someone is typing", read instantly as "working". */
export function CohostTypingDots({
  fast = false,
  className
}: {
  fast?: boolean
  className?: string
}): ReactElement {
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center gap-0.5', className)}
      data-slot="cohost-typing-dots"
    >
      {[0, 1, 2].map((index) => (
        <span
          className={cn('typing-dot size-1 rounded-full bg-current', fast && 'typing-dot-fast')}
          key={index}
        />
      ))}
    </span>
  )
}
