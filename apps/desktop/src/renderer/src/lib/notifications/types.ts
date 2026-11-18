// Plan 250: what the notification center keeps. An entry is plain data, so
// the Stream Manager can receive the list as it is; the functions behind an
// entry's buttons stay inside the store, found by `key` and action `id`.

import type { NotificationKindId } from '@/lib/notifications/kinds'

/** Urgent: viewers or the recording are affected right now. */
export type NotificationTone = 'urgent' | 'warning' | 'news' | 'done'

/**
 * A condition is true for a while and resolves on its own. An event happened
 * once. Progress runs, then is done or failed.
 */
export type NotificationLife = 'condition' | 'event' | 'progress'

export type NotificationState = 'open' | 'resolved' | 'happened' | 'running' | 'done' | 'failed'

/** A fix runs in place and keeps the list open; a door opens a page and closes it. */
export interface NotificationActionView {
  id: string
  label: string
  kind: 'fix' | 'door'
}

export interface NotificationAction extends NotificationActionView {
  run: () => void | Promise<void>
}

export interface NotificationEntry {
  /** The subject, not the message: `microphone`, `stream-target:tw-1`. */
  key: string
  kind: NotificationKindId
  tone: NotificationTone
  /** The worst tone this episode reached: a cleared urgent problem still counts. */
  peakTone: NotificationTone
  life: NotificationLife
  state: NotificationState
  title: string
  detail?: string
  openedAt: number
  updatedAt: number
  resolvedAt?: number
  /** How many times an event repeated ("3 times."). */
  occurrences: number
  read: boolean
  /** Set on a condition that ends with its session. */
  sessionId?: string
  /** At most two. */
  actions: NotificationActionView[]
}

export interface NotificationInput {
  key: string
  kind: NotificationKindId
  /**
   * Who reports it. Two systems can report one subject (the watchdog and a
   * `health` event on `microphone`); the entry resolves when both cleared.
   */
  source?: string
  /** Only where the kind allows more than one tone. */
  tone?: NotificationTone
  /** Progress only. */
  state?: 'running' | 'done' | 'failed'
  title: string
  detail?: string
  actions?: NotificationAction[]
  sessionId?: string
  /** The watchdog's report: its words and fixes lead the entry. */
  lead?: boolean
  /** Runs when the streamer clears the entry while it is open ("I know"). */
  onClear?: () => void
}

export interface NotificationResolution {
  /** Which report cleared. Left out: every report on the subject. */
  source?: string
  /** The recovery's words: "Your stream is smooth again". */
  title?: string
  /** A whole sentence, in place of the one built from `was`. */
  detail?: string
  /** "It was choppy": the store adds how long, "It was choppy for 38 s." */
  was?: string
}

/** What the bell shows. */
export interface NotificationCount {
  unread: number
  /** The worst problem still open, read or not. */
  tone: 'urgent' | 'warning' | null
  /** Open urgent problems, for the bell's name. */
  urgent: number
}

/** The one place a notification becomes a toast (`pop-up.ts`). */
export interface NotificationPopUpDoor {
  show: (
    entry: NotificationEntry,
    durationMs: number,
    action: NotificationAction | undefined
  ) => void
  /** The problem cleared: a toast still showing gives way to the recovery. */
  resolved: (entry: NotificationEntry) => void
  dismiss: (key: string) => void
}
