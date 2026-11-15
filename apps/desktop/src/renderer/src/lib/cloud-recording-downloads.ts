import type { BackendClient } from '@/backendClient'
import type { CloudRecordingDownloadEvent } from '@/lib/backend'
import {
  knownCloudDownloadRefusal,
  reduceCloudDownload,
  type CloudDownloads
} from '@/lib/cloud-recordings-view'
import { revealInFileManagerLabel } from '@/lib/platform'
import { toast } from '@/lib/toast'
import { toastUserError, UserFacingError } from '@/lib/user-error'

// Plan 234: the Library's cloud downloads. A download is a backend job
// (`cloud.recordings.download` → `{ jobId }`, then `cloud.recordings.download`
// events), so it carries on when the Library closes. This module keeps what
// the rows show for the life of the window: it loads with the Library's Cloud
// recordings section and stays subscribed from then on, so the rows find
// their progress again when the Library opens next.

let downloads: CloudDownloads = new Map()
const revisions = new Map<string, number>()
let snapshotGeneration = 0
const listeners = new Set<() => void>()
let attached: { client: BackendClient; off: () => void } | null = null
/** Open Cloud recordings sections: while one is open, the row is the news. */
let openViews = 0

function publish(next: CloudDownloads): void {
  downloads = next
  for (const listener of listeners) listener()
}

export function cloudDownloads(): CloudDownloads {
  return downloads
}

export function subscribeCloudDownloads(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** One section on screen; call the result when it closes. */
export function holdCloudDownloadsView(): () => void {
  openViews += 1
  let released = false
  return () => {
    if (released) return
    released = true
    openViews -= 1
  }
}

const TOAST_ID = (recordingId: string): string => `cloud-download:${recordingId}`
const CONTEXT = { action: 'download', object: 'the cloud recording' } as const

/** Show in Finder for a finished download: main resolves the job's file. */
export function revealCloudDownload(jobId: string): void {
  void window.videorc?.revealCloudDownload?.(jobId).catch((error: unknown) => {
    toastUserError(error, { action: 'show', object: 'the recording' })
  })
}

function announce(event: CloudRecordingDownloadEvent): void {
  if (event.state === 'failed') {
    // It failed and needs the streamer, whether or not the row is in view.
    // Raw text (FFmpeg's lines) reaches only the console and the support ring.
    const known = knownCloudDownloadRefusal(event.error)
    toastUserError(known ? new UserFacingError(known) : new Error(event.error ?? ''), CONTEXT, {
      id: TOAST_ID(event.recordingId)
    })
    return
  }
  // A download that finishes out of view is news; in view, the row says it.
  if (event.state === 'done' && openViews === 0) {
    toast.success('Cloud recording saved', {
      id: TOAST_ID(event.recordingId),
      action: { label: revealInFileManagerLabel(), onClick: () => revealCloudDownload(event.jobId) }
    })
  }
}

/** Subscribe to the job events once per backend connection, before any start. */
export function attachCloudDownloads(client: BackendClient | null): void {
  if (!client || attached?.client === client) return
  attached?.off()
  const reconcile = async (): Promise<void> => {
    const generation = ++snapshotGeneration
    const before = new Map(revisions)
    try {
      const jobs = await client.requestTyped('cloud.recordings.downloads', undefined)
      if (attached?.client !== client || generation !== snapshotGeneration) return
      let next = new Map(downloads)
      const unchanged = (id: string): boolean => (revisions.get(id) ?? 0) === (before.get(id) ?? 0)
      for (const [id, view] of next) {
        if (
          view.state === 'running' &&
          unchanged(id) &&
          !jobs.some((job) => job.recordingId === id && job.jobId === view.jobId)
        )
          next.delete(id)
      }
      for (const event of jobs)
        if (unchanged(event.recordingId)) next = new Map(reduceCloudDownload(next, event))
      publish(next)
    } catch {
      /* The next ready/lagged event or Cancel retries reconciliation. */
    }
  }
  const off = client.on('cloud.recordings.download', (event) => {
    revisions.set(event.recordingId, (revisions.get(event.recordingId) ?? 0) + 1)
    publish(reduceCloudDownload(downloads, event))
    announce(event)
  })
  const ready = client.on('backend.ready', () => {
    void reconcile()
  })
  const lagged = client.on('events.lagged', () => {
    void reconcile()
  })
  attached = {
    client,
    off: () => {
      off()
      ready()
      lagged()
    }
  }
  void reconcile()
}

/**
 * Download: the job starts at once and its events move the row. A second
 * press for the same recording answers the running job (the backend's rule).
 * `outputDirectoryCapability` is Output's folder as main issued it; without
 * it the backend saves to the default folder.
 */
export async function startCloudDownload(
  client: BackendClient,
  recordingId: string,
  outputDirectoryCapability?: string
): Promise<void> {
  attachCloudDownloads(client)
  revisions.set(recordingId, (revisions.get(recordingId) ?? 0) + 1)
  publish(new Map(downloads).set(recordingId, { state: 'starting' }))
  try {
    const { jobId } = await client.requestTyped('cloud.recordings.download', {
      id: recordingId,
      ...(outputDirectoryCapability ? { outputDirectoryCapability } : {})
    })
    revisions.set(recordingId, (revisions.get(recordingId) ?? 0) + 1)
    // An event may have come first (running, or already done): it wins.
    if (downloads.get(recordingId)?.state === 'starting') {
      publish(new Map(downloads).set(recordingId, { state: 'running', jobId }))
    }
  } catch (error) {
    revisions.set(recordingId, (revisions.get(recordingId) ?? 0) + 1)
    publish(new Map(downloads).set(recordingId, { state: 'failed' }))
    const known = knownCloudDownloadRefusal(error instanceof Error ? error.message : undefined)
    toastUserError(known ? new UserFacingError(known) : error, CONTEXT, {
      id: TOAST_ID(recordingId)
    })
  }
}

/** Cancel: the job's `cancelled` event takes the row back to Download. */
export async function cancelCloudDownload(client: BackendClient, jobId: string): Promise<void> {
  try {
    await client.requestTyped('cloud.recordings.cancelDownload', { jobId })
    attached?.off()
    attached = null
    attachCloudDownloads(client)
  } catch (error) {
    toastUserError(error, { action: 'cancel', object: 'the download' })
  }
}

/** Marks a failed start whose reason the section already told (tests too). */
export function failCloudDownload(recordingId: string): void {
  publish(new Map(downloads).set(recordingId, { state: 'failed' }))
}

/** Tests only. */
export function resetCloudDownloads(): void {
  attached?.off()
  attached = null
  downloads = new Map()
  revisions.clear()
  snapshotGeneration += 1
  listeners.clear()
  openViews = 0
}
