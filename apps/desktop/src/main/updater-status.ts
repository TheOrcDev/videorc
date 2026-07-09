import type { UpdateStatus } from '../shared/backend'

// Pure mapping from electron-updater lifecycle events to the UpdateStatus the
// renderer consumes. Kept electron-free so it is unit-testable (the desktop test
// runner is node-only, no electron). updater.ts wires the real autoUpdater
// events to these helpers.

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; currentVersion: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'unsupported' }

// electron-updater surfaces an unpublished feed — no `latest*.yml` for this
// build's platform/channel — as a 404 / "Cannot find channel" error. That is
// not a failure the user can act on: it means no update channel is published
// for this build yet (e.g. a Windows build before its release feed goes live).
// Classify it so the updater can degrade to the benign 'unsupported' state
// instead of showing an alarming "Couldn't check for updates: … 404" message.
// Once the feed publishes, the same check resolves to available/not-available
// with no code change.
export function isMissingUpdateFeedError(message: string): boolean {
  const normalized = message.toLowerCase()
  if (normalized.includes('cannot find channel')) {
    return true
  }
  // A 404 specifically on the update-info manifest (latest.yml / latest-mac.yml
  // / latest-linux.yml), not an unrelated 404 mid-download.
  return (
    normalized.includes('404') &&
    (normalized.includes('latest.yml') ||
      normalized.includes('latest-mac.yml') ||
      normalized.includes('latest-linux.yml') ||
      normalized.includes('update info'))
  )
}

// electron-updater can report a percent slightly outside 0–100 (or NaN before the
// first chunk); normalise it so the progress bar never overflows.
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round(percent)))
}

export function updateStatusFromEvent(event: UpdaterEvent): UpdateStatus {
  switch (event.type) {
    case 'checking':
      return { phase: 'checking' }
    case 'available':
      return { phase: 'available', version: event.version }
    case 'not-available':
      return { phase: 'not-available', currentVersion: event.currentVersion }
    case 'progress':
      return { phase: 'downloading', percent: clampPercent(event.percent) }
    case 'downloaded':
      return { phase: 'downloaded', version: event.version }
    case 'error':
      return { phase: 'error', message: event.message }
    case 'unsupported':
      return { phase: 'unsupported' }
  }
}

// After a manual check resolves, start downloading immediately (one-click feel)
// only when an update is actually available.
export function shouldAutoDownload(status: UpdateStatus): boolean {
  return status.phase === 'available'
}

// The launch-time check alone misses every release shipped while the app stays
// open (the 0.9.12-era "no update chip" report), so the background flow
// re-checks on this interval. The feed is one small yml fetch (max-age=60).
export const BACKGROUND_RECHECK_INTERVAL_MS = 30 * 60 * 1000

// Re-check only from settled states: never while a check or download is in
// flight, never once an update is staged (it applies on the next quit), and
// never when updates are unsupported. 'available' with no download running
// means the background download failed — re-checking retries it.
export function shouldBackgroundRecheck(status: UpdateStatus): boolean {
  switch (status.phase) {
    case 'idle':
    case 'not-available':
    case 'error':
    case 'available':
      return true
    case 'checking':
    case 'downloading':
    case 'downloaded':
    case 'unsupported':
      return false
  }
}
