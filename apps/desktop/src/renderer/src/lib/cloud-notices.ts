import type { BackendClient } from '@/backendClient'

import type { CloudStatus } from './backend'
import { CLOUD_TOAST_ID, formatCloudCountdown } from './cloud-toasts'
import { requestCloudSectionFocus } from './cloud-section-focus'
import { toast } from './toast'
import { openWorkspaceTab } from './workspace-navigation'

// Videorc Cloud's rarer notices (plan 222 U1, U5): the once-per-account
// "Videorc Cloud is on" and the once-per-show "past this month's cloud
// hours". The Studio provider imports this module only when one is due, so
// none of it rides in the eager bundle (the renderer asset budget). The
// focus request it makes lives in `cloud-section-focus.ts`, which the
// Livestream section imports without this module's app-wide imports.

/**
 * Plan 222 U5 (plan 184 D18): once per show, when it first runs past the
 * month's cloud hours. Nothing happens to the show; the next Go Live's own
 * fallback says the rest.
 */
export function cloudAllowancePastToast(
  previous: CloudStatus | null,
  next: CloudStatus
): { title: string; description: string } | null {
  const past = next.allowancePast?.seconds
  const showId = next.show?.id
  if (!showId || past === undefined) return null
  if (previous?.show?.id === showId && previous.allowancePast) return null
  return {
    title: `You're ${formatCloudCountdown(past)} past this month's cloud hours`,
    description: 'The show keeps going.'
  }
}

/** Plan 222 U1: the once-per-account notice, with "Open Livestream". */
export const CLOUD_ANNOUNCE_TOAST = {
  title: 'Videorc Cloud is on',
  description: 'Your stream stays on air if this computer drops. Set it up in Livestream.'
} as const

/** U5: the provider hands every status that runs past the hours here. */
export function toastCloudAllowancePast(previous: CloudStatus | null, next: CloudStatus): void {
  const past = cloudAllowancePastToast(previous, next)
  if (past) toast.info(past.title, { id: CLOUD_TOAST_ID, description: past.description })
}

/**
 * U1: show "Videorc Cloud is on" and tell the backend it showed, so this
 * account never sees it again on this computer. The provider calls it once,
 * outside a session.
 */
export function announceCloud(client: BackendClient, commit: (status: CloudStatus) => void): void {
  toast.info(CLOUD_ANNOUNCE_TOAST.title, {
    id: CLOUD_TOAST_ID,
    description: CLOUD_ANNOUNCE_TOAST.description,
    action: {
      label: 'Open Livestream',
      onClick: () => {
        requestCloudSectionFocus()
        openWorkspaceTab('live', 'setup')
      }
    }
  })
  void client
    .requestTyped('cloud.announce.seen')
    .then(commit)
    .catch(() => {
      // Shown once in this run either way; the next launch asks again.
    })
}
