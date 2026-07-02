import type { CaptionsUpdate } from '@/lib/backend'

/** Lines kept for the captions strip / detached window. */
export const MAX_CAPTION_LINES = 50

/**
 * Append a caption update: drops duplicate/out-of-order chunks from the same
 * session (the backend retries can re-emit a seq) and resets the buffer when a
 * new caption session starts. Newest line last; capped to MAX_CAPTION_LINES.
 */
export function appendCaptionLine(
  lines: CaptionsUpdate[],
  update: CaptionsUpdate,
  max = MAX_CAPTION_LINES
): CaptionsUpdate[] {
  if (!update.text.trim()) {
    return lines
  }
  const last = lines.at(-1)
  if (last && last.sessionClientId !== update.sessionClientId) {
    return [update]
  }
  if (last && update.seq <= last.seq) {
    return lines
  }
  return [...lines, update].slice(-max)
}

/** The strip shows the tail of the transcript, most recent lines only. */
export function captionStripLines(lines: CaptionsUpdate[], count = 3): CaptionsUpdate[] {
  return lines.slice(-count)
}
