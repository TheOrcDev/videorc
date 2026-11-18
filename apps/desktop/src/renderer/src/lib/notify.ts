// Plan 250: the two thin doors into the notification store for code that is
// in the first paint. The store is a lazy chunk; calls made before it has
// loaded run in order once it has.

import type { NotificationInput, NotificationResolution } from '@/lib/notifications/types'

type Notifications = typeof import('@/lib/notifications')

let loading: Promise<Notifications> | null = null

export function loadNotifications(): Promise<Notifications> {
  loading ??= import('@/lib/notifications')
  return loading
}

function withStore(run: (store: Notifications['notifications']) => void): void {
  void loadNotifications().then(
    (module) => run(module.notifications),
    (error: unknown) => console.warn('[notifications] the store did not load', error)
  )
}

/** Videorc noticed something on its own: an entry behind the bell. */
export function notify(input: NotificationInput): void {
  withStore((store) => store.publish(input))
}

/** The condition cleared: its entry resolves. */
export function resolveNotification(key: string, resolution?: NotificationResolution): void {
  withStore((store) => store.resolve(key, resolution))
}

/** The report was taken back: no resolved entry is left. */
export function withdrawNotification(key: string, source?: string): void {
  withStore((store) => store.withdraw(key, source))
}
