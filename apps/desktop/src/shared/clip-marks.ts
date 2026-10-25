import type { ClipLength, ClipMarkParams, ClipMarkedEvent } from './backend'
import { formatTimecode } from './timecode'

export type { ClipLength } from './backend'

/** Plan 199: a press that names no length saves today's 30 s. Mirrors
 * `replay_buffer::DEFAULT_CLIP_SECONDS`. */
export const DEFAULT_CLIP_SECONDS = 30 satisfies ClipLength
/** Plan 199: the 1-minute clip. Mirrors `replay_buffer::LONG_CLIP_SECONDS`. */
export const LONG_CLIP_SECONDS = 60 satisfies ClipLength
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

/** `clip.mark` params for a press: none at all without a length, so an
 * existing caller sends exactly what it sent before plan 199. */
export function clipMarkParams(seconds?: ClipLength): ClipMarkParams | undefined {
  return seconds === undefined ? undefined : { seconds }
}

/** Recording-file time as the one timecode: m:ss, or h:mm:ss from one hour (plan 068 D6, plan 174 S1.4). */
export function formatClipMarkClock(atSeconds: number): string {
  return formatTimecode(atSeconds * 1000)
}

export interface ClipMarkedToast {
  kind: 'success' | 'warning'
  title: string
  description?: string
}

/** Where a saved mark shows up: the stream's report in the Buddy tab (plan 119 S3). */
export const CLIP_MARK_IN_REPORT = "It's in your stream report in Buddy."

/** The ring saved the last seconds as a clip (plan 181, redesign R4);
 * `saved` then says whether a recording also kept the mark. Mirrors
 * `clip_marks::CLIP_SAVED_REASON`. */
export const CLIP_MARK_CLIP_SAVED_REASON = 'clip-saved'

export function clipMarkSavedClip(event: Pick<ClipMarkedEvent, 'reason'>): boolean {
  return event.reason === CLIP_MARK_CLIP_SAVED_REASON
}

/** The ring's length in words: "30 seconds", "1 minute", "2 minutes". */
export function clipLengthWords(seconds: number | undefined): string {
  if (!seconds) return 'seconds'
  if (seconds < 60) return `${seconds} seconds`
  const minutes = seconds / 60
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? '' : 's'}`
}

/** The press kept something: a clip, a mark, or both. */
export function clipMarkKeptSomething(event: Pick<ClipMarkedEvent, 'saved' | 'reason'>): boolean {
  return event.saved || clipMarkSavedClip(event)
}

/**
 * The Stream Manager's toast for a press the ring took (its own window never
 * hears replay.saved, which is the main window's "Clip saved"). `seconds` is
 * the ring's length, for the words; `saved` says a recording kept the mark.
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

/**
 * The toast for a `clip.marked` event or a `clip.mark` reply the ring did
 * not take: where the mark landed, or why nothing was kept. One copy for
 * every window that shows it. `streaming: false` is a recording that never
 * went live: it has no stream report, so the toast does not point at one.
 */
export function clipMarkedToast(
  event: ClipMarkedEvent,
  { streaming = true }: { streaming?: boolean } = {}
): ClipMarkedToast {
  if (event.saved) {
    return {
      kind: 'success',
      title: `Clip marked at ${formatClipMarkClock(event.atSeconds)}`,
      description: streaming ? CLIP_MARK_IN_REPORT : undefined
    }
  }
  return {
    kind: 'warning',
    title: 'Clips are off, and nothing is recording.',
    description: 'Turn on Keep the last seconds on the Output page, or start a recording.'
  }
}
