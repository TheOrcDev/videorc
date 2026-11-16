import type { BackendClient } from '@/backendClient'

import type { AppExitKind, CloudSettingsPatch, CloudStatus, CloudTestOutput } from './backend'
import {
  CLOUD_TOAST_ID,
  cloudFallbackToast,
  cloudLostToast,
  cloudRestartToast,
  cloudShowCapToast,
  formatCloudCountdown
} from './cloud-toasts'
import { cloudTakenOverTitle } from './cloud-handoff-view'
import { requestCloudSectionFocus } from './cloud-section-focus'
import { toast } from './toast'
import { offlineError, toastUserError } from './user-error'
import { openWorkspaceTab } from './workspace-navigation'

// Videorc Cloud's notices and user actions: loaded with the first cloud
// status or action, so the dispatch for plan 234's managed-show cap and
// quality fallback stays beside its copy, outside the eager provider. The
// focus request lives in `cloud-section-focus.ts`, which the Livestream
// section imports without this module's app-wide imports.

/** The provider's status notifications, in their shared toast's priority order. */
export function toastCloudStatus(previous: CloudStatus | null, next: CloudStatus): void {
  const fallback = cloudFallbackToast(previous, next)
  if (fallback) toast.warning(fallback, { id: CLOUD_TOAST_ID })
  const lost = cloudLostToast(previous, next)
  if (lost) toast.warning(lost, { id: CLOUD_TOAST_ID })
  const restarted = cloudRestartToast(previous, next)
  if (restarted) toast.warning(restarted, { id: CLOUD_TOAST_ID })
  const cap = cloudShowCapToast(previous, next)
  if (cap) toast.warning(cap, { id: CLOUD_TOAST_ID })
  // Plan 222 U5: past the month's hours is news, never a cut (D18).
  if (next.allowancePast) toastCloudAllowancePast(previous, next)
  // Plan 243 C5: another device continued the show and this computer
  // stopped. Neutral news: the Studio's notice offers Continue here.
  if (next.stoppedBy === 'taken-over' && previous?.stoppedBy !== 'taken-over') {
    toast.info(cloudTakenOverTitle(next.onAir), { id: CLOUD_TOAST_ID })
  }
}

type CommitCloudStatus = (status: CloudStatus) => void

export async function setCloudSettings(
  client: BackendClient,
  patch: CloudSettingsPatch,
  commit: CommitCloudStatus
): Promise<void> {
  try {
    commit(await client.requestTyped('cloud.settings.set', patch))
  } catch (error) {
    toastUserError(
      error,
      { action: 'save', object: 'the Videorc Cloud setting' },
      { id: CLOUD_TOAST_ID }
    )
  }
}

export async function refreshCloudAllowance(
  client: BackendClient,
  commit: CommitCloudStatus
): Promise<void> {
  try {
    commit(await client.requestTyped('cloud.allowance.refresh'))
  } catch {
    // The section keeps the hours it last had; signed out says so itself.
  }
}

export async function endCloudShow(
  client: BackendClient,
  commit: CommitCloudStatus
): Promise<void> {
  try {
    commit(await client.requestTyped('cloud.show.end'))
  } catch (error) {
    toastUserError(
      error,
      { action: 'end', object: 'the stream on Videorc Cloud' },
      { id: CLOUD_TOAST_ID }
    )
  }
}

/**
 * Plan 243 C5: the hand-off. The backend stops feeding through the hand-off
 * stop (D7) and the show waits for another device; then a leaving app goes.
 * A refusal says why, keeps the app, and lets the provider give the session
 * its broadcasts back when it is still fed.
 */
export async function handOffCloudShow(
  client: BackendClient | null,
  exit: AppExitKind | null,
  refused: () => void
): Promise<void> {
  try {
    if (!client) throw offlineError()
    await client.requestTyped('cloud.show.handOff')
  } catch (error) {
    refused()
    toastUserError(error, { action: 'continue on another device' }, { id: CLOUD_TOAST_ID })
    return
  }
  if (exit) void window.videorc?.exitApp?.(exit)
}

/** Plan 243 D10: focus asks videorc.com for a show live elsewhere, once per 10 s. */
let cloudCheckedAt = 0
export function checkCloudShow(client: BackendClient, nowMs = Date.now()): void {
  // A clock set back never blocks the check.
  if (nowMs >= cloudCheckedAt && nowMs - cloudCheckedAt < 10_000) return
  cloudCheckedAt = nowMs
  void client.requestTyped('cloud.show.check').catch(() => {})
}

/** The row shows the test result; only a refused click needs a warning. */
export async function runCloudTest(
  client: BackendClient,
  outputs: CloudTestOutput[],
  commit: CommitCloudStatus
): Promise<void> {
  try {
    commit(await client.requestTyped('cloud.selftest.run', { outputs }))
  } catch (error) {
    toastUserError(error, { action: 'test', object: 'Videorc Cloud' }, { id: CLOUD_TOAST_ID })
  }
}

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

/** Plan 222 U1: the once-per-account notice, with "Open Destinations". */
export const CLOUD_ANNOUNCE_TOAST = {
  title: 'Videorc Cloud is on',
  description: 'Your stream stays on air if this computer drops. Set it up in Destinations.'
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
      label: 'Open Destinations',
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
