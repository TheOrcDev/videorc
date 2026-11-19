import { beforeEach, describe, expect, it } from 'vitest'

import type { HealthEvent } from '@/lib/backend'
import { HEALTH_KINDS, healthKindFor } from '@/lib/notifications/health-kinds'
import { NOTIFICATION_KINDS } from '@/lib/notifications/kinds'
import { publishHealthEvent } from '@/lib/notifications/sources/health'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'

function event(code: string, level: HealthEvent['level'] = 'warn'): HealthEvent {
  return {
    id: code,
    sessionId: 'live',
    level,
    code,
    message: `${code} message`,
    createdAt: '2026-11-19T10:00:00Z'
  }
}

const context = { recording: { sessionId: 'live', state: 'streaming' as const } }

/**
 * Every code that raised a toast before plan 250 S5, from the three `if`
 * chains this table replaced (`showSessionHealthEvent`, `showLiveOutputNews`,
 * `showSessionAudioNews`) and the startup notices of `studio-health.ts`.
 */
const CODES_HANDLED_BEFORE_S5 = [
  'separate-source-recordings-role-failed',
  'separate-source-recordings-shed',
  'recording-startup-cadence-unsteady',
  'recording-output-stepped-down',
  'recording-degraded',
  'microphone-capture-worker-fallback',
  'microphone-capture-worker-unavailable',
  'recording-startup-barrier-timeout',
  'recording-quality-not-100',
  'mic-silent',
  'stream-output-failed',
  'recording-output-failed',
  'stream-output-stalled',
  'stream-output-resumed',
  'stream-delivery-degraded',
  'stream-delivery-recovered',
  'stream-leg-overflow',
  'stream-bitrate-lowered',
  'stream-bitrate-floor',
  'stream-bitrate-restored',
  'screen-capture-stopped',
  'screen-capture-restored',
  'screen-window-out-of-sight',
  'screen-window-back',
  'host-overloaded',
  'disk-space-low',
  'microphone-noise-reduction-silenced',
  'system-audio-echo-paused',
  'audio-output-stalled',
  'audio-output-failed',
  'microphone-timeline-recovered',
  'microphone-input-recovered',
  'microphone-signal-recovered',
  // Through `publishMicrophoneInputLost` in the Studio.
  'microphone-input-lost',
  'microphone-timeline-lost',
  'microphone-silent',
  'system-audio-lost'
]

describe('health events as notifications (plan 250 S5)', () => {
  let store: NotificationStore
  beforeEach(() => {
    store = createNotificationStore()
  })

  it('no code handled before S5 is missing from the table', () => {
    const missing = CODES_HANDLED_BEFORE_S5.filter((code) => healthKindFor(code) === null)
    expect(missing).toEqual([])
  })

  it('every row names a kind the registry has, with the life its effect needs', () => {
    for (const [code, row] of Object.entries(HEALTH_KINDS)) {
      if (row.effect === 'open') {
        expect(NOTIFICATION_KINDS[row.kind].life, code).toBe('condition')
        if (row.urgentOnError) {
          expect(
            NOTIFICATION_KINDS[row.kind].tone === 'urgent' ||
              NOTIFICATION_KINDS[row.kind].mayBe?.includes('urgent'),
            code
          ).toBe(true)
        }
      } else if (row.effect === 'event') {
        expect(NOTIFICATION_KINDS[row.kind].life, code).toBe('event')
      }
    }
  })

  it('every recovery resolves a subject some code opens', () => {
    const opened = new Set(
      Object.values(HEALTH_KINDS).flatMap((row) => (row.effect === 'open' ? [row.key] : []))
    )
    for (const [code, row] of Object.entries(HEALTH_KINDS)) {
      if (row.effect === 'resolve') expect(opened.has(row.key), code).toBe(true)
    }
  })

  // The inventory's "Live output" and "Audio" tables: code, subject, tone, state.
  const rows: [string, HealthEvent['level'], string, string, string][] = [
    ['stream-output-failed', 'error', 'stream-output', 'urgent', 'happened'],
    ['stream-output-stalled', 'warn', 'stream-output', 'urgent', 'open'],
    ['recording-output-failed', 'error', 'recording-output', 'urgent', 'happened'],
    ['stream-delivery-degraded', 'warn', 'stream-delivery', 'warning', 'open'],
    ['stream-leg-overflow', 'warn', 'stream-uplink', 'warning', 'open'],
    ['stream-bitrate-lowered', 'warn', 'stream-uplink', 'warning', 'open'],
    ['stream-bitrate-floor', 'warn', 'stream-uplink', 'warning', 'open'],
    ['screen-capture-stopped', 'warn', 'screen-capture', 'warning', 'open'],
    ['screen-capture-stopped', 'error', 'screen-capture', 'urgent', 'open'],
    ['screen-window-out-of-sight', 'warn', 'screen-capture', 'warning', 'open'],
    ['host-overloaded', 'warn', 'host-overloaded', 'warning', 'open'],
    ['disk-space-low', 'warn', 'disk-space', 'warning', 'open'],
    [
      'recording-startup-cadence-unsteady',
      'warn',
      'session-notice:recording-startup-cadence-unsteady',
      'warning',
      'open'
    ],
    [
      'recording-output-stepped-down',
      'warn',
      'session-notice:recording-output-stepped-down',
      'warning',
      'open'
    ],
    ['recording-degraded', 'warn', 'session-notice:recording-degraded', 'warning', 'open'],
    [
      'microphone-capture-worker-fallback',
      'warn',
      'session-notice:microphone-capture-worker-fallback',
      'warning',
      'open'
    ],
    [
      'microphone-capture-worker-unavailable',
      'warn',
      'session-notice:microphone-capture-worker-unavailable',
      'warning',
      'open'
    ],
    ['separate-source-recordings-shed', 'warn', 'separate-files-shed:live', 'warning', 'happened'],
    ['mic-silent', 'warn', 'microphone', 'warning', 'open'],
    ['mic-silent', 'error', 'microphone', 'urgent', 'open'],
    ['microphone-noise-reduction-silenced', 'warn', 'microphone-blip', 'news', 'happened'],
    ['audio-output-stalled', 'warn', 'audio-blip', 'news', 'happened'],
    ['system-audio-echo-paused', 'warn', 'system-audio-echo', 'warning', 'open'],
    ['audio-output-failed', 'error', 'audio-output', 'urgent', 'happened'],
    ['recording-disk-full', 'error', 'recording-failed:live', 'urgent', 'happened']
  ]
  it.each(rows)('%s (%s) is an entry on %s: %s, %s', (code, level, key, tone, state) => {
    expect(publishHealthEvent(store, event(code, level), context)).toBe(true)
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]).toMatchObject({ key, tone, state })
  })

  // Each recovery, after the code that opens its subject.
  const recoveries: [string, string, string, string][] = [
    [
      'stream-output-stalled',
      'stream-output-resumed',
      'stream-output',
      'Your stream is moving again'
    ],
    [
      'stream-delivery-degraded',
      'stream-delivery-recovered',
      'stream-delivery',
      'Your stream is smooth again'
    ],
    ['stream-bitrate-floor', 'stream-bitrate-restored', 'stream-uplink', 'Stream quality is back'],
    [
      'screen-capture-stopped',
      'screen-capture-restored',
      'screen-capture',
      'Screen capture is back'
    ],
    ['screen-window-out-of-sight', 'screen-window-back', 'screen-capture', 'The window is back'],
    ['mic-silent', 'microphone-signal-recovered', 'microphone', 'Your microphone has sound again']
  ]
  it.each(recoveries)('%s then %s resolves %s', (opens, recovers, key, title) => {
    publishHealthEvent(store, event(opens), context)
    expect(publishHealthEvent(store, event(recovers, 'info'), context)).toBe(true)
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]).toMatchObject({ key, state: 'resolved', tone: 'done', title })
  })

  it('a stopped capture and a hidden window are two reports on one subject', () => {
    publishHealthEvent(store, event('screen-capture-stopped', 'error'), context)
    publishHealthEvent(store, event('screen-window-out-of-sight'), context)
    publishHealthEvent(store, event('screen-window-back', 'info'), context)
    // The window is back; the capture is still stopped.
    expect(store.snapshot()[0]).toMatchObject({
      state: 'open',
      tone: 'urgent',
      title: 'Screen capture stopped'
    })
    publishHealthEvent(store, event('screen-capture-restored', 'info'), context)
    expect(store.snapshot()[0].state).toBe('resolved')
  })

  it('every condition a health event opens ends with its session', () => {
    for (const [code, row] of Object.entries(HEALTH_KINDS)) {
      if (row.effect !== 'open') continue
      store.reset()
      publishHealthEvent(store, event(code), context)
      expect(store.snapshot()[0].sessionId, code).toBe('live')
      store.sessionEnded('livestream', 'live')
      expect(store.snapshot()[0].state, code).toBe('resolved')
    }
  })

  it('leaves the codes that need their own function, the silent ones and unknown ones alone', () => {
    for (const code of [
      'microphone-input-lost',
      'microphone-timeline-lost',
      'microphone-silent',
      'system-audio-lost',
      'recording-quality-not-100',
      'recording-startup-barrier-timeout',
      'stream-dropped-frames',
      'live-background-gpu-budget',
      'watchdog-mic-muted',
      'watchdog-destination-down-cleared',
      'a-code-from-the-future'
    ]) {
      expect(publishHealthEvent(store, event(code), context), code).toBe(false)
    }
    expect(store.snapshot()).toEqual([])
    expect(healthKindFor('watchdog-anything')).toMatchObject({ effect: 'ignore' })
    expect(healthKindFor('stream-dropped-frames')).toMatchObject({ effect: 'ignore' })
    expect(healthKindFor('a-code-from-the-future')).toBeNull()
  })
})
