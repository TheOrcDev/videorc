// Plan 250: the main window's notification store. The main window owns the
// backend socket and the Studio, where every report is made, so the one
// store lives here; other windows read a copy.

import { announceNotification, setNotificationCount } from '@/lib/notification-count'
import { installNotificationPopUps } from '@/lib/notifications/pop-up'
import { startNotificationRelay } from '@/lib/notifications/relay'
import { createNotificationStore } from '@/lib/notifications/store'
import { guardToastText } from '@/lib/toast'

export const notifications = createNotificationStore({
  onCount: setNotificationCount,
  guardText: (text) => guardToastText(text).text,
  onAnnounce: (entry) => announceNotification(entry.title, entry.tone === 'urgent')
})

installNotificationPopUps(notifications)

/** "Quiet while recording or live", as the Studio last said (the relay's footer line). */
let relayedQuiet: () => boolean = () => true

/**
 * Plan 250 S8: the Stream Manager's bell reads a copy of this list. The
 * relay starts where the bridge to main exists (the app, never a unit test
 * that does not ask for it), and replaces the pop-up door with one that
 * offers each pop-up to the Stream Manager first.
 */
export function startMainNotificationRelay(quiet: () => boolean): void {
  relayedQuiet = quiet
  if (relayStarted) return
  const api = typeof window === 'undefined' ? undefined : window.videorc
  if (!api?.pushNotifications || !api.pushNotificationPopUp || !api.onNotificationActRequest) return
  relayStarted = true
  startNotificationRelay(notifications, api, () => relayedQuiet())
}
let relayStarted = false

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
