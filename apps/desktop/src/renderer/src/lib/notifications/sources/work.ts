// Plan 250 S7: work that finishes out of view. An MP4 export is one entry
// that runs, then is done or failed; a clean cut, a cloud download and a
// clip are entries with the button their toast had. Idle, a finished one
// also shows for a few seconds; nothing is pinned.

import type { ReplaySavedEvent, ReplaySaveFailedEvent } from '@/lib/backend'
import { notifications } from '@/lib/notifications'
import type { NotificationStore } from '@/lib/notifications/store'
import type { NotificationAction } from '@/lib/notifications/types'
import { revealInFileManagerLabel } from '@/lib/platform'
import { openOutputClips } from '@/lib/section-doors'
import { exportSpaceRefusal } from '@/lib/user-error'

function reveal(sessionId: string): NotificationAction {
  return {
    id: 'reveal',
    label: revealInFileManagerLabel(),
    kind: 'fix',
    run: () => void window.videorc?.revealSession(sessionId)
  }
}

// --- MP4 export -------------------------------------------------------------

export function mp4Key(sessionId: string): string {
  return `mp4:${sessionId}`
}

/** The export's progress line ("Saving MP4 42%"): an entry with a spinner, no toast. */
export function publishMp4Finalizing(
  sessionId: string,
  label: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: mp4Key(sessionId),
    kind: 'mp4',
    state: 'running',
    title: label,
    detail: 'Your recording is safe. Long recordings can take several minutes to save as MP4.'
  })
}

export function publishMp4Ready(sessionId: string, store: NotificationStore = notifications): void {
  store.publish({
    key: mp4Key(sessionId),
    kind: 'mp4',
    state: 'done',
    title: 'MP4 ready',
    actions: [reveal(sessionId)]
  })
}

export function publishMp4ExportFailed(
  sessionId: string,
  retry: () => void,
  reason: string | undefined,
  store: NotificationStore = notifications
): void {
  if (reason) console.warn('[finalization] MP4 export failed:', reason)
  store.publish({
    key: mp4Key(sessionId),
    kind: 'mp4',
    state: 'failed',
    title: 'MP4 export failed',
    // A refusal for want of disk space says how much and what to do; any
    // other reason stays in the console.
    detail: exportSpaceRefusal(reason) ?? 'Your original recording is safe.',
    actions: [{ id: 'retry', label: 'Retry export', kind: 'fix', run: retry }]
  })
}

// --- Clean cut and cloud recordings -----------------------------------------

export function publishCleanCutReady(
  job: { id: string; title: string },
  review: () => void,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `clean-cut:${job.id}`,
    kind: 'work-done',
    title: job.title,
    detail: 'The original is kept.',
    actions: [{ id: 'review', label: 'Review', kind: 'door', run: review }],
    once: true
  })
}

/** Quiet on purpose: nothing retries by itself, and Clean cut has Make and Retry. */
export function publishCleanCutAutoFailed(
  sessionId: string,
  reason: string,
  open: () => void,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `clean-cut-auto:${sessionId}`,
    kind: 'work-failed',
    title: "Your clean cut didn't start",
    detail: reason,
    actions: [{ id: 'open-clean-cut', label: 'Open Clean cut', kind: 'door', run: open }],
    once: true
  })
}

export function cloudDownloadKey(recordingId: string): string {
  return `cloud-download:${recordingId}`
}

export function publishCloudDownloadSaved(
  recordingId: string,
  revealDownload: () => void,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: cloudDownloadKey(recordingId),
    kind: 'work-done',
    title: 'Cloud recording saved',
    actions: [{ id: 'reveal', label: revealInFileManagerLabel(), kind: 'fix', run: revealDownload }]
  })
}

export function publishCloudDownloadFailed(
  recordingId: string,
  words: { title: string; description?: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: cloudDownloadKey(recordingId),
    kind: 'work-failed',
    title: words.title,
    detail: words.description
  })
}

// --- Clips ------------------------------------------------------------------

/** "0:30": how much the clip holds. */
export function publishClipSaved(
  event: Pick<ReplaySavedEvent, 'saveId' | 'replaySessionId' | 'complete'>,
  held: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `clip:${event.saveId}`,
    kind: 'clip',
    title: 'Clip saved',
    detail: event.complete ? `Last ${held}.` : `Last ${held}, the buffer was still filling.`,
    actions: [reveal(event.replaySessionId)]
  })
}

export function publishClipSaveFailed(
  event: Pick<ReplaySaveFailedEvent, 'saveId' | 'message'>,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `clip:${event.saveId}`,
    kind: 'clip-failed',
    title: "Couldn't save the clip",
    detail: event.message
  })
}

export const CLIPS_KEY = 'clips'

const OPEN_CLIPS: NotificationAction = {
  id: 'open-output',
  label: 'Open Output',
  kind: 'door',
  run: openOutputClips
}

/** The ring ended with its session, not by the switch. */
export function publishClipsStopped(
  detail: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: CLIPS_KEY,
    kind: 'clips',
    title: 'Clips stopped',
    detail,
    actions: [OPEN_CLIPS]
  })
}

export function publishClipsCouldNotStart(
  reason: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: CLIPS_KEY,
    kind: 'clips',
    title: "Clips couldn't start",
    detail: reason,
    actions: [OPEN_CLIPS]
  })
}

/** The ring is keeping the last seconds again. */
export function resolveClips(store: NotificationStore = notifications): void {
  store.resolve(CLIPS_KEY, { title: 'Clips are on again', was: 'They were off' })
}
