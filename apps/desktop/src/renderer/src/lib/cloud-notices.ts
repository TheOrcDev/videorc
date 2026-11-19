import type { BackendClient } from '@/backendClient'

import type {
  AppExitKind,
  CloudHandOffAnswer,
  CloudSettingsPatch,
  CloudStatus,
  CloudTestOutput
} from './backend'
import { CLOUD_TOAST_ID, formatCloudCountdown } from './cloud-toasts'
import { HAND_OFF_UNCONFIRMED } from './cloud-handoff-view'
import { toast } from './toast'
import { offlineError, toastUserError } from './user-error'

// Videorc Cloud's user actions and the answers to them: loaded with the
// first cloud action, outside the eager provider. What the cloud reports on
// its own (a fallback, a lost show, a restart, the cap, a take-over, the
// once-per-account announcement) is a notification since plan 250:
// `notifications/sources/cloud.ts`.

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
 * R2 A-M5: an answer that videorc.com did not confirm is still a hand-off
 * (this computer stopped), said once in a neutral toast. Only an error, a
 * refusal that stopped nothing, says why, keeps the app, and lets the
 * provider give the session its broadcasts back when it is still fed.
 */
export async function handOffCloudShow(
  client: BackendClient | null,
  exit: AppExitKind | null,
  refused: () => void
): Promise<void> {
  let answer: CloudHandOffAnswer
  try {
    if (!client) throw offlineError()
    answer = await client.requestTyped('cloud.show.handOff')
  } catch (error) {
    refused()
    toastUserError(error, { action: 'continue on another device' }, { id: CLOUD_TOAST_ID })
    return
  }
  if (!answer.confirmed) toast.info(HAND_OFF_UNCONFIRMED, { id: CLOUD_TOAST_ID })
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
