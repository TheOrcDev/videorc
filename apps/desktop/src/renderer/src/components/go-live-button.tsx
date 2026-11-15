import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { LivestreamIcon, StopIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Where the livestream stands. `checking` runs from the click until the
 * destinations answer; `live` is on air, when the button ends it.
 */
type GoLiveButtonState = 'idle' | 'checking' | 'live' | 'stopping'

const GO_LIVE_BUTTON_STATES: readonly GoLiveButtonState[] = ['idle', 'checking', 'live', 'stopping']

/** Each state's words when the caller passes none. */
const GO_LIVE_BUTTON_LABELS: Record<GoLiveButtonState, string> = {
  checking: 'Checking…',
  idle: 'Go Live',
  live: 'End livestream',
  stopping: 'Stopping…'
}

type GoLiveButtonProps = Omit<
  ComponentProps<typeof Button>,
  'children' | 'focusableWhenDisabled' | 'variant'
> & {
  /** Your own words for any state, such as "Go Live…" for idle. */
  labels?: Partial<Record<GoLiveButtonState, ReactNode>>
  state?: GoLiveButtonState
}

/**
 * Go Live and its End livestream, as one control: polished copper, a metal
 * of its own beside the silver primary and Record's red. Checking and
 * stopping answer at once: the button stays copper, takes no click and
 * keeps its focus, and nothing dims.
 *
 * Every state's words sit in the same cell and only the current state's
 * show, so the button is as wide as its longest words and never changes
 * width as the livestream moves on.
 *
 * It's a one-shot action whose words change, so it takes no `aria-pressed`.
 * Announce the livestream's state in a status region, not here. Pass
 * `disabled` with a Disabled reason when going live is blocked.
 */
function GoLiveButton({
  state = 'idle',
  labels,
  disabled = false,
  ...props
}: GoLiveButtonProps): ReactElement {
  const busy = state === 'checking' || state === 'stopping'
  return (
    <Button
      {...props}
      data-state={state}
      disabled={busy || disabled}
      focusableWhenDisabled={busy}
      variant="go-live"
    >
      <span className="grid">
        {GO_LIVE_BUTTON_STATES.map((each) => {
          const Glyph = each === 'idle' || each === 'checking' ? LivestreamIcon : StopIcon
          const current = each === state
          return (
            <span
              aria-hidden={current ? undefined : true}
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 group-data-[size=xs]/button:gap-1',
                !current && 'invisible'
              )}
              key={each}
            >
              <Glyph data-icon="inline-start" weight="fill" />
              {labels?.[each] ?? GO_LIVE_BUTTON_LABELS[each]}
            </span>
          )
        })}
      </span>
    </Button>
  )
}

export { GoLiveButton, GO_LIVE_BUTTON_LABELS, type GoLiveButtonProps, type GoLiveButtonState }
