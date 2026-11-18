// Plan 250: the registry. One row per kind of notification, with its tone and
// its life. The urgent list is short on purpose and lives here: a new urgent
// kind is a decision, not a default (the test pins the list).

import type { NotificationLife, NotificationTone } from '@/lib/notifications/types'

export interface NotificationKind {
  tone: NotificationTone
  life: NotificationLife
  /** Other tones a report may carry (a watchdog alert's severity decides). */
  mayBe?: readonly NotificationTone[]
  /**
   * The late answer to a press (a clip saved by a hotkey): it is an entry and
   * it still pops up, briefly, because the streamer is waiting for it.
   */
  answersAPress?: boolean
  /** How long that pop-up stays, when not the default. */
  popUpMs?: number
}

const kinds = {
  // The stream watchdog (plan 223): the alert's severity is its tone.
  watchdog: { tone: 'warning', life: 'condition', mayBe: ['urgent', 'news'] }
} satisfies Record<string, NotificationKind>

export type NotificationKindId = keyof typeof kinds

export const NOTIFICATION_KINDS: Record<NotificationKindId, NotificationKind> = kinds

/** Pure. The tone a report takes: the kind's own, or one the kind allows. */
export function kindTone(
  kind: NotificationKind,
  asked: NotificationTone | undefined
): NotificationTone {
  if (asked === undefined || asked === kind.tone) return kind.tone
  return kind.mayBe?.includes(asked) ? asked : kind.tone
}
