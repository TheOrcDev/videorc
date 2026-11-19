// Plan 250 S6: Videorc Cloud's own news as notifications. What is wrong with
// the cloud show is one condition, `cloud-status`, updated in place (the
// watchdog's cloud checks land on the same subject); the rest is news.

import type { BackendClient } from '@/backendClient'
import type { CloudStatus } from '@/lib/backend'
import { onAirDeviceName } from '@/lib/cloud-handoff-view'
import { CLOUD_ANNOUNCE_TOAST, cloudAllowancePastToast } from '@/lib/cloud-notices'
import {
  cloudFallbackToast,
  cloudLostToast,
  cloudRestartToast,
  cloudShowCapToast
} from '@/lib/cloud-toasts'
import { notifications } from '@/lib/notifications'
import { CURRENT_SESSION } from '@/lib/notifications/sources/health'
import type { NotificationStore } from '@/lib/notifications/store'
import type { NotificationAction } from '@/lib/notifications/types'
import { openDestinationsCloud } from '@/lib/section-doors'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

export const CLOUD_STATUS_KEY = 'cloud-status'
export const CLOUD_SOURCE = 'cloud'

const OPEN_CLOUD: NotificationAction = {
  id: 'open-destinations',
  label: 'Open Destinations',
  kind: 'door',
  run: openDestinationsCloud
}

/** A toast was one sentence; an entry's title has no period. */
function asTitle(sentence: string): { title: string; detail?: string } {
  const [first, ...rest] = sentence.split(/(?<=\.)\s+/)
  return {
    title: first.replace(/\.$/, ''),
    ...(rest.length > 0 ? { detail: rest.join(' ') } : {})
  }
}

/** The session a cloud condition ends with: the show's, or the local one. */
function cloudSession(status: CloudStatus): string {
  return status.show?.id ? `cloud:${status.show.id}` : CURRENT_SESSION
}

/** The provider's cloud status, compared with the one before it. */
export function publishCloudStatus(
  previous: CloudStatus | null,
  next: CloudStatus,
  store: NotificationStore = notifications
): void {
  // A show that is gone takes its open problem with it.
  if (previous?.show?.id && previous.show.id !== next.show?.id) {
    store.sessionEnded('livestream', `cloud:${previous.show.id}`)
  }
  if (next.endReason === 'ended-elsewhere' && previous?.endReason !== 'ended-elsewhere') {
    store.publish({
      key: 'cloud-ended-elsewhere',
      kind: 'cloud-news',
      title: 'The show was ended from videorc.com',
      once: true
    })
  }
  // Each compares this status with the one before it, so all four are asked
  // every time; the last in this order speaks, as when they shared one toast.
  const fallback = cloudFallbackToast(previous, next)
  const lost = cloudLostToast(previous, next)
  const restarted = cloudRestartToast(previous, next)
  const cap = cloudShowCapToast(previous, next)
  const problem = cap ?? restarted ?? lost ?? fallback
  if (problem) {
    store.publish({
      key: CLOUD_STATUS_KEY,
      kind: 'cloud-status',
      source: CLOUD_SOURCE,
      ...asTitle(problem),
      actions: [OPEN_CLOUD],
      sessionId: cloudSession(next)
    })
  }
  // Plan 222 U5: past the month's hours is news, never a cut (D18).
  const past = next.allowancePast ? cloudAllowancePastToast(previous, next) : null
  if (past) {
    store.publish({
      key: 'cloud-allowance',
      kind: 'cloud-news',
      title: past.title,
      detail: past.description,
      once: true
    })
  }
  // Plan 243 C5: another device continued the show and this computer
  // stopped. Neutral news: the Studio's notice offers Continue here.
  if (next.stoppedBy === 'taken-over' && previous?.stoppedBy !== 'taken-over') {
    store.publish({
      key: 'cloud-taken-over',
      kind: 'cloud-news',
      // A device's name is the streamer's own text, so it skips the guard
      // for raw provider text; React renders it escaped.
      title: `Your show continues on ${onAirDeviceName(next.onAir)}`,
      ownWords: true,
      actions: [
        {
          id: 'open-studio',
          label: 'Open Studio',
          kind: 'door',
          run: () => openWorkspaceTab('studio')
        }
      ]
    })
  }
}

/**
 * Plan 222 U1: "Videorc Cloud is on", once per account on this computer, and
 * never during a session. It tells the backend it showed.
 */
export function announceCloud(
  client: Pick<BackendClient, 'requestTyped'>,
  commit: (status: CloudStatus) => void,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: 'cloud-announce',
    kind: 'cloud-announce',
    title: CLOUD_ANNOUNCE_TOAST.title,
    detail: CLOUD_ANNOUNCE_TOAST.description,
    actions: [OPEN_CLOUD],
    once: true
  })
  void client
    .requestTyped('cloud.announce.seen')
    .then(commit)
    .catch(() => {
      // Shown once in this run either way; the next launch asks again.
    })
}

export const CLOUD_CONTROLLER_KEY = 'cloud-controller'

/**
 * This device now controls a show another one started (plan 249): its camera
 * and microphone stay off until the streamer turns them on.
 */
export function publishCloudController(
  needs: readonly string[],
  turnOn: () => void,
  store: NotificationStore = notifications
): void {
  const also = needs.filter((need) => need !== 'camera' && need !== 'microphone').join(', ')
  store.publish({
    key: CLOUD_CONTROLLER_KEY,
    kind: 'cloud-controller',
    title: 'You control this show here now',
    detail:
      needs.length > 0
        ? `Camera and microphone stay off here until you turn them on. Also off: ${also || 'nothing else'}.`
        : 'Camera and microphone stay off here until you turn them on.',
    actions: [{ id: 'turn-on', label: 'Turn on', kind: 'fix', run: turnOn }]
  })
}

export function withdrawCloudController(store: NotificationStore = notifications): void {
  store.withdraw(CLOUD_CONTROLLER_KEY)
}
