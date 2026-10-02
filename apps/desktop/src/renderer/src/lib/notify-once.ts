import { toast } from '@/lib/toast'

// Plan 094 (S3): toasts that fire from retries, timers, intervals and backend
// events can repeat every few seconds (the owner's connect flow stacked "OAuth
// callback failed." three high, about 35 times). A keyed notice updates the
// toast it already showed instead of adding another: sonner treats a repeated
// `id` as an update. Within the window the same key is one toast; after it a
// new toast may appear, so a problem that comes back still gets noticed.

export const NOTIFY_ONCE_WINDOW_MS = 30_000

export type NotifyOnceKind = 'error' | 'warning' | 'success' | 'info' | 'message'

export type NotifyOnceOptions = {
  description?: string
  duration?: number
  action?: { label: string; onClick: () => void }
}

type Recent = { shownAt: number; id: string }

const recent = new Map<string, Recent>()
let sequence = 0

/** Pure: the sonner id to use for `key` at `now`, reusing it inside the window. */
export function notifyOnceId(
  key: string,
  now: number,
  state: Map<string, Recent> = recent,
  windowMs: number = NOTIFY_ONCE_WINDOW_MS
): string {
  const previous = state.get(key)
  if (previous && now - previous.shownAt < windowMs) {
    // Keep the id, refresh the window: a producer that keeps firing stays one toast.
    state.set(key, { shownAt: now, id: previous.id })
    return previous.id
  }
  sequence += 1
  const id = `once:${key}:${sequence}`
  state.set(key, { shownAt: now, id })
  return id
}

/**
 * Show (or update) the one toast for `key`. The same key within 30 s updates
 * the existing toast in place; different keys never collide.
 */
export function notifyOnce(
  key: string,
  kind: NotifyOnceKind,
  title: string,
  options: NotifyOnceOptions = {}
): string {
  const id = notifyOnceId(key, Date.now())
  const withId = { ...options, id }
  switch (kind) {
    case 'error':
      toast.error(title, withId)
      break
    case 'warning':
      toast.warning(title, withId)
      break
    case 'success':
      toast.success(title, withId)
      break
    case 'info':
      toast.info(title, withId)
      break
    case 'message':
      toast.message(title, withId)
      break
  }
  return id
}

/** Tests only: forget every key. */
export function resetNotifyOnceForTests(): void {
  recent.clear()
  sequence = 0
}
