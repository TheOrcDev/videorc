import type { UpdateStatus } from '@/lib/backend'

// Installing a downloaded update quits and relaunches Videorc, so it must never
// fire while a capture is live — never interrupt a recording. An update is
// installable only once it is fully downloaded AND nothing is recording or
// streaming.
export function isUpdateInstallable(status: UpdateStatus, captureActive: boolean): boolean {
  return status.phase === 'downloaded' && !captureActive
}

export interface UpdateChip {
  label: string
  detail: string
  action: 'install' | 'settings'
  /** `good` only when a click installs; a chip that only navigates stays neutral (plan 174 A-25). */
  tone: 'good' | 'neutral'
}

/**
 * Sidebar update chip content (post-0.9.4 fix batch F6): the chip renders
 * ONLY when an update is genuinely in flight or ready — never for idle,
 * up-to-date, error, or dev builds (those states live in Settings → About).
 * `install` becomes a jump to Settings while a capture is live (installing
 * quits the app), and the chip says so: "Update after stop" (plan 174 A-25).
 *
 * Plan 080 S1: the sidebar fits about 20 characters, so `label` never carries
 * the version ("Restart to update to 0.9.124" read "Restart to update t…").
 * `detail` is the full sentence for the tooltip and the description.
 */
export function updateChip(status: UpdateStatus, captureActive: boolean): UpdateChip | null {
  switch (status.phase) {
    case 'available':
      return {
        label: 'Update available',
        detail: `Update ${status.version} available`,
        action: 'settings',
        tone: 'neutral'
      }
    // Linux: a newer release is on videorc.com; Settings → About links to it.
    case 'download-available':
      return {
        label: 'Update available',
        detail: `Videorc ${status.version} is available on videorc.com`,
        action: 'settings',
        tone: 'neutral'
      }
    case 'downloading': {
      const percent = Math.round(status.percent)
      return {
        label: `Downloading… ${percent}%`,
        detail: status.version
          ? `Downloading update ${status.version}… ${percent}%`
          : `Downloading update… ${percent}%`,
        action: 'settings',
        tone: 'neutral'
      }
    }
    case 'downloaded':
      if (captureActive) {
        return {
          label: 'Update after stop',
          detail: `Restart to update to ${status.version} once you stop recording or end the livestream.`,
          action: 'settings',
          tone: 'neutral'
        }
      }
      return {
        label: 'Restart to update',
        detail: `Restart to update to ${status.version}`,
        action: 'install',
        tone: 'good'
      }
    default:
      return null
  }
}
