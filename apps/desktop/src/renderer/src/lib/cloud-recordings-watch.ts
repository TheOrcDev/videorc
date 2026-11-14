import type { CloudRecordingStatus } from '@/lib/backend'
import type { CloudRecordingStop } from '@/lib/cloud-recordings-view'

// Plan 234: "a cloud recording just stopped", for the Library's Cloud
// recordings section to wait for its row. The talk show's room host (lazy,
// mounted under the Studio provider) reports every `cloudStatus.recording`
// here; the Library section reads the last stop. Both are lazy chunks, so
// this module never reaches the eager bundle.

let activeSinceMs: number | null = null
let lastStop: CloudRecordingStop | null = null
const listeners = new Set<() => void>()

/** The room host's report: the cloud recording as `cloud.state` has it now. */
export function noteCloudRecording(
  status: Pick<CloudRecordingStatus, 'active' | 'since'> | null | undefined,
  nowMs = Date.now()
): void {
  if (status?.active) {
    const since = status.since ? Date.parse(status.since) : Number.NaN
    activeSinceMs = Number.isFinite(since) ? since : (activeSinceMs ?? nowMs)
    return
  }
  if (activeSinceMs === null) return
  lastStop = { sinceMs: activeSinceMs, stoppedAtMs: nowMs }
  activeSinceMs = null
  for (const listener of listeners) listener()
}

/** The last cloud recording that stopped while this window watched, if any. */
export function lastCloudRecordingStop(): CloudRecordingStop | null {
  return lastStop
}

export function subscribeCloudRecordingStop(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tests only. */
export function resetCloudRecordingWatch(): void {
  activeSinceMs = null
  lastStop = null
  listeners.clear()
}
