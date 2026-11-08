import { SILENCE_DB } from './audio/decibels'
import type { FrameSource, MeterFrame } from './audio/types'
import type { MicStreamFailureReason } from './mic-stream'

// Plans 092 and 093: what drives a microphone or System audio meter. Only lazy
// chunks (the Studio Microphone section, the Sources Audio mixer) import this
// module, so it stays out of the eager bundle.

/**
 * What drives a microphone meter: a live source (the backend's levels about
 * 20 times a second, or the renderer analyser), or one plain reading (the
 * session's 1 Hz level, silence while muted, NaN when nothing reads).
 */
export type MeterInput =
  | Readonly<{ kind: 'source'; source: FrameSource<MeterFrame> }>
  | Readonly<{ kind: 'value'; peakDb: number }>

const NO_READING: MeterInput = Object.freeze({ kind: 'value', peakDb: Number.NaN })
const SILENCE: MeterInput = Object.freeze({ kind: 'value', peakDb: SILENCE_DB })

/** No live reading: the meter rests and shows nothing. */
export function meterHasNoReading(meter: MeterInput): boolean {
  return meter.kind === 'value' && Number.isNaN(meter.peakDb)
}

/**
 * Issue 1064: the line under a session's meter when the bus sends no level.
 * The analyser would show what Chromium hears, not what is being recorded.
 */
export const MIC_SESSION_LEVEL_UNAVAILABLE_COPY =
  'Level unavailable. The meter shows only what your recording and stream hear.'

/**
 * The meter's input, in priority order. Every path reads the level the
 * recording gets: the backend measures it with the gain applied, on the
 * session bus during a session and on the warm microphone between sessions
 * (plan 092), and the analyser source adds the configured gain itself.
 *
 * Issue 1064: while a session's bus runs, only the backend's readings count.
 * The renderer analyser hears the microphone through Chromium, which on
 * Windows showed a healthy room while DirectShow handed the recording digital
 * silence; a session with no backend reading shows none.
 */
export function micMeterInput(input: {
  microphoneSelected: boolean
  muted: boolean
  /** The backend's levels while they arrive: the session bus or the standby microphone. */
  backendSource: FrameSource<MeterFrame> | null
  analyserDriven: boolean
  source: FrameSource<MeterFrame>
  /** The running session's 1 Hz level. */
  backendPeakDb: number | null
  /** A recording, livestream or Clips ring has a running audio bus (default: none). */
  sessionActive?: boolean
}): MeterInput {
  if (!input.microphoneSelected) return NO_READING
  if (input.muted) return SILENCE
  if (input.backendSource) return { kind: 'source', source: input.backendSource }
  if (input.analyserDriven && input.sessionActive !== true) {
    return { kind: 'source', source: input.source }
  }
  if (input.backendPeakDb !== null) return { kind: 'value', peakDb: input.backendPeakDb }
  return NO_READING
}

/**
 * Issue 1064: a session's meter with nothing honest to show. Muted and
 * unselected microphones have their own words.
 */
export function micSessionLevelUnavailable(input: {
  microphoneSelected: boolean
  muted: boolean
  sessionActive: boolean
  meter: MeterInput
}): boolean {
  return (
    input.sessionActive &&
    input.microphoneSelected &&
    !input.muted &&
    meterHasNoReading(input.meter)
  )
}

/**
 * System audio's meter input (plan 093): the bus measures System audio only
 * while a recording, livestream or Clips ring mixes it. Outside a running
 * bus nothing measures it, and a source would read silence, which is not the
 * same as "no reading".
 */
export function systemAudioMeterInput(input: {
  audioBusActive: boolean
  /** `SystemAudioSwitchView.meter`: requested or confirmed, no change pending. */
  mixed: boolean
  backendLevelsLive: boolean
  source: FrameSource<MeterFrame>
}): MeterInput {
  return input.audioBusActive && input.mixed && input.backendLevelsLive
    ? { kind: 'source', source: input.source }
    : NO_READING
}

/**
 * Plan 189: the soundboard's sounds as mixed, a reading only while a session's
 * bus runs (between sessions the monitor plays them, and no meter reads it).
 */
export function soundsMeterInput(input: {
  sessionActive: boolean
  backendLevelsLive: boolean
  source: FrameSource<MeterFrame>
}): MeterInput {
  return input.sessionActive && input.backendLevelsLive
    ? { kind: 'source', source: input.source }
    : NO_READING
}

/**
 * Plan 080 S3: the reason decides the words. This state is only reachable
 * once the OS has granted the mic, so only a real refusal may mention
 * permission. Since plan 093 it explains a microphone level with no live
 * reading (the Sources meter), where it used to explain a waveform preview.
 * Plan 174 S3.8 (C-14): the fix for a refusal is the page's Microphone
 * permission alert, so the line no longer points at Settings.
 */
export function micLevelUnavailableCopy(reason: MicStreamFailureReason | undefined): string {
  switch (reason) {
    case 'permission-denied':
      return "Videorc doesn't have permission to use this microphone."
    case 'device-busy':
      return "Another app is using this microphone. Its level comes back when it's free. Recording still works."
    case 'no-label-match':
    case 'ambiguous-label':
    case 'labels-hidden':
    case 'device-missing':
    case 'overconstrained':
      return 'No live level for this microphone. Recording still works.'
    default:
      return 'Live level unavailable. Recording still works.'
  }
}
