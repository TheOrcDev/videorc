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
  watchdog: { tone: 'warning', life: 'condition', mayBe: ['urgent', 'news'] },

  // The live output and the connection (`health` events, S5).
  'stream-output': { tone: 'urgent', life: 'condition' },
  'stream-output-failed': { tone: 'urgent', life: 'event' },
  'recording-output-failed': { tone: 'urgent', life: 'event' },
  'stream-delivery': { tone: 'warning', life: 'condition' },
  'stream-uplink': { tone: 'warning', life: 'condition' },
  'screen-capture': { tone: 'warning', life: 'condition', mayBe: ['urgent'] },
  'host-overloaded': { tone: 'warning', life: 'condition' },
  'disk-space': { tone: 'warning', life: 'condition' },
  // What the session said at its start and holds true until it ends.
  'session-notice': { tone: 'warning', life: 'condition' },
  'recording-quality': { tone: 'warning', life: 'event' },
  'separate-file': { tone: 'warning', life: 'event' },
  'recording-failed': { tone: 'urgent', life: 'event' },
  'source-fallback': { tone: 'warning', life: 'event' },

  // Audio (`health` events, S5).
  microphone: { tone: 'warning', life: 'condition', mayBe: ['urgent'] },
  'audio-blip': { tone: 'news', life: 'event' },
  'system-audio-echo': { tone: 'warning', life: 'condition' },
  'audio-output-failed': { tone: 'urgent', life: 'event' }
} satisfies Record<string, NotificationKind>

export type NotificationKindId = keyof typeof kinds

export const NOTIFICATION_KINDS: Record<NotificationKindId, NotificationKind> = kinds

/** The kinds whose own tone is urgent: the short list, in one place. */
export function urgentKinds(): NotificationKindId[] {
  return (Object.keys(kinds) as NotificationKindId[]).filter(
    (id) => NOTIFICATION_KINDS[id].tone === 'urgent'
  )
}

/** Pure. The tone a report takes: the kind's own, or one the kind allows. */
export function kindTone(
  kind: NotificationKind,
  asked: NotificationTone | undefined
): NotificationTone {
  if (asked === undefined || asked === kind.tone) return kind.tone
  return kind.mayBe?.includes(asked) ? asked : kind.tone
}
