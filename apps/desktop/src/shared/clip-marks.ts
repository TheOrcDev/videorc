import type { ClipMarkedEvent } from './backend'
import { formatTimecode } from './timecode'

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

/** The mark became a replay (plan 181 S8): recording was off and the replay
 * buffer held the moment. Mirrors `clip_marks::REPLAY_SAVED_REASON`. */
export const CLIP_MARK_REPLAY_SAVED_REASON = 'replay-saved'

export function clipMarkBecameReplay(event: Pick<ClipMarkedEvent, 'saved' | 'reason'>): boolean {
  return !event.saved && event.reason === CLIP_MARK_REPLAY_SAVED_REASON
}

/**
 * The toast for a `clip.marked` event: where the mark landed, or why the
 * moment could not be kept. One copy for every window that shows it.
 * `streaming: false` is a recording that never went live: it has no stream
 * report, so the toast does not point at one.
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
  if (clipMarkBecameReplay(event)) {
    // The main window hears replay.saved itself; this is what another
    // window (the Stream Manager's Mark clip) shows for the same press.
    return {
      kind: 'success',
      title: 'Saving a replay instead',
      description: "Recording is off, so the replay buffer is saving this moment. It's in Library."
    }
  }
  return {
    kind: 'warning',
    title: "Recording is off, so this clip can't be saved.",
    description: 'Turn on Save local recording on the Output page.'
  }
}
