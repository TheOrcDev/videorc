// Plan 250: what the list draws from the store's entries. Pure.

import { isNow } from '@/lib/notifications/policy'
import type { NotificationEntry } from '@/lib/notifications/types'

export interface NotificationGroups {
  /** Still true: open problems and work in progress. */
  now: NotificationEntry[]
  /** Resolved problems, finished work and news, newest first. */
  earlier: NotificationEntry[]
  /** Labels are drawn only when both groups have entries. */
  labelled: boolean
}

/** The store hands the entries over already in order; this only splits them. */
export function groupNotifications(entries: readonly NotificationEntry[]): NotificationGroups {
  const now = entries.filter(isNow)
  const earlier = entries.filter((entry) => !isNow(entry))
  return { now, earlier, labelled: now.length > 0 }
}

/** There is something Clear all would remove. */
export function hasClearable(entries: readonly NotificationEntry[]): boolean {
  return entries.some((entry) => !isNow(entry))
}

/**
 * The time on an entry's first line. An open problem shows how long it has
 * been open ("0:40", then "2 min"); everything else shows how long ago it
 * happened ("now", "14 min", "3 h").
 */
export function notificationTimeWords(
  entry: Pick<NotificationEntry, 'state' | 'openedAt' | 'updatedAt' | 'resolvedAt'>,
  nowMs: number
): string {
  if (entry.state === 'open') {
    const seconds = Math.max(0, Math.floor((nowMs - entry.openedAt) / 1000))
    if (seconds < 60) return `0:${String(seconds).padStart(2, '0')}`
    return agoWords(seconds)
  }
  const at = entry.resolvedAt ?? entry.updatedAt
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000))
  return seconds < 45 ? 'now' : agoWords(Math.max(60, seconds))
}

function agoWords(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** What the list reads and asks for; the Stream Manager's copy answers the same. */
export interface NotificationListSource {
  subscribe: (listener: () => void) => () => void
  snapshot: () => readonly NotificationEntry[]
  runAction: (key: string, actionId: string) => Promise<void>
  clear: (key: string) => void
  clearAll: () => void
  markAllRead: () => void
  setListOpen: (open: boolean) => void
}
