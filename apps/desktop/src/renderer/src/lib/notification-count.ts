// Plan 250: what the bell reads. This module is in every window's first
// paint, so it holds only the number, the tone, the last line to announce and
// the event that opens the list. The store behind it is a lazy chunk
// (`lib/notifications`), which writes here.

import { useSyncExternalStore } from 'react'

export interface NotificationBellCount {
  /** Unread urgent and warning entries, and unread finished work. */
  unread: number
  /** The worst problem still open, read or not. */
  tone: 'urgent' | 'warning' | null
  /** Open urgent problems, for the bell's name. */
  urgent: number
}

export interface NotificationAnnouncement {
  text: string
  urgent: boolean
  /** A new number for every line, so the same words can be said twice. */
  sequence: number
}

interface BellState {
  count: NotificationBellCount
  announcement: NotificationAnnouncement | null
}

const NONE: NotificationBellCount = { unread: 0, tone: null, urgent: 0 }

let state: BellState = { count: NONE, announcement: null }
let listOpen = false
const listeners = new Set<() => void>()

function set(next: BellState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setNotificationCount(count: NotificationBellCount): void {
  set({ ...state, count })
}

/** A new entry, or one that got worse: said once by the bell's live region. */
export function announceNotification(text: string, urgent: boolean): void {
  set({
    ...state,
    announcement: { text, urgent, sequence: (state.announcement?.sequence ?? 0) + 1 }
  })
}

export function useNotificationCount(): NotificationBellCount {
  return useSyncExternalStore(
    subscribe,
    () => state.count,
    () => NONE
  )
}

export function useNotificationAnnouncement(): NotificationAnnouncement | null {
  return useSyncExternalStore(
    subscribe,
    () => state.announcement,
    () => null
  )
}

/** "9+" above nine; nothing at zero. */
export function notificationCountLabel(unread: number): string | undefined {
  if (unread <= 0) return undefined
  return unread > 9 ? '9+' : String(unread)
}

/** "Notifications, 2 unread, 1 urgent": the bell's name for a screen reader. */
export function notificationBellName(count: NotificationBellCount): string {
  const parts = ['Notifications']
  if (count.unread > 0) parts.push(`${count.unread} unread`)
  if (count.urgent > 0) parts.push(`${count.urgent} urgent`)
  else if (count.tone === 'warning') parts.push('a warning is open')
  return parts.join(', ')
}

export const NOTIFICATIONS_TOGGLE_EVENT = 'videorc:toggle-notifications'

export type NotificationsToggle = 'toggle' | 'open' | 'close'

/** Opens or closes the list from anywhere in the window (the shortcut, Search). */
export function toggleNotifications(action: NotificationsToggle = 'toggle'): void {
  window.dispatchEvent(
    new CustomEvent<NotificationsToggle>(NOTIFICATIONS_TOGGLE_EVENT, { detail: action })
  )
}

/** The bell says when its list is open, so the shortcut can close it from under it. */
export function setNotificationsOpen(open: boolean): void {
  listOpen = open
}

export function notificationsOpen(): boolean {
  return listOpen
}

/** Tests only. */
export function resetNotificationCountForTests(): void {
  listOpen = false
  set({ count: NONE, announcement: null })
}
