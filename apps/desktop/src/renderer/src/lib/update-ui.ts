import type { UpdateStatus } from '@/lib/backend'

// Installing a downloaded update quits and relaunches Videorc, so it must never
// fire while a capture is live — never interrupt a recording. An update is
// installable only once it is fully downloaded AND nothing is recording or
// streaming.
export function isUpdateInstallable(status: UpdateStatus, captureActive: boolean): boolean {
  return status.phase === 'downloaded' && !captureActive
}

/**
 * Sidebar update chip content (post-0.9.4 fix batch F6): the chip renders
 * ONLY when an update is genuinely in flight or ready — never for idle,
 * up-to-date, error, or dev builds (those states live in Settings → About).
 * `install` becomes a jump to Settings while a capture is live (installing
 * quits the app).
 *
 * Plan 080 S1: the sidebar fits about 20 characters, so `label` never carries
 * the version ("Restart to update to 0.9.124" read "Restart to update t…").
 * `detail` is the full sentence for the tooltip and the accessible name.
 */
export function updateChip(
  status: UpdateStatus,
  captureActive: boolean
): { label: string; detail: string; action: 'install' | 'settings' } | null {
  switch (status.phase) {
    case 'available':
      return {
        label: 'Update available',
        detail: `Update ${status.version} available`,
        action: 'settings'
      }
    case 'downloading': {
      const percent = Math.round(status.percent)
      return {
        label: `Downloading… ${percent}%`,
        detail: status.version
          ? `Downloading update ${status.version}… ${percent}%`
          : `Downloading update… ${percent}%`,
        action: 'settings'
      }
    }
    case 'downloaded':
      return {
        label: 'Restart to update',
        detail: `Restart to update to ${status.version}`,
        action: captureActive ? 'settings' : 'install'
      }
    default:
      return null
  }
}
