// Plan 250 S8: the main window's side of the Stream Manager's bell. It pushes
// a copy of the list through main whenever the list changes, runs what the
// Stream Manager presses, and offers each pop-up to the Stream Manager first,
// so an urgent problem shows in the window the streamer is in.

import { createNotificationPopUpDoor } from '@/lib/notifications/pop-up'
import type { NotificationStore } from '@/lib/notifications/store'
import type {
  NotificationAction,
  NotificationEntry,
  NotificationPopUpDoor
} from '@/lib/notifications/types'
import { openNotificationSettings } from '@/lib/section-doors'
import { toastUserError } from '@/lib/user-error'
import type {
  NotificationActRequest,
  NotificationsSnapshot,
  RelayedNotification
} from '../../../../shared/notifications-relay'
import { RELAYED_NOTIFICATIONS_MAX } from '../../../../shared/notifications-relay'

/** Who holds the list open, to the store: the Stream Manager's own name. */
const STREAM_MANAGER = 'stream-manager'

/** An entry as it travels: plain fields only, bounded like its schema. */
export function relayedNotification(entry: NotificationEntry): RelayedNotification {
  return {
    key: entry.key,
    kind: entry.kind,
    tone: entry.tone,
    peakTone: entry.peakTone,
    life: entry.life,
    state: entry.state,
    title: entry.title.slice(0, 2000),
    ...(entry.detail !== undefined ? { detail: entry.detail.slice(0, 2000) } : {}),
    openedAt: Math.max(0, entry.openedAt),
    updatedAt: Math.max(0, entry.updatedAt),
    ...(entry.resolvedAt !== undefined ? { resolvedAt: Math.max(0, entry.resolvedAt) } : {}),
    occurrences: Math.max(1, Math.floor(entry.occurrences)),
    read: entry.read,
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    actions: entry.actions.slice(0, 2).map(({ id, label, kind }) => ({ id, label, kind }))
  }
}

export function notificationsSnapshot(
  store: Pick<NotificationStore, 'snapshot' | 'count'>,
  quiet: boolean
): NotificationsSnapshot {
  return {
    entries: store.snapshot().slice(0, RELAYED_NOTIFICATIONS_MAX).map(relayedNotification),
    count: store.count(),
    quiet
  }
}

/** One request from the Stream Manager, applied to the store. */
export function applyNotificationAct(
  store: NotificationStore,
  request: NotificationActRequest
): void {
  switch (request.type) {
    case 'run':
      void store.runAction(request.key, request.actionId).catch((error: unknown) => {
        // It answers a press, so it says so, in the window the door opened.
        toastUserError(error)
      })
      return
    case 'clear':
      store.clear(request.key)
      return
    case 'clear-all':
      store.clearAll()
      return
    case 'mark-read':
      store.markRead(request.key)
      return
    case 'mark-all-read':
      store.markAllRead()
      return
    case 'list-open':
      store.setListOpen(request.open, STREAM_MANAGER)
      return
    case 'open-settings':
      openNotificationSettings()
      return
  }
}

type RelayApi = Pick<
  NonNullable<Window['videorc']>,
  'pushNotifications' | 'pushNotificationPopUp' | 'onNotificationActRequest'
>

/**
 * The door a pop-up goes through when a Stream Manager may be in front: main
 * says whether that window took it; otherwise it shows here.
 */
export function relayedPopUpDoor(
  local: NotificationPopUpDoor,
  api: Pick<RelayApi, 'pushNotificationPopUp'>
): NotificationPopUpDoor {
  /** Keys whose toast is in the Stream Manager. */
  const there = new Set<string>()
  return {
    show(entry: NotificationEntry, durationMs: number, action: NotificationAction | undefined) {
      const showHere = (): void => local.show(entry, durationMs, action)
      void api
        .pushNotificationPopUp({
          type: 'show',
          entry: relayedNotification(entry),
          durationMs,
          ...(action ? { action: { id: action.id, label: action.label, kind: action.kind } } : {})
        })
        .then((taken) => {
          if (taken) there.add(entry.key)
          else showHere()
        }, showHere)
    },
    resolved(entry) {
      if (there.delete(entry.key)) {
        void api
          .pushNotificationPopUp({ type: 'resolved', key: entry.key, title: entry.title })
          .catch(() => {})
      } else {
        local.resolved(entry)
      }
    },
    dismiss(key) {
      if (there.delete(key)) {
        void api.pushNotificationPopUp({ type: 'dismiss', key }).catch(() => {})
      } else {
        local.dismiss(key)
      }
    }
  }
}

/**
 * Starts the relay. Returns its stop function. Pushes are coalesced to one a
 * frame: an open watchdog alert rewrites its clock every second.
 */
export function startNotificationRelay(
  store: NotificationStore,
  api: RelayApi,
  quiet: () => boolean
): () => void {
  let scheduled = false
  const push = (): void => {
    scheduled = false
    void api.pushNotifications(notificationsSnapshot(store, quiet())).catch(() => {})
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(push)
  }
  const offStore = store.subscribe(schedule)
  const offAct = api.onNotificationActRequest((request) => applyNotificationAct(store, request))
  store.setPopUpDoor(relayedPopUpDoor(createNotificationPopUpDoor(store), api))
  // A Stream Manager that is already open learns the list at once, and after
  // a reload of this window it learns that the list is empty again.
  schedule()
  return () => {
    offStore()
    offAct()
    store.setListOpen(false, STREAM_MANAGER)
  }
}
