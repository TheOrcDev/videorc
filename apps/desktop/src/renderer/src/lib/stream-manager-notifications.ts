// Plan 250 S8: the Stream Manager's copy of the notification list. That
// window has no backend socket and no store of its own: main relays the list
// the main window keeps, and what is pressed here goes back as a key and an
// action id. This module is the copy, the list's source, and the pop-up an
// urgent entry shows here while this window is in front.

import { useSyncExternalStore } from 'react'

import type { NotificationBellCount } from '@/lib/notification-count'
import { RECOVERY_POP_UP_MS } from '@/lib/notifications/policy'
import { notificationToast, notificationToastId } from '@/lib/notifications/pop-up'
import type { NotificationEntry } from '@/lib/notifications/types'
import type { NotificationListSource } from '@/lib/notifications/view'
import { toast } from '@/lib/toast'
import type {
  NotificationActRequest,
  NotificationPopUp,
  NotificationsSnapshot
} from '../../../shared/notifications-relay'

type Api = Pick<
  NonNullable<Window['videorc']>,
  | 'getNotifications'
  | 'onNotifications'
  | 'onNotificationPopUp'
  | 'notificationActFromCommentsWindow'
>

const NONE: NotificationBellCount = { unread: 0, tone: null, urgent: 0 }
const EMPTY: readonly NotificationEntry[] = []

let snapshot: NotificationsSnapshot | null = null
let entries: readonly NotificationEntry[] = EMPTY
const listeners = new Set<() => void>()

function commit(next: NotificationsSnapshot | null): void {
  snapshot = next
  // The relay's entries are the store's own, with the kind as a plain string.
  entries = (next?.entries ?? EMPTY) as readonly NotificationEntry[]
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function api(): Api | undefined {
  const bridge = typeof window === 'undefined' ? undefined : window.videorc
  return bridge?.notificationActFromCommentsWindow ? bridge : undefined
}

/** One request to the main window's store. False when it could not be sent. */
export function actOnNotification(request: NotificationActRequest): Promise<boolean> {
  const bridge = api()
  if (!bridge) return Promise.resolve(false)
  return bridge.notificationActFromCommentsWindow(request).catch(() => false)
}

/** The list the Stream Manager's bell opens: the main window's, relayed. */
export const streamManagerNotificationSource: NotificationListSource = {
  subscribe,
  snapshot: () => entries,
  async runAction(key, actionId) {
    const action = entries
      .find((entry) => entry.key === key)
      ?.actions.find((candidate) => candidate.id === actionId)
    if (!action) return
    await actOnNotification({ type: 'run', key, actionId, door: action.kind === 'door' })
  },
  clear: (key) => void actOnNotification({ type: 'clear', key }),
  clearAll: () => void actOnNotification({ type: 'clear-all' }),
  markAllRead: () => void actOnNotification({ type: 'mark-all-read' }),
  setListOpen: (open) => void actOnNotification({ type: 'list-open', open })
}

export function useStreamManagerNotificationCount(): NotificationBellCount {
  // The third reader serves a static render (the Stream Manager's tests).
  return useSyncExternalStore(
    subscribe,
    () => snapshot?.count ?? NONE,
    () => NONE
  )
}

/** An urgent entry popping up here, because this window is the one in front. */
export function showRelayedPopUp(popUp: NotificationPopUp): void {
  if (popUp.type === 'dismiss') {
    toast.dismiss(notificationToastId(popUp.key))
    return
  }
  if (popUp.type === 'resolved') {
    toast.success(popUp.title, {
      id: notificationToastId(popUp.key),
      description: undefined,
      duration: RECOVERY_POP_UP_MS,
      action: undefined
    })
    return
  }
  const { entry, action } = popUp
  let acted = false
  notificationToast(entry.tone)(entry.title, {
    id: notificationToastId(entry.key),
    description: entry.detail,
    duration: popUp.durationMs,
    ...(action
      ? {
          action: {
            label: action.label,
            onClick: () => {
              acted = true
              void actOnNotification({
                type: 'run',
                key: entry.key,
                actionId: action.id,
                door: action.kind === 'door'
              })
            }
          }
        }
      : {}),
    // Closed by hand: it has been seen. A press marks it read on its own.
    onDismiss: () => {
      if (!acted) void actOnNotification({ type: 'mark-read', key: entry.key })
    }
  })
}

let started = 0
let stop: (() => void) | null = null

/**
 * Starts reading the relayed list (once, however many bells mount). Returns
 * a function that stops it when the last caller leaves.
 */
export function startStreamManagerNotifications(): () => void {
  started += 1
  if (started === 1) {
    const bridge = typeof window === 'undefined' ? undefined : window.videorc
    let alive = true
    const offList = bridge?.onNotifications?.(commit)
    const offPopUp = bridge?.onNotificationPopUp?.(showRelayedPopUp)
    void bridge
      ?.getNotifications?.()
      .then((first) => {
        // An event that arrived first is newer than this answer.
        if (alive && snapshot === null) commit(first)
      })
      .catch(() => {})
    stop = () => {
      alive = false
      offList?.()
      offPopUp?.()
    }
  }
  return () => {
    started -= 1
    if (started === 0) {
      stop?.()
      stop = null
      commit(null)
    }
  }
}

/** Tests only. */
export function resetStreamManagerNotificationsForTests(): void {
  stop?.()
  stop = null
  started = 0
  commit(null)
}
