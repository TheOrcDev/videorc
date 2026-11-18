// Plan 250: the main window's notification store. The main window owns the
// backend socket and the Studio, where every report is made, so the one
// store lives here; other windows read a copy.

import { announceNotification, setNotificationCount } from '@/lib/notification-count'
import { installNotificationPopUps } from '@/lib/notifications/pop-up'
import { createNotificationStore } from '@/lib/notifications/store'

export const notifications = createNotificationStore({
  onCount: setNotificationCount,
  onAnnounce: (entry) => announceNotification(entry.title, entry.tone === 'urgent')
})

installNotificationPopUps(notifications)

export type { NotificationStore } from '@/lib/notifications/store'
export type * from '@/lib/notifications/types'
