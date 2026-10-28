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
  | { type: 'download-available'; version: string }
  | { type: 'unsupported'; reason?: 'windows-feed-unpublished' | 'linux-version-unknown' }

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
    case 'download-available':
      return { phase: 'download-available', version: event.version }
    case 'unsupported':
      return event.reason
        ? { phase: 'unsupported', reason: event.reason }
        : { phase: 'unsupported' }
  }
}

// electron-updater resolves a check with null, and emits no event, when it is
// inactive: an AppImage run without the APPIMAGE variable (extracted, or
// repackaged by a distro) or a snap. Nothing then moves the status off
// 'checking', so Settings said "Checking for updates…" forever. A check that
// resolved while still 'checking' settles as unsupported.
export function settleStatusAfterCheck(status: UpdateStatus): UpdateStatus {
  return status.phase === 'checking' ? updateStatusFromEvent({ type: 'unsupported' }) : status
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
// never when updates are unsupported — except a Windows build whose feed is not
// published yet: signing in or a public Alpha can open one at any time, and the
// check is one small yml fetch — and Linux, whose notice check keeps watching
// for the next release (or for videorc.com to answer at all). 'available' with
// no download running means the background download failed — re-checking
// retries it.
export function shouldBackgroundRecheck(status: UpdateStatus): boolean {
  switch (status.phase) {
    case 'idle':
    case 'not-available':
    case 'error':
    case 'available':
    case 'download-available':
      return true
    case 'checking':
    case 'downloading':
    case 'downloaded':
      return false
    case 'unsupported':
      return (
        status.reason === 'windows-feed-unpublished' || status.reason === 'linux-version-unknown'
      )
  }
}

/**
 * The OS notice that a downloaded update is ready (plan 174 I-20): never while
 * Videorc records or is on air, where a system banner can land on the
 * captured screen. The sidebar chip and Settings → About still say it, and
 * the update installs the next time Videorc quits either way.
 */
export function updateReadyNotification(
  version: string,
  captureActive: boolean
): { title: string; body: string } | null {
  if (captureActive) return null
  return {
    title: `Videorc ${version} is ready`,
    body: 'Restart Videorc to finish updating, or it installs the next time you quit.'
  }
}
