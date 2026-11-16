import type { CloudRecordingDownloadEvent, CloudRecordingItem } from '@/lib/backend'

// Plan 234: the Library's "Cloud recordings" section, as pure functions. The
// section (components/library/cloud-recordings-section.tsx) and this module
// load only with the Library page; nothing here is in the eager bundle.

/** `format: "segments"`: a managed recording this computer makes into an MP4. */
export function downloadsOnThisComputer(recording: CloudRecordingItem): boolean {
  return recording.format === 'segments'
}

/** Newest first, by when the take started; an unreadable time sorts last. */
export function sortCloudRecordings(
  recordings: readonly CloudRecordingItem[]
): CloudRecordingItem[] {
  const at = (recording: CloudRecordingItem): number => {
    const ms = Date.parse(recording.startedAt)
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
  }
  return [...recordings].sort((a, b) => at(b) - at(a))
}

/** The web's `h` and `v`, in words. */
export function cloudOrientationLabel(orientation: string): string {
  return orientation === 'v' ? 'Vertical' : 'Horizontal'
}

/** A download as the row shows it. A cancelled one is gone: the row is ready again. */
export type CloudDownloadView =
  | { state: 'starting' }
  | { state: 'running'; jobId: string; done?: number; total?: number }
  | { state: 'done'; jobId: string; localSessionId?: string }
  | { state: 'failed'; jobId?: string }

export type CloudDownloads = ReadonlyMap<string, CloudDownloadView>

/** Pure: the downloads after one `cloud.recordings.download` event. */
export function reduceCloudDownload(
  downloads: CloudDownloads,
  event: CloudRecordingDownloadEvent
): CloudDownloads {
  const next = new Map(downloads)
  switch (event.state) {
    case 'running':
      next.set(event.recordingId, {
        state: 'running',
        jobId: event.jobId,
        ...(event.doneSegments !== undefined ? { done: event.doneSegments } : {}),
        ...(event.totalSegments !== undefined ? { total: event.totalSegments } : {})
      })
      break
    case 'done':
      next.set(event.recordingId, {
        state: 'done',
        jobId: event.jobId,
        ...(event.localSessionId ? { localSessionId: event.localSessionId } : {})
      })
      break
    case 'failed':
      next.set(event.recordingId, { state: 'failed', jobId: event.jobId })
      break
    case 'cancelled':
      next.delete(event.recordingId)
      break
  }
  return next
}

/** How far a running download is, 0 to 100, or null before its total is known. */
export function cloudDownloadPercent(view: CloudDownloadView): number | null {
  if (view.state !== 'running' || !view.total || view.total <= 0) return null
  const done = Math.min(view.done ?? 0, view.total)
  return Math.floor((done / view.total) * 100)
}

// The backend's own sentences for a download that failed or was refused
// (cloud_control_web.rs). They read as copy, so the toast shows them as they
// are; anything else (FFmpeg's lines, a transport error) gets the generic
// next step and goes to the console only.
const KNOWN_DOWNLOAD_REFUSALS = [
  /^Sign in to (?:see|download) your cloud recordings\.$/,
  /^That recording is not in your account any more\.$/,
  /^The cloud recording has expired\.$/,
  /^The recording artifact is no longer available\.$/,
  /^This recording downloads from your account on videorc\.com\.$/,
  /^There isn't enough space to save the recording\.$/,
  /^The recording could not be saved\. Check the folder and available space\.$/,
  /^Videorc can't save to [^\n]{1,512}\.$/,
  /^videorc\.com did not answer with the recording's playlist\.$/,
  /^The recording's playlist (?:is not supported|has no segments)\.$/,
  /^The recording download stopped\. Try again\.$/
]

/** A segment's number means nothing to a streamer: said plainly instead. */
const SEGMENT_FAILED = /^Recording segment \d+ could not be downloaded\.$/
const SEGMENT_FAILED_TEXT = "Part of the recording didn't download. Try again."

/** The backend's sentence when it is one of its own, else null. */
export function knownCloudDownloadRefusal(raw: string | undefined): string | null {
  const text = raw?.trim()
  if (text && SEGMENT_FAILED.test(text)) return SEGMENT_FAILED_TEXT
  return text && KNOWN_DOWNLOAD_REFUSALS.some((pattern) => pattern.test(text)) ? text : null
}

/** After Stop recording, the list is asked every 5 s for up to 2 minutes. */
export const CLOUD_RECORDING_POLL_MS = 5_000
export const CLOUD_RECORDING_POLL_WINDOW_MS = 120_000
/** The web's clock and this computer's may differ by this much. */
const START_SLOP_MS = 60_000

/** A cloud recording that stopped on this computer: when it started and stopped. */
export type CloudRecordingStop = { sinceMs: number; stoppedAtMs: number }

/**
 * Whether the list still waits for the take that `stop` ended. `listedAtStop`
 * holds the ids the list showed when the take stopped: a take from a minute
 * before, inside the allowance and listed already, is not this one.
 */
export function awaitingCloudRecording(
  stop: CloudRecordingStop | null,
  recordings: readonly CloudRecordingItem[] | null,
  nowMs: number,
  listedAtStop?: ReadonlySet<string>
): boolean {
  if (!stop || nowMs - stop.stoppedAtMs >= CLOUD_RECORDING_POLL_WINDOW_MS) return false
  if (!recordings) return true
  return !recordings.some((recording) => {
    if (listedAtStop?.has(recording.id)) return false
    const started = Date.parse(recording.startedAt)
    return Number.isFinite(started) && started >= stop.sinceMs - START_SLOP_MS
  })
}

/** No local file is inferred from a completed cloud take or an old job. */
export function cloudRecordingAvailability(
  recording: CloudRecordingItem,
  now = Date.now()
): 'available' | 'expired' | 'missing' {
  if (recording.availability === 'missing') return 'missing'
  const expires = Date.parse(recording.expiresAt)
  return recording.availability === 'expired' || (Number.isFinite(expires) && expires <= now)
    ? 'expired'
    : 'available'
}
export function cloudTakeLabel(recording: CloudRecordingItem): string {
  const count = recording.liveIntervalIds?.length
  return !recording.associationKnown || count === undefined
    ? 'Cloud take'
    : count === 0
      ? 'Record-only take'
      : `Take · ${count} live ${count === 1 ? 'interval' : 'intervals'}`
}
