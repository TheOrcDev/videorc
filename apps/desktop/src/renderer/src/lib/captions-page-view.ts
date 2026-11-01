import type { CaptionsStatus, OverlayItemLayout, OverlayOrientation } from '@/lib/backend'
import { overlayRectBottomGravity } from '@/lib/overlay-layout'

// The Captions page and the Captions reader in words (plan 174 S3.7: D-25,
// D-27, V-5, J2-18). The state word and its tone are `captionsStatusLabel` /
// `captionsStatusTone` (S2.3a); these are the lines that go with them.

/** The Live captions switch's line while it is off: what turning it on does. */
export const CAPTIONS_OFF_HINT =
  'Transcribes your microphone during your next recording or livestream.'

/** The line under the captions state on the Captions page, while it is on. */
export function captionsStatusDetail(status: CaptionsStatus, sessionActive: boolean): string {
  switch (status.state) {
    case 'starting':
      return 'Connecting to transcription…'
    case 'listening':
    case 'live':
      return 'Your microphone is being transcribed.'
    case 'reconnecting':
      return 'Trying to restore live captions.'
    case 'degraded':
      return status.message ?? 'Captions are continuing in 3-second chunks.'
    case 'blocked':
      return status.message ?? 'Captions need attention before they can start.'
    case 'error':
      return status.message ?? 'Captions stopped unexpectedly.'
    case 'ready':
      return sessionActive
        ? 'Ready to listen to your microphone.'
        : 'Starts with your next recording or livestream.'
    default:
      return sessionActive
        ? 'Waiting for the caption service.'
        : 'Starts with your next recording or livestream.'
  }
}

/**
 * What the Captions reader's body says instead of, or above, the captions
 * (D-25, J2-18). A failure always shows with its reason, even over earlier
 * lines; every other state shows only while there is nothing to read. The
 * reader has no switch, so "off" is the backend's idle status without the
 * intent to caption.
 */
export function captionsReaderNotice(
  status: CaptionsStatus,
  lineCount: number
): { text: string; failed: boolean } | null {
  if (status.state === 'blocked') {
    return {
      text: status.message ?? 'Captions need attention before they can start. Open Captions.',
      failed: true
    }
  }
  if (status.state === 'error') {
    return {
      text: status.message ?? 'Captions stopped unexpectedly. Open Captions to try again.',
      failed: true
    }
  }
  if (lineCount > 0) return null
  switch (status.state) {
    case 'idle':
      return status.desiredEnabled === true
        ? { text: 'Captions show here when you record or go live.', failed: false }
        : {
            text: 'Live captions are off. Turn them on in Captions, then record or go live.',
            failed: false
          }
    case 'ready':
      return { text: 'Captions show here when you record or go live.', failed: false }
    case 'starting':
      return { text: 'Starting captions…', failed: false }
    case 'reconnecting':
      return { text: 'Reconnecting captions…', failed: false }
    case 'degraded':
      return {
        text: status.message ?? 'Captions are continuing in 3-second chunks.',
        failed: false
      }
    default:
      return { text: 'Listening…', failed: false }
  }
}

/**
 * Where the caption bar sits and what it shows on, for the Captions page's
 * Placement row (D-27): "Bottom, on stream". Scene owns both.
 */
export function captionsPlacementSummary(
  item: OverlayItemLayout,
  orientation: OverlayOrientation
): string {
  if (!item.showOnStream && !item.showInRecording) return 'Hidden'
  const edge = overlayRectBottomGravity(item[orientation]) ? 'Bottom' : 'Top'
  const where =
    item.showOnStream && item.showInRecording
      ? 'on stream and in the recording'
      : item.showOnStream
        ? 'on stream'
        : 'in the recording'
  return `${edge}, ${where}`
}

/** The month's caption allowance in one unit (D-27), or null until it is known. */
export function captionsAllowanceLabel(remainingSeconds: number | undefined): string | null {
  if (typeof remainingSeconds !== 'number' || !Number.isFinite(remainingSeconds)) return null
  return `${Math.max(0, Math.ceil(remainingSeconds / 60)).toLocaleString()} min left this month`
}
