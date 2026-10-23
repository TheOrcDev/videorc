import { useMemo, type ReactElement } from 'react'

import { SoundPadBoard } from '@/components/sound-pad-board'
import { StopAllSoundsButton } from '@/components/stop-all-sounds-button'
import type { SoundRelayAction, SoundboardSummary } from '../../../../shared/sound-commands'

/**
 * The Stream Manager's Sounds popover (plan 189 S9): the same pads as Studio,
 * four to a row, and Stop all while one plays. Each press relays to Studio,
 * which owns the backend socket; the ring and the progress come back with
 * the board. No keys here: 1 to 9 belong to the Studio page. Its own chunk,
 * so audiocn's pad loads with the first open.
 */
export default function SoundsPopoverBody({
  board,
  onSound
}: {
  /** Null until Studio has read the board. */
  board: SoundboardSummary | null
  onSound: (action: SoundRelayAction) => void
}): ReactElement {
  const voices = useMemo(
    () => new Map((board?.voices ?? []).map((voice) => [voice.soundId, voice])),
    [board]
  )
  return (
    <div className="flex flex-col gap-3" data-videorc-sounds-popover="">
      <div className="flex items-center justify-between gap-2">
        <span className="text-section font-semibold text-foreground">Sounds</span>
        <StopAllSoundsButton
          playing={(board?.voices.length ?? 0) > 0}
          size="xs"
          onStopAll={() => onSound({ action: 'stopAll' })}
        />
      </div>
      {!board ? (
        <p className="text-xs text-muted-foreground">Loading sounds…</p>
      ) : board.sounds.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sounds yet. Add sounds in Assets.</p>
      ) : (
        <SoundPadBoard
          columns={4}
          disabledReason={null}
          sounds={board.sounds}
          voices={voices}
          onPlay={(id) => onSound({ action: 'play', id })}
          onStop={(id) => onSound({ action: 'stop', id })}
        />
      )}
    </div>
  )
}
