import { describe, expect, it } from 'vitest'

import type { WatchdogAlert } from '@/lib/backend'
import { streamHealthFact } from '@/lib/live-session-view'
import { statItems } from '@/lib/stream-manager-stats'
import { emptyLiveDashboardState } from '../../../shared/live-dashboard'
import {
  topWatchdogAlert,
  visibleWatchdogAlerts,
  watchdogChipLabel,
  watchdogClearedAlerts,
  watchdogClearedToast,
  watchdogHistory,
  watchdogHistorySpan,
  watchdogNotificationWords,
  watchdogNotifyCandidates,
  watchdogQuietedAlerts,
  watchdogToastId
} from '@/lib/watchdog-view'
import { watchdogCardVariant, watchdogQuietLabel } from '@/components/studio/watchdog-alert-card'

function alert(overrides: Partial<WatchdogAlert> & Pick<WatchdogAlert, 'check'>): WatchdogAlert {
  return {
    id: `watchdog:${overrides.check}:1`,
    severity: 'critical',
    state: 'open',
    since: '2026-11-08T12:04:00.000Z',
    title: 'Your microphone is muted on the livestream',
    detail: 'Muted for 0:42. Viewers hear no voice.',
    source: 'desktop',
    fixes: [{ kind: 'unmute', label: 'Unmute' }],
    ...overrides
  }
}

describe('watchdog view (plan 223 A5, A6)', () => {
  it('ranks the worst alert first and hides snoozed ones', () => {
    const notice = alert({
      check: 'brb-long',
      severity: 'notice',
      since: '2026-11-08T12:00:00.000Z'
    })
    const warning = alert({ check: 'destination-down', severity: 'warning', targetId: 'yt' })
    const snoozed = alert({ check: 'chat-says', severity: 'critical', state: 'snoozed' })
    const muted = alert({ check: 'mic-muted' })
    expect(visibleWatchdogAlerts([notice, snoozed, warning, muted]).map((a) => a.check)).toEqual([
      'mic-muted',
      'destination-down',
      'brb-long'
    ])
    expect(topWatchdogAlert([notice, warning])?.check).toBe('destination-down')
    expect(topWatchdogAlert([snoozed])).toBeNull()
  })

  it('names the top alert in the Stream fact row before any stage', () => {
    expect(streamHealthFact('healthy', null, alert({ check: 'mic-muted' }))).toEqual({
      label: 'Microphone muted',
      tone: 'warn'
    })
    expect(
      streamHealthFact(
        'choppy',
        { phase: 'hold', holdRemainingSeconds: 60 },
        alert({ check: 'mic-muted' })
      ).label
    ).toBe('Microphone muted')
    expect(streamHealthFact('healthy', null, null)).toEqual({ label: 'Healthy', tone: 'good' })
  })

  it('writes the chip in a few words and keys the toasts per check', () => {
    expect(watchdogChipLabel(alert({ check: 'mic-muted' }))).toBe('Microphone muted')
    expect(
      watchdogChipLabel(
        alert({ check: 'destination-down', title: 'YouTube has been down for 0:20' })
      )
    ).toBe('YouTube down')
    expect(
      watchdogChipLabel(
        alert({
          check: 'destination-down',
          title: 'Nobody is receiving your stream',
          targetId: 'all'
        })
      )
    ).toBe('Nobody receiving')
    expect(watchdogChipLabel(alert({ check: 'chat-says', targetId: 'lag' }))).toBe(
      'Chat says lagging'
    )
    expect(watchdogToastId(alert({ check: 'mic-muted' }))).toBe('watchdog:mic-muted')
    expect(watchdogToastId(alert({ check: 'destination-down', targetId: 'yt' }))).toBe(
      'watchdog:destination-down:yt'
    )
  })

  it('writes the system notification as the plan does', () => {
    expect(watchdogNotificationWords(alert({ check: 'mic-muted' }))).toEqual({
      title: 'Videorc: your microphone is muted',
      body: 'Muted for 0:42 on the livestream. Click to open the Studio.'
    })
    expect(
      watchdogNotificationWords(
        alert({
          check: 'picture-stopped',
          title: 'The picture has stopped',
          detail: 'No new frame has reached the stream for 0:05.'
        })
      )
    ).toEqual({
      title: 'Videorc: the picture has stopped',
      body: 'No new frame has reached the stream for 0:05. Click to open the Studio.'
    })
  })

  it('notifies on an open and on a repeat, never for a notice or still-there', () => {
    const muted = alert({ check: 'mic-muted' })
    expect(watchdogNotifyCandidates([], [muted]).map((a) => a.id)).toEqual([muted.id])
    expect(watchdogNotifyCandidates([muted], [muted])).toEqual([])
    const repeated = { ...muted, lastRepeatAt: '2026-11-08T12:09:00.000Z' }
    expect(watchdogNotifyCandidates([muted], [repeated]).length).toBe(1)
    expect(
      watchdogNotifyCandidates([], [alert({ check: 'brb-long', severity: 'notice' })])
    ).toEqual([])
    expect(
      watchdogNotifyCandidates([], [alert({ check: 'still-there', severity: 'warning' })])
    ).toEqual([])
    expect(watchdogClearedAlerts([muted], []).map((a) => a.id)).toEqual([muted.id])
    expect(watchdogClearedToast(muted)).toBe('Microphone unmuted')
    expect(
      watchdogClearedToast(
        alert({ check: 'destination-down', title: 'Streaming to Twitch stopped', targetId: 'tw' })
      )
    ).toBe('Twitch is back')
    expect(watchdogClearedToast(alert({ check: 'chat-says' }))).toBe('Chat has gone quiet about it')
  })

  it('never says "is back" for a withdrawn, snoozed or acknowledged alert (M2)', () => {
    const youtube = alert({
      check: 'destination-down',
      severity: 'warning',
      title: 'YouTube has been down for 0:20',
      targetId: 'youtube',
      id: 'watchdog:destination-down:youtube:1'
    })
    const twitch = alert({
      check: 'destination-down',
      severity: 'warning',
      title: 'Twitch has been down for 0:20',
      targetId: 'twitch',
      id: 'watchdog:destination-down:twitch:2'
    })
    const all = alert({
      check: 'destination-down',
      title: 'Nobody is receiving your stream',
      targetId: 'all',
      id: 'watchdog:destination-down:all:3'
    })
    // The fold: both per-leg ids leave, withdrawn; no "is back".
    const withdrawn = [youtube.id, twitch.id]
    expect(watchdogClearedAlerts([youtube, twitch], [all], withdrawn)).toEqual([])
    expect(watchdogQuietedAlerts([youtube, twitch], [all], withdrawn).map((a) => a.id)).toEqual(
      withdrawn
    )
    // A real recovery of one leg while the other stays down.
    expect(watchdogClearedAlerts([youtube, twitch], [twitch]).map((a) => a.id)).toEqual([
      youtube.id
    ])
    // "I meant to" keeps the card listed and hidden: the toast goes, quietly.
    const muted = alert({ check: 'mic-muted' })
    const meantTo = { ...muted, state: 'snoozed' as const, meantTo: true }
    expect(watchdogClearedAlerts([muted], [meantTo])).toEqual([])
    expect(watchdogQuietedAlerts([muted], [meantTo]).map((a) => a.id)).toEqual([muted.id])
    const seen = { ...muted, state: 'acknowledged' as const }
    expect(watchdogQuietedAlerts([muted], [seen]).map((a) => a.id)).toEqual([muted.id])
    expect(watchdogQuietedAlerts([seen], [seen])).toEqual([])
    // The session's end withdraws everything.
    expect(watchdogClearedAlerts([muted, all], [], [muted.id, all.id])).toEqual([])
  })

  it('gives every check its button set: the fix, then Got it or I meant to', () => {
    expect(watchdogQuietLabel({ check: 'mic-muted' })).toBe('I meant to')
    for (const check of [
      'program-silent',
      'picture-stopped',
      'destination-down',
      'chat-says'
    ] as const) {
      expect(watchdogQuietLabel({ check })).toBe('Got it')
    }
    expect(watchdogCardVariant({ severity: 'critical' })).toBe('destructive')
    expect(watchdogCardVariant({ severity: 'warning' })).toBe('warning')
    expect(watchdogCardVariant({ severity: 'notice' })).toBe('default')
  })

  it('puts the top alert on the Stream Manager session chip', () => {
    const dashboard = {
      ...emptyLiveDashboardState('2026-11-08T12:05:00.000Z'),
      sessionId: 's1',
      session: { state: 'live' as const, startedAt: '2026-11-08T12:00:00.000Z' },
      alerts: [alert({ check: 'mic-muted' })]
    }
    const [session] = statItems({
      sessionId: 's1',
      dashboard,
      viewerSample: null,
      messages: [],
      providers: [],
      nowMs: Date.parse('2026-11-08T12:05:00.000Z')
    })
    expect(session.id).toBe('session')
    expect(session.alert?.check).toBe('mic-muted')
    expect(session.tone).toBe('error')
    const [quiet] = statItems({
      sessionId: 's1',
      dashboard: { ...dashboard, alerts: [] },
      viewerSample: null,
      messages: [],
      providers: [],
      nowMs: Date.parse('2026-11-08T12:05:00.000Z')
    })
    expect(quiet.alert).toBeUndefined()
    expect(quiet.tone).toBe('neutral')
  })

  it('lists the session history from the watchdog health events', () => {
    const rows = watchdogHistory([
      {
        code: 'watchdog-mic-muted',
        message: 'Your microphone is muted on the livestream. Muted for 0:30.',
        createdAt: '2026-11-08T12:04:00.000Z'
      },
      {
        code: 'watchdog-mic-muted-acknowledged',
        message: 'x',
        createdAt: '2026-11-08T12:04:30.000Z'
      },
      {
        code: 'watchdog-mic-muted-cleared',
        message: 'Microphone unmuted',
        createdAt: '2026-11-08T12:04:52.000Z'
      },
      { code: 'stream-output-stalled', message: 'not ours', createdAt: '2026-11-08T12:05:00.000Z' },
      {
        code: 'watchdog-chat-says',
        message: "Chat says they can't hear you. 2 people",
        createdAt: '2026-11-08T12:06:00.000Z'
      }
    ])
    expect(rows.map((row) => [row.check, row.title, row.clearedAt !== null])).toEqual([
      ['mic-muted', 'Your microphone is muted on the livestream', true],
      ['chat-says', "Chat says they can't hear you", false]
    ])
    expect(watchdogHistorySpan(rows[0])).toMatch(/ to .* \(0:52\)$/)
    expect(watchdogHistorySpan(rows[1])).toMatch(/, still open$/)
  })
})
