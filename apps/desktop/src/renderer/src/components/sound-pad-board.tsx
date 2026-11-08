import { useMemo, type ReactElement } from 'react'

import {
  SoundPad,
  SoundPadGrid,
  SoundPadLabel,
  SoundPadProgress,
  SoundPadShortcut,
  type SoundPadMode
} from '@/components/ui/sound-pad'
import { DisabledReason } from '@/components/ui/disabled-reason'
import type { SoundHotkey, SoundMode } from '@/lib/backend'
import { createVoiceProgressSource } from '@/lib/sound-progress'
import { soundPadLabel } from '@/lib/sounds'
import { pressStops } from '../../../shared/sound-commands'

// Plan 189: the soundboard's pads, one grid for Studio's Soundboard and the
// Stream Manager's Sounds popover. audiocn's pad only reports presses: it
// applies its mode (Play once restarts, Play/stop and Loop stop a playing
// sound, While held stops on release) and calls `onPlay` or `onStop`, which
// the page sends to the backend. `playing` and the progress come from
// `sounds.playback`. The grid's own hotkeys stay off: Studio listens for the
// keys once, for the whole page (soundboard-section.tsx).

/** The wire's press modes as audiocn's pad names them. */
const PAD_MODES: Readonly<Record<SoundMode, SoundPadMode>> = {
  oneShot: 'one-shot',
  toggle: 'toggle',
  loop: 'loop',
  hold: 'hold'
}

export interface SoundPadBoardSound {
  id: string
  name: string
  mode: SoundMode
  /** Shown as the pad's key chip; leave it out where the keys don't work. */
  hotkey?: SoundHotkey
}

/** A playing sound, enough for its pad's progress. */
export interface SoundPadBoardVoice {
  startedAtMs: number
  durationMs: number
  loop: boolean
}

export function SoundPadBoard({
  sounds,
  voices,
  columns,
  disabledReason,
  onPlay,
  onStop
}: {
  sounds: readonly SoundPadBoardSound[]
  /** The newest voice of each playing sound, by sound id. */
  voices: ReadonlyMap<string, SoundPadBoardVoice>
  /** The most pads in a row; narrower panes drop columns. */
  columns: number
  /** Why no pad plays right now (Videorc is reconnecting); null while they work. */
  disabledReason: string | null
  onPlay: (id: string) => void
  onStop: (id: string) => void
}): ReactElement {
  return (
    <SoundPadGrid aria-label="Sound pads" columns={columns}>
      {sounds.map((sound) => (
        <BoardPad
          disabledReason={disabledReason}
          key={sound.id}
          sound={sound}
          voice={voices.get(sound.id)}
          onPlay={onPlay}
          onStop={onStop}
        />
      ))}
    </SoundPadGrid>
  )
}

function BoardPad({
  sound,
  voice,
  disabledReason,
  onPlay,
  onStop
}: {
  sound: SoundPadBoardSound
  voice: SoundPadBoardVoice | undefined
  disabledReason: string | null
  onPlay: (id: string) => void
  onStop: (id: string) => void
}): ReactElement {
  const playing = voice !== undefined
  const startedAtMs = voice?.startedAtMs
  const durationMs = voice?.durationMs
  // A loop shows no progress: it has no end.
  const progressing = playing && !voice.loop
  const progress = useMemo(
    () =>
      progressing && startedAtMs !== undefined && durationMs !== undefined
        ? createVoiceProgressSource({ startedAtMs, durationMs })
        : null,
    [durationMs, progressing, startedAtMs]
  )
  return (
    // One tab stop for the grid's arrow keys: a disabled pad's reason is
    // the section's line, and this wrapper's tooltip on hover.
    <DisabledReason className="grid" reason={disabledReason} tabIndex={-1}>
      <SoundPad
        aria-label={soundPadLabel(sound.name, pressStops(sound.mode, playing))}
        className="rounded-row"
        data-videorc-sound-pad={sound.id}
        disabled={disabledReason !== null}
        hotkey={sound.hotkey}
        mode={PAD_MODES[sound.mode]}
        playing={playing}
        size="sm"
        onStop={() => onStop(sound.id)}
        onTrigger={() => onPlay(sound.id)}
      >
        <SoundPadLabel>{sound.name}</SoundPadLabel>
        {sound.hotkey ? <SoundPadShortcut /> : null}
        {progressing ? <SoundPadProgress source={progress} /> : null}
      </SoundPad>
    </DisabledReason>
  )
}
