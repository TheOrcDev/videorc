import type { VideoSettings } from './backend'
import { formatVideoQuality } from './format-video'

type Video = Pick<VideoSettings, 'width' | 'height' | 'fps'> & Partial<VideoSettings>

/**
 * Studio → Session → Output (release test 146, plan 0004). Off-air it is the
 * saved recording quality. On air it is what the session actually encodes:
 * when this computer can't run a separate recording encode the recording
 * takes the stream's profile (the Go Live sheet's "Recording will match the
 * stream"), and a stream-only session shows the stream's quality.
 */
export function sessionOutputSummary({
  live,
  recordEnabled,
  saved,
  sharedFallback,
  streamVideo = null
}: {
  live: boolean
  recordEnabled: boolean
  saved: Video
  sharedFallback: Video | null
  streamVideo?: Video | null
}): string {
  if (!live) return formatVideoQuality(saved)
  if (recordEnabled) {
    return sharedFallback
      ? `${formatVideoQuality(sharedFallback)} · matches the stream`
      : formatVideoQuality(saved)
  }
  return formatVideoQuality(sharedFallback ?? streamVideo ?? saved)
}
