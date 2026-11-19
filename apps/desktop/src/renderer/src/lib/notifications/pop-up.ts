// Plan 250: the only place a notification becomes a toast. The toast is the
// same entry: closing it by hand or pressing its button marks the entry read,
// one that times out leaves it unread behind the bell. So nothing is lost
// when a toast goes, and no notification needs a pinned toast.

import { RECOVERY_POP_UP_MS } from '@/lib/notifications/policy'
import type { NotificationStore } from '@/lib/notifications/store'
import type {
  NotificationAction,
  NotificationEntry,
  NotificationPopUpDoor
} from '@/lib/notifications/types'
import { toast } from '@/lib/toast'
import { toastUserError } from '@/lib/user-error'

export function notificationToastId(key: string): string {
  return `notification:${key}`
}

type Show = (typeof toast)['warning']

/** The toast a tone pops up as: the type colours the icon only. */
export function notificationToast(tone: NotificationEntry['tone']): Show {
  return showFor({ tone })
}

function showFor(entry: Pick<NotificationEntry, 'tone'>): Show {
  switch (entry.tone) {
    case 'urgent':
      // The red icon without the error toast's Copy: the entry behind the
      // bell keeps the words.
      return toast.problem
    case 'warning':
      return toast.warning
    case 'done':
      return toast.success
    case 'news':
      return toast.info
  }
}

/** The door the store pops entries up through. Returns the door, for tests. */
export function createNotificationPopUpDoor(store: NotificationStore): NotificationPopUpDoor {
  /** Keys whose toast is on screen. */
  const showing = new Set<string>()
  /** Keys this module closed itself: sonner reports that as a dismissal too. */
  const closedHere = new Set<string>()

  const close = (key: string): void => {
    if (!showing.delete(key)) return
    closedHere.add(key)
    toast.dismiss(notificationToastId(key))
  }

  return {
    show(entry, durationMs, action: NotificationAction | undefined) {
      const { key } = entry
      showing.add(key)
      closedHere.delete(key)
      showFor(entry)(entry.title, {
        id: notificationToastId(key),
        description: entry.detail,
        duration: durationMs,
        ...(action
          ? {
              action: {
                label: action.label,
                onClick: () => {
                  showing.delete(key)
                  void store.runAction(key, action.id).catch((error: unknown) => {
                    toastUserError(error, { action: action.label.toLowerCase() })
                  })
                }
              }
            }
          : {}),
        onAutoClose: () => {
          showing.delete(key)
        },
        onDismiss: () => {
          if (closedHere.delete(key)) return
          // Closed by hand: it has been seen.
          if (showing.delete(key)) store.markRead(key)
        }
      })
    },

    resolved(entry) {
      // A recovery never pops up on its own. It takes the place of the
      // problem's toast when that is still on screen, briefly.
      if (!showing.delete(entry.key)) return
      toast.success(entry.title, {
        id: notificationToastId(entry.key),
        description: undefined,
        duration: RECOVERY_POP_UP_MS,
        action: undefined
      })
    },

    dismiss: close
  }
}

export function installNotificationPopUps(store: NotificationStore): void {
  store.setPopUpDoor(createNotificationPopUpDoor(store))
}
