// Plan 250: the main window's notification store. The main window owns the
// backend socket and the Studio, where every report is made, so the one
// store lives here; other windows read a copy.

import { announceNotification, setNotificationCount } from '@/lib/notification-count'
import { installNotificationPopUps } from '@/lib/notifications/pop-up'
import { createNotificationStore } from '@/lib/notifications/store'
import { guardToastText } from '@/lib/toast'

export const notifications = createNotificationStore({
  onCount: setNotificationCount,
  guardText: (text) => guardToastText(text).text,
  onAnnounce: (entry) => announceNotification(entry.title, entry.tone === 'urgent')
})

installNotificationPopUps(notifications)

// Smokes read the list here (`scripts/lib/notifications-smoke.mjs`): reading
// it has no side effect, where opening it on screen marks every entry read.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(
    window as Window & { __videorcSmokeNotifications?: () => unknown }
  ).__videorcSmokeNotifications = () => ({
    count: notifications.count(),
    entries: notifications.snapshot()
  })
}

export type { NotificationStore } from '@/lib/notifications/store'
export type * from '@/lib/notifications/types'
