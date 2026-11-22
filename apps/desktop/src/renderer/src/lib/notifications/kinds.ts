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
  /**
   * News Videorc tells once, outside a session (a feature switched on for
   * the account): it pops up like an answer, or nobody would see it.
   */
  announcement?: boolean
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
  'audio-output-failed': { tone: 'urgent', life: 'event' },

  // Destinations, platforms and Videorc Cloud (S6).
  // Urgent when no other destination is on air: viewers see nothing.
  'stream-target': { tone: 'warning', life: 'condition', mayBe: ['urgent'] },
  chat: { tone: 'warning', life: 'condition' },
  'account-sign-in': { tone: 'warning', life: 'condition' },
  // A step on a platform that failed while the stream goes on.
  'platform-step': { tone: 'warning', life: 'event' },
  // What Go Live did or still needs, said while the streamer waits for it.
  'go-live-step': { tone: 'news', life: 'event', answersAPress: true, popUpMs: 8_000 },
  // Urgent when X ended the broadcast itself.
  'x-playback': { tone: 'warning', life: 'condition', mayBe: ['urgent'] },
  'x-live': { tone: 'done', life: 'event', answersAPress: true },
  'platform-news': { tone: 'news', life: 'event' },
  'youtube-thumbnail': { tone: 'warning', life: 'condition' },
  'cloud-status': { tone: 'warning', life: 'condition' },
  'cloud-news': { tone: 'news', life: 'event' },
  'cloud-announce': { tone: 'news', life: 'event', announcement: true, popUpMs: 8_000 },
  'cloud-controller': { tone: 'news', life: 'condition', answersAPress: true, popUpMs: 8_000 },
  // Back in the room by itself after a backend restart: runs, then done or failed.
  'cloud-rejoin': { tone: 'news', life: 'progress' },

  // Devices, the app and finished work (S7).
  // The session runs without the device, so it counts until it is used.
  'source-return': { tone: 'warning', life: 'condition' },
  'videorc-camera': { tone: 'warning', life: 'condition' },
  'global-shortcuts': { tone: 'warning', life: 'condition' },
  // Urgent when the engine cannot come back on its own.
  backend: { tone: 'warning', life: 'condition', mayBe: ['urgent'] },
  'backend-error': { tone: 'warning', life: 'event' },
  'output-too-heavy': { tone: 'warning', life: 'event' },
  // Sidekick stopped or failed on its own (a lapse, a quota, a sign-out).
  sidekick: { tone: 'warning', life: 'event', mayBe: ['news'] },
  // Live captions the Studio starts on its own with a session could not start.
  captions: { tone: 'warning', life: 'event' },
  'app-news': { tone: 'news', life: 'event' },
  'recording-saved': { tone: 'done', life: 'event' },
  mp4: { tone: 'news', life: 'progress' },
  'work-done': { tone: 'done', life: 'event' },
  'work-failed': { tone: 'warning', life: 'event' },
  // The answer to the Clip key, wherever the streamer is.
  clip: { tone: 'done', life: 'event', answersAPress: true, popUpMs: 4_000 },
  'clip-failed': { tone: 'warning', life: 'event', answersAPress: true },
  clips: { tone: 'warning', life: 'condition' }
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
