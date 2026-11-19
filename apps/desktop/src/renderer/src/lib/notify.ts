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

type WorkNotifications = typeof import('@/lib/notifications/sources/work')
type AppNotifications = typeof import('@/lib/notifications/sources/app')

let work: Promise<WorkNotifications> | null = null
let app: Promise<AppNotifications> | null = null

function warn(error: unknown): void {
  console.warn('[notifications] a source did not load', error)
}

/**
 * Finished work (an export, a clip, a download) reported from code that is in
 * the first paint, or in a page's chunk: the source loads once, and calls
 * keep their order.
 */
export function withWorkNotifications(run: (source: WorkNotifications) => void): void {
  work ??= import('@/lib/notifications/sources/work')
  void work.then(run, warn)
}

/** The same door for devices and the app's own state. */
export function withAppNotifications(run: (source: AppNotifications) => void): void {
  app ??= import('@/lib/notifications/sources/app')
  void app.then(run, warn)
}
