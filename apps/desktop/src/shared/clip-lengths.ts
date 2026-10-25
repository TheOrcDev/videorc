import type { ClipLength, ClipMarkedEvent } from './backend'
import {
  DEFAULT_CLIP_SECONDS,
  LONG_CLIP_SECONDS,
  formatClipMarkClock,
  type ClipMarkedToast
} from './clip-marks'

export type { ClipLength } from './backend'

// Plan 199: the clip-length checks for the relays and the remote intent, and
// the Stream Manager's words for a length. Kept out of `shared/clip-marks.ts`
// (eager) so they cost the Studio's first load nothing: never import this
// module from an eager one.

/** The two lengths a press may ask for. Mirrors `replay_buffer::CLIP_LENGTHS`. */
export const CLIP_LENGTHS: readonly ClipLength[] = [DEFAULT_CLIP_SECONDS, LONG_CLIP_SECONDS]
/** The refusal for any other length. Mirrors
 * `replay_buffer::INVALID_CLIP_LENGTH_CODE` and `INVALID_CLIP_LENGTH_MESSAGE`. */
export const INVALID_CLIP_LENGTH_CODE = 'invalid-clip-length'
export const INVALID_CLIP_LENGTH_MESSAGE = 'A clip is 30 seconds or 1 minute.'

export function isClipLength(value: unknown): value is ClipLength {
  return value === DEFAULT_CLIP_SECONDS || value === LONG_CLIP_SECONDS
}

/** A length that rode a relay or a remote intent: absent (or null) is no
 * length, which is today's 30 s; anything but 30 or 60 is refused with the
 * backend's own sentence. */
export function parseClipLength(value: unknown): ClipLength | undefined {
  if (value === undefined || value === null) return undefined
  if (isClipLength(value)) return value
  throw new Error(INVALID_CLIP_LENGTH_MESSAGE)
}

/** A clip length in words: "30 seconds", "1 minute", "2 minutes". */
export function clipLengthWords(seconds: number | undefined): string {
  if (!seconds) return 'seconds'
  if (seconds < 60) return `${seconds} seconds`
  const minutes = seconds / 60
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? '' : 's'}`
}

/**
 * The Stream Manager's toast for a press the ring took (its own window never
 * hears replay.saved, which is the main window's "Clip saved"). `seconds` is
 * the length the press asked for (plan 199: never the ring's), for the words;
 * `saved` says a recording kept the mark.
 */
export function clipSavingToast(
  event: Pick<ClipMarkedEvent, 'saved'>,
  seconds: number | undefined
): ClipMarkedToast {
  const last = seconds ? `the last ${formatClipMarkClock(seconds)}` : 'the last seconds'
  return {
    kind: 'success',
    title: `Saving ${last} as a clip`,
    description: event.saved
      ? `It's in Library, and this moment is marked in your recording.`
      : "It's in Library in a moment."
  }
}
