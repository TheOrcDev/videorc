import type { CohostReason, CohostState, Device } from '@/lib/backend'
import {
  COHOST_ERROR_TOAST_MESSAGES,
  cohostErrorDetail,
  cohostErrorToast,
  cohostStoppedToast
} from '@/lib/cohost-state'
import { copyText } from '@/lib/copy-text'
import type { SourceSwitchTarget } from '@/lib/live-source-selection'
import type { StreamTargetNotice } from '@/lib/stream-target-notices'
import { toast } from '@/lib/toast'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { toastOffline, userErrorMessage } from '@/lib/user-error'

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

export type StreamTargetToast = {
  kind: StreamTargetNotice['kind']
  title: string
  id: string
  description: string
  duration: number | undefined
}

/**
 * One toast id per destination, so "{X} is back" replaces "Streaming to {X}
 * stopped" or "{X} is reconnecting" in place. A bad state mirrors what is
 * still true, so it stays until the good news replaces it (plan 174 S2.4).
 */
export function streamTargetToast(notice: StreamTargetNotice): StreamTargetToast {
  const targetId = notice.key.slice(notice.key.indexOf(':') + 1)
  const persists = notice.kind === 'error' || notice.kind === 'warning'
  return {
    kind: notice.kind,
    title: notice.title,
    id: `stream-target:${targetId}`,
    description: notice.description,
    duration: persists ? Infinity : undefined
  }
}

export function showStreamTargetNotice(notice: StreamTargetNotice): void {
  const shown = streamTargetToast(notice)
  const show = shown.kind === 'message' ? toast.message : toast[shown.kind]
  show(shown.title, {
    id: shown.id,
    description: shown.description,
    ...(shown.duration !== undefined ? { duration: shown.duration } : {})
  })
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

/**
 * A step to take, so info (plan 174 S2.4, D-16): approve in the browser.
 * Auto-open uses the default browser, which is often not the one the
 * streamer is signed into, so the link stays copyable until dismissed.
 */
export function showBrowserApproval(title: string, authUrl: string): void {
  toast.info(title, {
    id: BROWSER_APPROVAL_TOAST_ID,
    description: 'Signed in on a different browser? Copy the link and open it there instead.',
    duration: Infinity,
    action: {
      label: 'Copy link',
      // The toast closes on the click, so success still says so here.
      onClick: () => {
        void copyText(authUrl, {
          title: "Couldn't copy the link",
          description: 'The page is already open in your default browser.'
        }).then((copied) => copied && toast.success('Link copied'))
      }
    }
  })
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

/** Where an X broadcast is started and ended by hand. */
export const X_MEDIA_STUDIO_URL = 'https://studio.x.com'

function openXMediaStudio(): void {
  void window.videorc?.openOAuthUrl?.(X_MEDIA_STUDIO_URL)
}

/**
 * An X broadcast step that failed while the stream goes on, so a warning
 * (plan 174 S2.4). The words match the YouTube broadcast toast.
 */
export function showXBroadcastProblem(
  step: 'start' | 'end' | 'chat',
  target: { id: string; label: string },
  error: unknown
): void {
  const copy = userErrorMessage(error, {
    action: step === 'end' ? 'end' : 'start',
    object: 'the X broadcast'
  })
  console.warn(`[x] ${step} failed for ${target.label}:`, copy.raw)
  if (step === 'chat') {
    toast.warning(`X chat isn't connected for ${target.label}`, {
      id: `x-chat:${target.id}`,
      description: 'Your stream is fine. Check X in Livestream.',
      action: { label: 'Open Livestream', onClick: () => openWorkspaceTab('live') }
    })
    return
  }
  if (step === 'end') {
    toast.warning(copy.title, {
      id: `x-broadcast-end:${target.id}`,
      description: 'End it in X Media Studio.',
      action: { label: 'Open Media Studio', onClick: openXMediaStudio }
    })
    return
  }
  toast.warning(copy.title, { id: `x-broadcast-start:${target.id}`, description: copy.description })
}
