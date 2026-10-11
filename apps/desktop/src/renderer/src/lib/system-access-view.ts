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
      return { label: 'Checked on first use', tone: 'neutral' }
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
      return 'Allow access…'
    case 'open-settings':
      return `Open ${osSettingsName(platform)}…`
    default:
      return null
  }
}

/**
 * The detail under the purpose: what to do or what went wrong. A granted row
 * needs none (its chip already says so).
 */
export function systemAccessVisibleDetail(row: SystemAccessRow): string | null {
  return row.state === 'granted' ? null : row.detail
}

/**
 * The first-run dialog's primary button (V-11): "Continue" unless the OS
 * refused a grant. A permission the OS asks for on first use is not missing.
 */
export function permissionsOnboardingContinueLabel(
  rows: readonly SystemAccessRow[]
): 'Continue' | 'Skip for now' {
  return rows.some((row) => row.state === 'not-granted') ? 'Skip for now' : 'Continue'
}
