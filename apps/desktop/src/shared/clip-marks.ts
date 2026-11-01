import type { ClipLength, ClipMarkedEvent } from './backend'
import { formatTimecode } from './timecode'

export type { ClipLength } from './backend'

// Plan 199: only the two lengths live here, because this module sits in the
// eager renderer chunk (Studio imports it for the clip.marked toast). The
// Stream-Manager-only words (`clipLengthWords`, `clipSavingToast`) and the
// length checks (`isClipLength`, `parseClipLength`, the refusal) are in
// `shared/clip-lengths.ts`, which no eager module imports.

/** Plan 199: a press that names no length saves today's 30 s. Mirrors
 * `replay_buffer::DEFAULT_CLIP_SECONDS`. */
export const DEFAULT_CLIP_SECONDS = 30 satisfies ClipLength
/** Plan 199: the 1-minute clip. Mirrors `replay_buffer::LONG_CLIP_SECONDS`. */
export const LONG_CLIP_SECONDS = 60 satisfies ClipLength

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

/** The press kept something: a clip, a mark, or both. */
export function clipMarkKeptSomething(event: Pick<ClipMarkedEvent, 'saved' | 'reason'>): boolean {
  return event.saved || clipMarkSavedClip(event)
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
