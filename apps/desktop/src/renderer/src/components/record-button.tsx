import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { RecordIcon, StopIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Where the session stands. `running` is a recording or a livestream; the
 * words say which.
 */
type RecordButtonState = 'idle' | 'starting' | 'running' | 'stopping'

const RECORD_BUTTON_STATES: readonly RecordButtonState[] = [
  'idle',
  'starting',
  'running',
  'stopping'
]

/** Each state's words when the caller passes none. */
const RECORD_BUTTON_LABELS: Record<RecordButtonState, string> = {
  idle: 'Record',
  running: 'Stop recording',
  starting: 'Record',
  stopping: 'Stopping…'
}

type RecordButtonProps = Omit<
  ComponentProps<typeof Button>,
  'children' | 'focusableWhenDisabled' | 'variant'
> & {
  /** Your own words for any state, such as "End livestream" for running. */
  labels?: Partial<Record<RecordButtonState, ReactNode>>
  state?: RecordButtonState
}

/**
 * Record and its stop button, as one control: metallic red, lit from the
 * click. While the session runs, its glow breathes and the button stops the
 * session. Starting and stopping answer at once: the button stays lit,
 * takes no click and keeps its focus, and nothing dims.
 *
 * Every state's words sit in the same cell and only the current state's
 * show, so the button is as wide as its longest words and never changes
 * width as the session moves on.
 *
 * It's a one-shot action whose words change, so it takes no `aria-pressed`.
 * Announce the session's state in a status region, not here. Pass
 * `disabled` with a Disabled reason when a start is blocked.
 */
function RecordButton({
  state = 'idle',
  labels,
  disabled = false,
  ...props
}: RecordButtonProps): ReactElement {
  const busy = state === 'starting' || state === 'stopping'
  return (
    <Button
      {...props}
      data-lit={state === 'idle' ? undefined : ''}
      data-state={state}
      disabled={busy || disabled}
      focusableWhenDisabled={busy}
      variant="record"
    >
      <span className="grid">
        {RECORD_BUTTON_STATES.map((each) => {
          const Glyph = each === 'idle' || each === 'starting' ? RecordIcon : StopIcon
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
              {labels?.[each] ?? RECORD_BUTTON_LABELS[each]}
            </span>
          )
        })}
      </span>
    </Button>
  )
}

export { RecordButton, RECORD_BUTTON_LABELS, type RecordButtonProps, type RecordButtonState }
