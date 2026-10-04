import type { ClipMarkedEvent } from './backend'

/** Recording-file time as m:ss, or h:mm:ss from one hour (plan 068 D6). */
export function formatClipMarkClock(atSeconds: number): string {
  const total = Math.max(0, Math.floor(atSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mmss = `${hours > 0 ? String(minutes).padStart(2, '0') : minutes}:${String(seconds).padStart(2, '0')}`
  return hours > 0 ? `${hours}:${mmss}` : mmss
}

export interface ClipMarkedToast {
  kind: 'success' | 'warning'
  title: string
  description?: string
}

/** Where a saved mark shows up: the stream's report in the Orcle tab (plan 119 S3). */
export const CLIP_MARK_IN_REPORT = "It's in your stream report in Orcle."

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
  return {
    kind: 'warning',
    title: "Recording is off, so this clip can't be saved.",
    description: 'Turn on Record in the Studio to keep clips from a stream.'
  }
}
