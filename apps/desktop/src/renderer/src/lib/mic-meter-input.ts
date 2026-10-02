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
 * The meter's input, in priority order. Every path reads the level the
 * recording gets: the backend measures it with the gain applied, on the
 * session bus during a session and on the warm microphone between sessions
 * (plan 092), and the analyser source adds the configured gain itself.
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
}): MeterInput {
  if (!input.microphoneSelected) return NO_READING
  if (input.muted) return SILENCE
  if (input.backendSource) return { kind: 'source', source: input.backendSource }
  if (input.analyserDriven) return { kind: 'source', source: input.source }
  if (input.backendPeakDb !== null) return { kind: 'value', peakDb: input.backendPeakDb }
  return NO_READING
}

/**
 * System audio's meter input (plan 093): the bus measures System audio only
 * while a session mixes it. Outside one nothing measures it, and a source
 * would read silence, which is not the same as "no reading".
 */
export function systemAudioMeterInput(input: {
  sessionActive: boolean
  /** `SystemAudioSwitchView.meter`: requested or confirmed, no change pending. */
  mixed: boolean
  backendLevelsLive: boolean
  source: FrameSource<MeterFrame>
}): MeterInput {
  return input.sessionActive && input.mixed && input.backendLevelsLive
    ? { kind: 'source', source: input.source }
    : NO_READING
}

/**
 * Plan 080 S3: the reason decides the words. This state is only reachable
 * once the OS has granted the mic, so only a real refusal may mention
 * permission. Since plan 093 it explains a microphone level with no live
 * reading (the Sources meter), where it used to explain a waveform preview.
 */
export function micLevelUnavailableCopy(reason: MicStreamFailureReason | undefined): string {
  switch (reason) {
    case 'permission-denied':
      return "Videorc can't use this mic. Check Settings → Permissions."
    case 'device-busy':
      return "Another app is using this mic. Its level comes back when it's free. Recording still works."
    case 'no-label-match':
    case 'ambiguous-label':
    case 'labels-hidden':
    case 'device-missing':
    case 'overconstrained':
      return 'No live level for this mic. Recording still works.'
    default:
      return 'Live level unavailable. Recording still works.'
  }
}
