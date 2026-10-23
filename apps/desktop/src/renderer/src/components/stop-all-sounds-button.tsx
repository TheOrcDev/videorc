import type { ComponentProps, ReactElement } from 'react'

import { StopIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { cn } from '@/lib/utils'

/**
 * Stop all, in Studio → Soundboard and the Stream Manager's Sounds popover:
 * there only while a sound plays, in any mode. Idle, it keeps its place
 * (`invisible`, out of the tab order and the accessibility tree) so the
 * header doesn't jump, and it fades in and out. ⌘K's Stop all sounds and a
 * remote's stopAll don't go through it.
 */
export function StopAllSoundsButton({
  playing,
  disabledReason = null,
  size,
  onStopAll
}: {
  /** At least one voice is playing. */
  playing: boolean
  /** Why it can't run while it shows (Videorc reconnecting). */
  disabledReason?: string | null
  size?: ComponentProps<typeof Button>['size']
  onStopAll: () => void
}): ReactElement {
  return (
    <span
      aria-hidden={playing ? undefined : true}
      className={cn(
        'inline-flex transition-[opacity,visibility] duration-150 motion-reduce:transition-none',
        !playing && 'invisible opacity-0'
      )}
      data-playing={playing ? '' : undefined}
      data-videorc-stop-all-sounds=""
      inert={!playing}
    >
      <DisabledReason reason={playing ? disabledReason : null}>
        <Button
          disabled={!playing || disabledReason !== null}
          size={size}
          variant="ghost"
          onClick={onStopAll}
        >
          {/* Filled, like Stop recording: the outline square read as a checkbox. */}
          <StopIcon data-icon="inline-start" weight="fill" />
          Stop all
        </Button>
      </DisabledReason>
    </span>
  )
}
