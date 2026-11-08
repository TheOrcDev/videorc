import type { ReactElement } from 'react'

import { SourceControlRow } from '@/components/sources/source-item'
import { Fader, FaderRange, FaderThumb, FaderTrack } from '@/components/ui/fader'
import { formatDb } from '@/lib/audio/decibels'
import {
  SYSTEM_AUDIO_GAIN_DB_DEFAULT,
  SYSTEM_AUDIO_GAIN_DB_MAX,
  SYSTEM_AUDIO_GAIN_DB_MIN
} from '@/lib/backend'

// Plan 201: the Microphone and System audio Gain faders, one definition for
// Sources and the Studio's Audio section, so the two pages can't drift. They
// are the audiocn Fader plan 093 chose, styled from outside (docs/audiocn.md),
// and every tick writes the same value through the caller's setter.

/** Videorc's slider knob on audiocn's thumbs (they paint the translucent coat). */
export const FADER_THUMB = 'bg-knob ring-knob-ring'

/** The renderer stores whole numbers (`clampNumber`), so faders step whole dB. */
const MICROPHONE_GAIN_DETENTS = [0]
const SYSTEM_AUDIO_GAIN_DETENTS = [SYSTEM_AUDIO_GAIN_DB_DEFAULT, 0]

/** The microphone's Gain default: the readout resets to it (plan 174 C-38). */
const MICROPHONE_GAIN_DB_DEFAULT = 0

/**
 * The readout's reset while a gain is off its default, or null at the
 * default: "Reset to 0.0 dB".
 */
export function gainReset(
  gainDb: number,
  defaultDb: number,
  onGainChange: (gainDb: number) => void
): { label: string; onReset: () => void } | null {
  return gainDb === defaultDb
    ? null
    : { label: `Reset to ${formatDb(defaultDb)}`, onReset: () => onGainChange(defaultDb) }
}

/** Microphone Gain: −24 to +24 dB, a detent and the reset at 0 dB. */
export function MicrophoneGainFader({
  gainDb,
  onGainChange
}: {
  gainDb: number
  onGainChange: (gainDb: number) => void
}): ReactElement {
  return (
    <SourceControlRow
      label="Gain"
      reset={gainReset(gainDb, MICROPHONE_GAIN_DB_DEFAULT, onGainChange)}
      value={formatDb(gainDb)}
    >
      <Fader
        aria-label="Microphone gain"
        className="w-full"
        detents={MICROPHONE_GAIN_DETENTS}
        fineStep={1}
        largeStep={6}
        max={24}
        min={-24}
        origin={0}
        resetValue={MICROPHONE_GAIN_DB_DEFAULT}
        step={1}
        value={gainDb}
        onValueChange={onGainChange}
      >
        <FaderTrack>
          <FaderRange />
          <FaderThumb className={FADER_THUMB} />
        </FaderTrack>
      </Fader>
    </SourceControlRow>
  )
}

/**
 * System audio Gain: −24 to +12 dB, detents at −6 and 0 dB, the reset at
 * −6 dB. Disabled (with no reset) while Screen Recording is missing.
 */
export function SystemAudioGainFader({
  gainDb,
  disabled = false,
  onGainChange
}: {
  gainDb: number
  disabled?: boolean
  onGainChange: (gainDb: number) => void
}): ReactElement {
  return (
    <SourceControlRow
      label="Gain"
      reset={disabled ? null : gainReset(gainDb, SYSTEM_AUDIO_GAIN_DB_DEFAULT, onGainChange)}
      value={formatDb(gainDb)}
    >
      <Fader
        aria-label="System audio gain"
        className="w-full"
        detents={SYSTEM_AUDIO_GAIN_DETENTS}
        disabled={disabled}
        fineStep={1}
        largeStep={6}
        max={SYSTEM_AUDIO_GAIN_DB_MAX}
        min={SYSTEM_AUDIO_GAIN_DB_MIN}
        resetValue={SYSTEM_AUDIO_GAIN_DB_DEFAULT}
        step={1}
        value={gainDb}
        onValueChange={onGainChange}
      >
        <FaderTrack>
          <FaderRange />
          <FaderThumb className={FADER_THUMB} />
        </FaderTrack>
      </Fader>
    </SourceControlRow>
  )
}
