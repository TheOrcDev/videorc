import type { CohostReason, CohostState, Device } from '@/lib/backend'
import {
  COHOST_ERROR_TOAST_MESSAGES,
  cohostErrorDetail,
  cohostErrorToast,
  cohostStoppedToast
} from '@/lib/cohost-state'
import type { SourceSwitchTarget } from '@/lib/live-source-selection'
import type { StreamTargetNotice } from '@/lib/stream-target-notices'
import { toast } from '@/lib/toast'
import { toastOffline } from '@/lib/user-error'

// Plan 174 S2.4: small pure pieces of the Studio's toast copy, kept out of
// use-studio so they can be tested.

const SOURCE_NOUNS: Record<SourceSwitchTarget['kind'], string> = {
  capture: 'screen',
  camera: 'camera',
  microphone: 'microphone'
}

/** "Couldn't switch to FaceTime HD Camera", or "Couldn't switch the camera". */
export function sourceSwitchFailedTitle(
  source: SourceSwitchTarget,
  devices: readonly Pick<Device, 'id' | 'name'>[]
): string {
  const name = source.deviceId
    ? devices.find((device) => device.id === source.deviceId)?.name?.trim()
    : undefined
  if (name) return `Couldn't switch to ${name}`
  if (!source.deviceId) return `Couldn't turn off the ${SOURCE_NOUNS[source.kind]}`
  return `Couldn't switch the ${SOURCE_NOUNS[source.kind]}`
}

/** Internal adapter text: never shown. Same fix as the Linux mid-session
 * refusals (stop, change the source, start again). */
const SOURCE_SWITCH_UNSUPPORTED =
  'This source cannot change until you stop, pick a new one, then start again.'

/** The switch's reason as a sentence, then the one fix. */
export function sourceSwitchFailedDescription(reason: string): string {
  const trimmed = /session source transactions/i.test(reason)
    ? SOURCE_SWITCH_UNSUPPORTED
    : reason.trim()
  const sentence = !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
  return `${sentence ? `${sentence} ` : ''}Choose it again in Sources.`
}

/**
 * Plan 250 S6: a destination is one notification, on its own subject
 * (`stream-target:<id>`), where the watchdog's alert for it also lands.
 * "{X} is back" resolves it. The store is a lazy chunk; notices of one
 * snapshot stay in order.
 */
export function showStreamTargetNotices(notices: readonly StreamTargetNotice[]): void {
  if (notices.length === 0) return
  void import('@/lib/notifications/sources/stream-targets').then((source) =>
    source.publishStreamTargetNotices(notices)
  )
}

/** The one id for Buddy's own failures and stops, so one replaces the other. */
export const COHOST_STATUS_TOAST_ID = 'cohost-status'

export type CohostStatusToast = {
  kind: 'error' | 'warning' | 'message'
  title: string
  action: 'sign-in' | 'view-premium' | null
}

function cohostUnlockAction(reason: CohostReason): CohostStatusToast['action'] {
  if (reason === 'premium-required') return 'view-premium'
  if (reason === 'signed-out' || reason === 'session-expired') return 'sign-in'
  return null
}

/**
 * Pure. Buddy's news, one toast at a time (plan 174 S2.4, J2-13): a new
 * failure or a stop the backend made, with the action that fixes it. The
 * server's error code stays out of the words; the caller logs it.
 */
export function cohostStatusToast(
  previous: CohostState | null,
  next: CohostState
): CohostStatusToast | null {
  const failure = cohostErrorToast(previous, next)
  if (failure) {
    return {
      kind: failure.reason === 'quota-exhausted' ? 'warning' : 'error',
      title: COHOST_ERROR_TOAST_MESSAGES[failure.reason],
      action: cohostUnlockAction(failure.reason)
    }
  }
  const stopped = cohostStoppedToast(previous, next)
  if (stopped && next.reason) {
    return { kind: 'message', title: stopped, action: cohostUnlockAction(next.reason) }
  }
  return null
}

/** The raw server detail behind a Buddy failure, for the console only. */
export function cohostStatusDetail(state: CohostState): string | null {
  const detail = cohostErrorDetail(state)
  return detail ? `${detail.code}: ${detail.message}` : null
}

/** One id for "approve in your browser", whichever connection asked. */
export const BROWSER_APPROVAL_TOAST_ID = 'oauth-authorization-link'

/** Load the connection notice when browser approval is needed. */
export async function showBrowserApproval(title: string, authUrl: string): Promise<void> {
  const { showBrowserApproval: show } = await loadConnectionToasts()
  show(title, authUrl)
}

/** A takeover edit refused: locked while a session runs, or Videorc offline. */
export function showTakeoverEditRefused(sessionActive: boolean): void {
  if (!sessionActive) {
    toastOffline()
    return
  }
  // A refusal is "can't now", so a warning (plan 174 S2.4, J2-9).
  toast.warning("Takeovers are locked while you're recording or live", { id: 'takeovers-locked' })
}

export async function showChatNeedsVideorcSignIn(platformLabel: string): Promise<void> {
  const { showChatNeedsVideorcSignIn: show } = await loadConnectionToasts()
  show(platformLabel)
}

export async function showVideorcSignInExpired(): Promise<void> {
  const { showVideorcSignInExpired: show } = await loadConnectionToasts()
  show()
}

/** Where an X broadcast is started and ended by hand. */
export const X_MEDIA_STUDIO_URL = 'https://studio.x.com'

/** Load X failure copy only when a broadcast step fails. */
export async function showXBroadcastProblem(
  ...args: Parameters<typeof import('./studio-connection-toasts').showXBroadcastProblem>
): Promise<void> {
  const { showXBroadcastProblem: show } = await loadConnectionToasts()
  show(...args)
}

function loadConnectionToasts() {
  return import('./studio-connection-toasts')
}
