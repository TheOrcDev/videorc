// Plan 250 S5: what each `health` event code does to the list. One row per
// code: the subject it is about, and whether it opens that subject, resolves
// it, or is a thing that happened once. This table replaces the `if` chains
// that raised a toast per code.
//
// A code with no row raises nothing, as before. A code that is known and
// deliberately silent has an `ignore` row, by name, so the test that walks
// the backend's codes can tell "decided" from "forgotten".

import type { NotificationKindId } from '@/lib/notifications/kinds'

/** The page or section an entry sends you to. */
export type HealthDoor = 'health' | 'audio' | 'sources' | 'system-audio' | 'output'

export type HealthKindRow =
  | {
      effect: 'open'
      /** The subject. */
      key: string
      kind: NotificationKindId
      /** Who reports, when two codes keep one subject open on their own. */
      source?: string
      title: string
      /** The words when the event's level is `error`, which also makes it urgent. */
      errorTitle?: string
      /** An `error` level makes the entry urgent (the kind must allow it). */
      urgentOnError?: boolean
      door?: HealthDoor
    }
  | {
      effect: 'resolve'
      key: string
      /** The reports this recovery clears. Left out: the code's own (`health`). */
      sources?: readonly string[]
      title: string
      /** "It was choppy": the store adds how long. */
      was?: string
    }
  | {
      effect: 'event'
      key: string
      kind: NotificationKindId
      title: string
      /** Words of Videorc's own, where the backend's line carries internals. */
      detail?: string
      door?: HealthDoor
    }
  /** Known, and handled by its own function (it needs more than the code). */
  | { effect: 'custom' }
  /** Known, and deliberately silent. */
  | { effect: 'ignore'; why: string }

export const HEALTH_SOURCE = 'health'
export const MICROPHONE_SILENT_SOURCE = 'health:silent'
export const MICROPHONE_LOST_SOURCE = 'health:lost'
export const SCREEN_WINDOW_SOURCE = 'health:window'

export const HEALTH_KINDS: Record<string, HealthKindRow> = {
  // The live output.
  'stream-output-failed': {
    effect: 'event',
    key: 'stream-output',
    kind: 'stream-output-failed',
    title: 'Your stream stopped',
    door: 'health'
  },
  'stream-output-stalled': {
    effect: 'open',
    key: 'stream-output',
    kind: 'stream-output',
    title: 'Your stream is frozen',
    door: 'health'
  },
  'stream-output-resumed': {
    effect: 'resolve',
    key: 'stream-output',
    title: 'Your stream is moving again',
    was: 'It was frozen'
  },
  'recording-output-failed': {
    effect: 'event',
    key: 'recording-output',
    kind: 'recording-output-failed',
    title: 'Your recording stopped',
    door: 'health'
  },
  'stream-delivery-degraded': {
    effect: 'open',
    key: 'stream-delivery',
    kind: 'stream-delivery',
    title: 'Your stream is choppy',
    door: 'health'
  },
  'stream-delivery-recovered': {
    effect: 'resolve',
    key: 'stream-delivery',
    title: 'Your stream is smooth again',
    was: 'It was choppy'
  },

  // The connection: an overflow, the step down it causes, the floor and the
  // way back are one subject.
  'stream-leg-overflow': {
    effect: 'open',
    key: 'stream-uplink',
    kind: 'stream-uplink',
    title: 'Your connection can’t keep up',
    door: 'health'
  },
  'stream-bitrate-lowered': {
    effect: 'open',
    key: 'stream-uplink',
    kind: 'stream-uplink',
    title: 'Stream quality lowered to fit your connection',
    door: 'health'
  },
  'stream-bitrate-floor': {
    effect: 'open',
    key: 'stream-uplink',
    kind: 'stream-uplink',
    title: 'Your connection can’t carry this stream',
    door: 'health'
  },
  'stream-bitrate-restored': {
    effect: 'resolve',
    key: 'stream-uplink',
    title: 'Stream quality is back',
    was: 'Your connection held it back'
  },

  // The screen.
  'screen-capture-stopped': {
    effect: 'open',
    key: 'screen-capture',
    kind: 'screen-capture',
    title: 'Screen capture stopped',
    urgentOnError: true,
    door: 'sources'
  },
  'screen-capture-restored': {
    effect: 'resolve',
    key: 'screen-capture',
    title: 'Screen capture is back',
    was: 'It was stopped'
  },
  'screen-window-out-of-sight': {
    effect: 'open',
    key: 'screen-capture',
    kind: 'screen-capture',
    source: SCREEN_WINDOW_SOURCE,
    title: 'Window out of sight',
    door: 'sources'
  },
  'screen-window-back': {
    effect: 'resolve',
    key: 'screen-capture',
    sources: [SCREEN_WINDOW_SOURCE],
    title: 'The window is back',
    was: 'It was out of sight'
  },

  // The computer. Each says when it cleared (plan 250 S9): the load stayed
  // under 1.5 per core for 30 s, or the volume holds 25 minutes again. An
  // episode that is still open ends with the session.
  'host-overloaded': {
    effect: 'open',
    key: 'host-overloaded',
    kind: 'host-overloaded',
    title: 'This computer is overloaded'
  },
  'host-overload-cleared': {
    effect: 'resolve',
    key: 'host-overloaded',
    title: 'This computer is keeping up again',
    was: 'It was overloaded'
  },
  // Sent at Record and again each time it gets worse (five minutes left,
  // then the last minute): the entry's words follow.
  'disk-space-low': {
    effect: 'open',
    key: 'disk-space',
    kind: 'disk-space',
    title: 'Recording space is low',
    door: 'output'
  },
  'disk-space-recovered': {
    effect: 'resolve',
    key: 'disk-space',
    title: 'Recording space is back',
    was: 'It was low'
  },
  // It stops the take and had no notice of its own. The take's failure is
  // the same happening: both land on the failed recording's entry
  // (`sources/health.ts`).
  'recording-disk-full': { effect: 'custom' },

  // The microphone. Two reports can hold the subject open: no sound
  // (`mic-silent`), and a lost or silent input (through
  // `publishMicrophoneLoss`, with the session's own words).
  'mic-silent': {
    effect: 'open',
    key: 'microphone',
    kind: 'microphone',
    source: MICROPHONE_SILENT_SOURCE,
    title: 'Microphone is silent',
    errorTitle: 'Recording has no sound',
    urgentOnError: true,
    door: 'audio'
  },
  'microphone-input-lost': { effect: 'custom' },
  'microphone-timeline-lost': { effect: 'custom' },
  'microphone-silent': { effect: 'custom' },
  'system-audio-lost': { effect: 'custom' },
  'microphone-timeline-recovered': {
    effect: 'resolve',
    key: 'microphone',
    sources: [MICROPHONE_LOST_SOURCE],
    title: 'Microphone is back'
  },
  'microphone-input-recovered': {
    effect: 'resolve',
    key: 'microphone',
    sources: [MICROPHONE_LOST_SOURCE],
    title: 'Microphone is back'
  },
  'microphone-signal-recovered': {
    effect: 'resolve',
    key: 'microphone',
    sources: [MICROPHONE_LOST_SOURCE, MICROPHONE_SILENT_SOURCE],
    title: 'Your microphone has sound again',
    was: 'It was silent'
  },

  // Short blips with no open state: one counted entry each, never a pop-up.
  'microphone-noise-reduction-silenced': {
    effect: 'event',
    key: 'microphone-blip',
    kind: 'audio-blip',
    title: 'Microphone silenced for a moment'
  },
  'audio-output-stalled': {
    effect: 'event',
    key: 'audio-blip',
    kind: 'audio-blip',
    title: 'Audio dropped for a moment'
  },
  'system-audio-echo-paused': {
    effect: 'open',
    key: 'system-audio-echo',
    kind: 'system-audio-echo',
    title: 'System audio paused: your stream was echoing',
    door: 'system-audio'
  },
  'audio-output-failed': {
    effect: 'event',
    key: 'audio-output',
    kind: 'audio-output-failed',
    title: 'Your recording has no sound from here',
    door: 'health'
  },

  // The take's files and its start.
  'separate-source-recordings-role-failed': { effect: 'custom' },
  'separate-source-recordings-shed': { effect: 'custom' },
  'recording-quality-not-100': { effect: 'custom' },
  'recording-startup-cadence-unsteady': { effect: 'custom' },
  'recording-output-stepped-down': { effect: 'custom' },
  'recording-degraded': { effect: 'custom' },
  'microphone-capture-worker-fallback': { effect: 'custom' },
  'microphone-capture-worker-unavailable': { effect: 'custom' },
  'recording-startup-barrier-timeout': { effect: 'custom' },

  'stream-dropped-frames': {
    effect: 'ignore',
    why: 'It fires on every rise of the count; the stream-delivery condition covers it.'
  },
  'live-background-gpu-budget': {
    effect: 'ignore',
    why: 'The still line on the Assets page covers it.'
  }
}

/**
 * The row for a code. Codes the watchdog writes for its own history
 * (`watchdog-<check>`, `-cleared`, `-acknowledged`, …) are ignored by name:
 * the alert list is their source.
 */
export function healthKindFor(code: string): HealthKindRow | null {
  if (code.startsWith('watchdog-')) {
    return { effect: 'ignore', why: 'The watchdog alert list is the source.' }
  }
  return Object.hasOwn(HEALTH_KINDS, code) ? HEALTH_KINDS[code] : null
}
