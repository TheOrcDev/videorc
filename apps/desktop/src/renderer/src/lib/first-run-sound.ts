import { CLIP_THRESHOLD_DB } from './audio/zones'
import type { MeterFrame } from './audio/types'

// Plan 207 S6: Sound check's verdict and "Set level for me". Pure, over the
// meter's post-gain peaks, so the verdict always describes what the recording
// will hear. Only the setup chunk imports this module.

/** A peak above this counts as speech, not room noise. */
export const SOUND_CHECK_SPEECH_DB = -45
/** The verdict reads the last 8 s. */
export const SOUND_CHECK_WINDOW_MS = 8_000
/** Speech needed inside the window before there is a verdict. */
export const SOUND_CHECK_SPEECH_MS = 3_000
/** "Set level for me" puts speech peaks here: the middle of the meter's speech zone (−20 to −9). */
export const SOUND_CHECK_TARGET_DB = -12
/** Speech peaking below this reads "A bit quiet". */
export const SOUND_CHECK_QUIET_BELOW_DB = -24
/** Speech peaking above this reads "Too loud". */
export const SOUND_CHECK_LOUD_ABOVE_DB = -8
/** The microphone Gain range (`captureConfig.audio.microphoneGainDb`, `MicrophoneGainFader`). */
export const MICROPHONE_GAIN_MIN_DB = -24
export const MICROPHONE_GAIN_MAX_DB = 24
/** A gap between readings longer than this never counts as speech time. */
const MAX_SAMPLE_SPAN_MS = 200
const SPEECH_PERCENTILE = 0.9

export type SoundCheckVerdict = 'none' | 'quiet' | 'good' | 'loud'

export interface SoundCheckSample {
  /** When the reading arrived, in ms. */
  at: number
  /** The loudest channel's peak, dBFS, after Gain. */
  peakDb: number
}

export interface SoundCheckReading {
  verdict: SoundCheckVerdict
  /** The 90th-percentile speech peak, once there is a verdict. */
  speechPeakDb: number | null
}

/** The loudest channel of one meter update; `-Infinity` when it has none. */
export function framePeakDb(frame: MeterFrame): number {
  let peak = Number.NEGATIVE_INFINITY
  for (const channel of frame.channels) {
    if (channel.peakDb > peak) peak = channel.peakDb
  }
  return peak
}

/** The window with one more reading, oldest dropped. Never mutates `samples`. */
export function addSoundCheckSample(
  samples: readonly SoundCheckSample[],
  sample: SoundCheckSample
): SoundCheckSample[] {
  const since = sample.at - SOUND_CHECK_WINDOW_MS
  const kept = samples.filter((entry) => entry.at > since && entry.at <= sample.at)
  if (Number.isFinite(sample.peakDb) || sample.peakDb === Number.NEGATIVE_INFINITY) {
    kept.push(sample)
  }
  return kept
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/**
 * What the last 8 s say about the level. A clip (a peak at the clip light's
 * −1 dBFS) reads "loud" at once; otherwise there is no verdict until 3 s of
 * speech, and then the 90th-percentile speech peak decides.
 */
export function soundCheckReading(
  samples: readonly SoundCheckSample[],
  now: number
): SoundCheckReading {
  const window = samples.filter(
    (sample) => sample.at > now - SOUND_CHECK_WINDOW_MS && sample.at <= now
  )
  const speechPeaks: number[] = []
  let speechMs = 0
  let clipped = false
  window.forEach((sample, index) => {
    if (sample.peakDb >= CLIP_THRESHOLD_DB) clipped = true
    if (!(sample.peakDb > SOUND_CHECK_SPEECH_DB)) return
    const next = window[index + 1]?.at ?? now
    speechMs += Math.min(Math.max(0, next - sample.at), MAX_SAMPLE_SPAN_MS)
    speechPeaks.push(sample.peakDb)
  })
  if (speechPeaks.length > 0 && clipped) {
    return { verdict: 'loud', speechPeakDb: percentile(speechPeaks, SPEECH_PERCENTILE) }
  }
  if (speechMs < SOUND_CHECK_SPEECH_MS) return { verdict: 'none', speechPeakDb: null }
  const speechPeakDb = percentile(speechPeaks, SPEECH_PERCENTILE)
  if (speechPeakDb < SOUND_CHECK_QUIET_BELOW_DB) return { verdict: 'quiet', speechPeakDb }
  if (speechPeakDb > SOUND_CHECK_LOUD_ABOVE_DB) return { verdict: 'loud', speechPeakDb }
  return { verdict: 'good', speechPeakDb }
}

/**
 * "Set level for me": the Gain that moves the measured speech peak to
 * −12 dBFS, in whole dB, inside the fader's range. The peak was measured
 * after the current Gain, so the change is relative to it.
 */
export function soundCheckGainDb(currentGainDb: number, speechPeakDb: number): number {
  const next = Math.round(currentGainDb + (SOUND_CHECK_TARGET_DB - speechPeakDb))
  return Math.min(MICROPHONE_GAIN_MAX_DB, Math.max(MICROPHONE_GAIN_MIN_DB, next))
}

/** The line under the meter for each verdict. */
export const SOUND_CHECK_COPY: Readonly<Record<SoundCheckVerdict, string>> = {
  none: 'Say something. The bar moves when Videorc hears you.',
  quiet: 'A bit quiet. Raise Gain or move closer.',
  good: 'Sounds good.',
  loud: 'Too loud. Lower Gain.'
}
