import { osSettingsName } from '@/lib/platform'
import type { SystemAccessAction, SystemAccessRow, SystemAccessState } from '@/lib/system-access'

// Plan 174 S3.17 (I-10, A-16, V-11): how a system access row reads, in one
// place for both of its homes, the first-run dialog and Settings →
// Permissions. They used to disagree (a red icon beside an amber word, the
// detail on hover beside the detail in full, "Open settings" beside
// "Manage"). Kept out of system-access.ts, which the eager shell imports for
// the onboarding gate: only the two lazy surfaces read these words.

export type SystemAccessTone = 'good' | 'warn' | 'neutral'

/** One word and one tone per state, wherever the row appears. */
export function systemAccessStatus(state: SystemAccessState): {
  label: string
  tone: SystemAccessTone
} {
  switch (state) {
    case 'granted':
      return { label: 'Granted', tone: 'good' }
    case 'not-granted':
      return { label: 'Not granted', tone: 'warn' }
    case 'device-issue':
      return { label: 'Device issue', tone: 'warn' }
    case 'first-use':
      return { label: 'Not asked yet', tone: 'neutral' }
    case 'waiting':
      return { label: 'Waiting', tone: 'neutral' }
    case 'needs-relaunch':
      return { label: 'Reopen needed', tone: 'warn' }
    case 'not-required':
      return { label: 'Ready', tone: 'good' }
    case 'unavailable':
      return { label: 'Not available', tone: 'neutral' }
  }
}

/**
 * The row's button, named for where it goes: the OS's own prompt, or the
 * settings app by its name ("Open System Settings…"). None once nothing is
 * left to do.
 */
export function systemAccessActionLabel(
  action: SystemAccessAction,
  platform: string | undefined
): string | null {
  switch (action) {
    case 'request-media-access':
      return 'Allow…'
    case 'relaunch':
      return 'Reopen Videorc'
    case 'open-settings':
      return `Open ${osSettingsName(platform)}…`
    default:
      return null
  }
}

/**
 * The detail under the purpose: what to do or what went wrong. A granted row
 * needs none unless it names the camera (the chip already says granted).
 */
export function systemAccessVisibleDetail(row: SystemAccessRow): string | null {
  if (row.checking || !row.detail) return null
  return row.state === 'granted' && row.id !== 'camera' ? null : row.detail
}

/** The single primary always allows leaving setup. */
export function firstRunPrimary(rows: readonly SystemAccessRow[]): {
  label: 'Continue' | 'Skip for now'
  completion: 'done' | 'skipped'
} {
  return rows.every(
    (row) => !row.required || row.state === 'granted' || row.state === 'not-required'
  )
    ? { label: 'Continue', completion: 'done' }
    : { label: 'Skip for now', completion: 'skipped' }
}

export function systemAccessTag(row: SystemAccessRow): 'Needed to record' | 'Optional' | null {
  return row.required ? 'Needed to record' : row.id === 'camera' ? 'Optional' : null
}
