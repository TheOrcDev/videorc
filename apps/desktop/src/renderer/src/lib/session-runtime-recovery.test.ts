import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastSpies = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { ...toastSpies, dismiss: vi.fn() } }))

import { ENGINE_NOT_CONNECTED } from '@/backendClient'
import type { HealthEvent, SessionSummary } from '@/lib/backend'
import { notifications } from '@/lib/notifications'
import { sessionRuntimeNoticeTitle } from '@/lib/session-runtime-notice'
import {
  completeSessionRuntimeRecovery,
  microphoneLossPresentation,
  recordingFailurePresentation,
  recoverSessionRuntime,
  sessionModeActivity,
  sessionRuntimeContinuationIsCurrent,
  sessionRuntimeRecoveryPlan,
  noteBackgroundError,
  showBackendError,
  showMicrophoneLoss,
  showOAuthCallbackExhausted,
  showOAuthCallbackResult,
  showRecordingFailure,
  showSessionFinished,
  showSessionHealthEvent,
  showSourceFallbackActiveSession,
  showXPlaybackEvent,
  sourceFallbackTitle
} from '@/lib/session-runtime-recovery'

// These reports arrive while a recording runs, with "Quiet while recording or
// live" off. Since the owner's rule only an urgent problem or a press's
// answer pops up there; a warning waits behind the bell, as it does idle.
notifications.configure({ live: () => true, quiet: () => false })

function failedSession(mode: string): SessionSummary {
  return {
    id: 'failed-session',
    title: 'Failed session',
    startedAt: '2026-08-25T10:00:00.000Z',
    status: 'failed',
    mode,
    outputPath: '/recordings/failed-session.mkv',
    healthEventCount: 1,
    sessionLogCount: 1,
    aiArtifactCount: 0,
    commentCount: 0
  }
}

describe('session runtime recovery', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    vi.clearAllMocks()
    notifications.reset()
  })

  it('keeps combined record-and-stream failures attached to the local recording', () => {
    const summary = failedSession('record+stream')
    const recording = { state: 'failed' as const, sessionId: summary.id }
    const plan = sessionRuntimeRecoveryPlan({
      recording,
      sessions: [summary],
      priorSessionId: summary.id,
      priorSessionState: 'recording'
    })

    const recovery = completeSessionRuntimeRecovery({
      plan,
      recording,
      events: [],
      priorSessionState: 'recording'
    })
    // Plan 174 B-6: on air, so the notice says "livestream"; it saved a
    // file, so it keeps Open Library and the reveal.
    expect(recovery).toMatchObject({ kind: 'recording-failed', activity: 'record+stream' })
    if (recovery?.kind !== 'recording-failed') throw new Error('Missing recovered failure')
    const presentation = recordingFailurePresentation({
      status: recovery.status,
      activity: recovery.activity,
      currentDedupeKey: null
    })!
    expect(presentation.notice.message).toBe("Videorc couldn't finish this livestream.")
    expect(sessionRuntimeNoticeTitle(presentation.notice)).toBe('Livestream stopped unexpectedly')

    vi.stubGlobal('window', { videorc: { revealSession: vi.fn() } })
    try {
      showRecordingFailure(presentation)
    } finally {
      vi.unstubAllGlobals()
    }
    // Plan 250: an urgent entry behind the bell with both ways out, and one
    // 15 s toast; nothing pinned.
    expect(
      notifications.snapshot().find((item) => item.key === `recording-failed:${summary.id}`)
    ).toMatchObject({
      tone: 'urgent',
      title: 'Livestream stopped unexpectedly',
      detail: "Videorc couldn't finish this livestream.",
      actions: [
        { id: 'open-library', label: 'Open in Library', kind: 'door' },
        { id: 'reveal', kind: 'fix' }
      ]
    })
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Livestream stopped unexpectedly',
      expect.objectContaining({
        duration: 15_000,
        action: expect.objectContaining({ label: 'Open in Library' })
      })
    )
  })

  it('a take that died on a full disk is one entry, whichever report arrives first', () => {
    const diskFull: HealthEvent = {
      id: 'disk',
      code: 'recording-disk-full',
      level: 'error',
      sessionId: 'take',
      message:
        'The recordings folder ran out of space, so recording stopped. The recording up to that point is kept. Free some space before you record again. (FFmpeg exit: exit status: 228)',
      createdAt: '2026-11-19T10:00:00Z'
    }
    showSessionHealthEvent(diskFull, false, { sessionId: 'take', state: 'recording' })
    vi.stubGlobal('window', { videorc: {} })
    try {
      showRecordingFailure(
        recordingFailurePresentation({
          status: { state: 'failed', sessionId: 'take', message: diskFull.message },
          activity: 'recording',
          currentDedupeKey: null
        })!
      )
    } finally {
      vi.unstubAllGlobals()
    }
    expect(notifications.snapshot()).toHaveLength(1)
    // Videorc's own words: the backend's line ends in an FFmpeg exit code.
    expect(notifications.snapshot()[0]).toMatchObject({
      key: 'recording-failed:take',
      tone: 'urgent',
      title: 'Recording stopped: the recordings folder is full',
      detail: 'The recording up to that point is kept. Free some space before you record again.',
      occurrences: 1,
      actions: [{ label: 'Open Output' }, { label: 'Open in Library' }]
    })
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
  })

  it('rejects lazy continuations from an old epoch or a different session', () => {
    expect(sessionRuntimeContinuationIsCurrent(4, 4, 'session-a', 'session-a')).toBe(true)
    expect(sessionRuntimeContinuationIsCurrent(4, 5, 'session-a', 'session-a')).toBe(false)
    expect(sessionRuntimeContinuationIsCurrent(4, 4, 'session-a', 'session-b')).toBe(false)
  })

  it('does not recover a prior failure over a different session that is stopping', () => {
    const prior = failedSession('record')
    const replacement = {
      ...failedSession('record'),
      id: 'replacement-session',
      title: 'Replacement session',
      status: 'running' as const,
      outputPath: '/recordings/replacement-session.mkv',
      healthEventCount: 0
    }
    const recording = { state: 'stopping' as const, sessionId: replacement.id }
    const plan = sessionRuntimeRecoveryPlan({
      recording,
      sessions: [prior, replacement],
      priorSessionId: prior.id,
      priorSessionState: 'recording'
    })

    expect(plan.failureSessionId).toBeUndefined()
    expect(
      completeSessionRuntimeRecovery({
        plan,
        recording,
        events: [],
        priorSessionState: 'recording'
      })
    ).toBeNull()
  })

  it('preserves X playback notification severity in the lazy presentation chunk', () => {
    showXPlaybackEvent({
      broadcastId: 'broadcast-1',
      shareUrl: 'https://x.com/i/broadcasts/1',
      status: 'verified'
    })
    showXPlaybackEvent({
      broadcastId: 'broadcast-1',
      shareUrl: 'https://x.com/i/broadcasts/1',
      status: 'pending'
    })
    showXPlaybackEvent({
      broadcastId: 'broadcast-1',
      shareUrl: 'https://x.com/i/broadcasts/1',
      status: 'unavailable'
    })

    expect(toastSpies.success).toHaveBeenCalledTimes(1)
    // "X is still preparing your stream" is a warning: the bell, even live.
    expect(toastSpies.warning).not.toHaveBeenCalled()
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    // `unavailable` means X ended the broadcast: X's API gives no playback
    // URL any more, so there is nothing else to "show".
    expect(toastSpies.error).toHaveBeenCalledWith(
      'X ended your broadcast',
      expect.objectContaining({
        description: expect.stringContaining('Your local recording is unaffected.')
      })
    )
  })

  it('preserves OAuth callback success and failure notifications in the lazy chunk', () => {
    const result = {
      state: 'oauth-state',
      status: 'success' as const,
      codePresent: true,
      tokenStored: true,
      accountConnected: true,
      retryable: false,
      receivedAt: '2026-08-25T14:00:00.000Z'
    }
    showOAuthCallbackResult(result)
    showOAuthCallbackResult({
      ...result,
      status: 'failed',
      tokenStored: false,
      accountConnected: false,
      message: 'Authorization was declined.'
    })

    // No platform on the result: the generic words and the shared fallback id.
    expect(toastSpies.success).toHaveBeenCalledWith('Account connected', {
      id: 'oauth-callback:provider'
    })
    expect(toastSpies.error).toHaveBeenCalledWith("Couldn't finish connecting the account", {
      id: 'oauth-callback:provider',
      description: 'Authorization was declined.',
      duration: 8_000,
      action: expect.objectContaining({ label: 'Copy' })
    })
  })

  // Plan 094 (S3): repeated callback results for one platform share an id, so
  // the renderer's retries update one toast; a YouTube quota block says when
  // to try again, in local time; the exhaust toast lands on the same id.
  it.each([
    [12, ''],
    [23, 'tomorrow ']
  ] as const)('keeps one YouTube quota connect toast from local hour %i', (hour, dayLabel) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 2, hour, 0, 0))
    const retryAt = new Date(Date.now() + 3 * 60 * 60_000)
    const base = {
      platform: 'youtube' as const,
      state: 'state-1',
      status: 'failed' as const,
      codePresent: true,
      tokenStored: false,
      accountConnected: false,
      retryable: true,
      receivedAt: '2026-10-02T13:00:00.000Z',
      message: 'OAuth account preparation failed and will be retried: HTTP 503'
    }
    showOAuthCallbackResult(base)
    showOAuthCallbackResult(base)
    showOAuthCallbackResult({
      ...base,
      retryable: false,
      reason: 'youtube-quota',
      retryAt: retryAt.toISOString(),
      message: 'ignored: the renderer words quota itself'
    })
    showOAuthCallbackExhausted()
    expect(toastSpies.error).toHaveBeenCalledTimes(4)
    const ids = new Set(toastSpies.error.mock.calls.map((call) => (call[1] as { id: string }).id))
    expect([...ids]).toEqual(['oauth-callback:youtube'])
    expect(toastSpies.error.mock.calls[2][0]).toBe("Couldn't finish connecting YouTube")
    expect(toastSpies.error.mock.calls[2][1]).toMatchObject({
      description: `Couldn't finish connecting YouTube. Videorc's daily YouTube API limit is used up. Try again after ${dayLabel}${retryAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`
    })
    expect(toastSpies.error.mock.calls[3][0]).toBe("Couldn't finish connecting YouTube")
  })
})

describe('audio-loss provenance', () => {
  const event = (code: string, message: string): HealthEvent => ({
    id: code,
    code,
    message,
    sessionId: 'take',
    level: 'warn',
    createdAt: '2026-09-28T09:34:41Z'
  })
  it('keeps system and microphone timeline failures in one persistent notice', () => {
    const base = {
      recording: { state: 'recording' as const, sessionId: 'take' },
      lastActivity: 'recording' as const,
      currentDedupeKey: null
    }
    const system = microphoneLossPresentation({
      ...base,
      event: event('system-audio-lost', 'System samples were lost.')
    })!
    const mixed = microphoneLossPresentation({
      ...base,
      currentDedupeKey: system.dedupeKey,
      currentNotice: system.notice,
      event: event('microphone-timeline-lost', 'Microphone samples could not be placed.')
    })!
    expect(mixed.notice.audioIssues).toHaveLength(2)
    expect(mixed.notice.message).toContain('System samples')
    expect(mixed.notice.message).toContain('Microphone samples')
    expect(sessionRuntimeNoticeTitle(mixed.notice)).toBe('Microphone and system audio lost')
    expect(
      microphoneLossPresentation({
        ...base,
        currentDedupeKey: mixed.dedupeKey,
        currentNotice: mixed.notice,
        event: event('system-audio-lost', 'duplicate')
      })
    ).toBeNull()
  })
  it('does not describe arriving but rejected microphone samples as a device stopping', () => {
    const result = microphoneLossPresentation({
      event: event('microphone-timeline-lost', 'Could not place samples.'),
      recording: { state: 'idle' },
      lastSessionId: 'take',
      lastActivity: 'recording',
      currentDedupeKey: null
    })!
    expect(sessionRuntimeNoticeTitle(result.notice)).toBe(
      "Microphone audio couldn't be recorded: saved session has missing audio"
    )
  })
  // Issue 1064: the microphone never stopped; its frames hold no sound.
  it('says the microphone is silent, per activity, and ends the notice honestly', () => {
    const message =
      "HD Pro Webcam C920 is sending only silence. Check its own mute button or switch, and its cable. If it's still silent, choose it again."
    const recording = microphoneLossPresentation({
      event: event('microphone-silent', message),
      recording: { state: 'recording' as const, sessionId: 'take' },
      lastActivity: 'recording' as const,
      currentDedupeKey: null
    })!
    expect(sessionRuntimeNoticeTitle(recording.notice)).toBe(
      'Your microphone is silent in the recording'
    )
    expect(recording.notice.message).toBe(message)
    expect(recording.notice.audioIssues).toEqual([{ code: 'microphone-silent', message }])
    const live = microphoneLossPresentation({
      event: event('microphone-silent', message),
      recording: { state: 'streaming' as const, sessionId: 'take' },
      lastActivity: 'live-stream' as const,
      currentDedupeKey: null
    })!
    expect(sessionRuntimeNoticeTitle(live.notice)).toBe(
      'Your microphone is silent on the livestream'
    )
    const clips = microphoneLossPresentation({
      event: event('microphone-silent', message),
      recording: { state: 'recording' as const, sessionId: 'take', replayOnly: true },
      lastActivity: 'recording' as const,
      currentDedupeKey: null
    })!
    expect(sessionRuntimeNoticeTitle(clips.notice)).toBe('Your microphone is silent in Clips')
    expect(sessionRuntimeNoticeTitle({ ...recording.notice, phase: 'ended' })).toBe(
      'Microphone was silent: saved recording contains silence'
    )
    expect(sessionRuntimeNoticeTitle({ ...live.notice, phase: 'ended' })).toBe(
      'Microphone was silent during the livestream'
    )
    // Reported once per run: the same silence never stacks a second notice.
    expect(
      microphoneLossPresentation({
        event: event('microphone-silent', message),
        recording: { state: 'recording' as const, sessionId: 'take' },
        lastActivity: 'recording' as const,
        currentDedupeKey: recording.dedupeKey,
        currentNotice: recording.notice
      })
    ).toBeNull()
  })
})

it('recovers both audio sources after reconnect without dropping either explanation', () => {
  const event = (code: string, message: string): HealthEvent => ({
    id: code,
    code,
    message,
    sessionId: 'take',
    level: 'warn',
    createdAt: '2026-09-28T09:34:41Z'
  })
  const recovery = completeSessionRuntimeRecovery({
    plan: { healthSessionId: 'take' },
    recording: { state: 'recording', sessionId: 'take' },
    priorSessionState: 'recording',
    events: [
      event('system-audio-lost', 'System samples lost.'),
      event('microphone-timeline-lost', 'Microphone placement failed.')
    ]
  })
  expect(recovery?.kind).toBe('microphone-input-lost')
  if (recovery?.kind !== 'microphone-input-lost') throw new Error('Missing recovered audio notice')
  const presentation = microphoneLossPresentation({
    event: recovery.event,
    recording: { state: 'recording', sessionId: 'take' },
    lastActivity: 'recording',
    currentDedupeKey: null
  })!
  expect(sessionRuntimeNoticeTitle(presentation.notice)).toBe('Microphone and system audio lost')
  expect(presentation.notice.message).toContain('System samples lost.')
  expect(presentation.notice.message).toContain('Microphone placement failed.')
  expect(
    microphoneLossPresentation({
      event: event('system-audio-lost', 'Duplicate'),
      recording: { state: 'recording', sessionId: 'take' },
      lastActivity: 'recording',
      currentDedupeKey: presentation.dedupeKey,
      currentNotice: presentation.notice
    })
  ).toBeNull()
})

it('a loss that a later recovery of the same source ended is not brought back', () => {
  const event = (code: string): HealthEvent => ({
    id: code,
    code,
    message: code,
    sessionId: 'take',
    level: 'warn',
    createdAt: '2026-09-28T09:34:41Z'
  })
  const recover = (codes: string[]): ReturnType<typeof completeSessionRuntimeRecovery> =>
    completeSessionRuntimeRecovery({
      plan: { healthSessionId: 'take' },
      recording: { state: 'recording', sessionId: 'take' },
      priorSessionState: 'recording',
      events: codes.map(event)
    })
  // A reconnect had reopened this as an urgent microphone problem.
  expect(recover(['microphone-input-lost', 'microphone-input-recovered'])).toBeNull()
  // Another source's recovery, or disk space, ends nothing here.
  expect(
    recover(['microphone-input-lost', 'system-audio-recovered', 'disk-space-recovered'])
  ).toMatchObject({ kind: 'microphone-input-lost', event: { code: 'microphone-input-lost' } })
  // Lost again after it came back: open.
  expect(
    recover(['microphone-timeline-lost', 'microphone-timeline-recovered', 'microphone-input-lost'])
  ).toMatchObject({ event: { code: 'microphone-input-lost' } })
  // Two sources lost, one back: only the other is told.
  expect(
    recover(['system-audio-lost', 'microphone-input-lost', 'microphone-input-recovered'])
  ).toMatchObject({ event: { code: 'system-audio-lost' } })
})

// Plan 250 S5: a session's `health` event is an entry behind the bell, on its
// subject. Idle (as here) a warning also pops up for 8 s and an urgent one
// for 15 s; nothing is pinned. `notifications/sources/health.test.ts` walks
// every code; these are the stories the old toasts told.
describe('session health events are notifications (plans 076, 087, 218, 250)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notifications.reset()
  })

  function healthEvent(code: string, level: HealthEvent['level'] = 'warn'): HealthEvent {
    return {
      id: code,
      sessionId: 'live',
      level,
      code,
      message: `${code} message`,
      createdAt: '2026-09-28T14:03:44.000Z'
    }
  }
  const entry = (key: string) => notifications.snapshot().find((item) => item.key === key)
  const durations = (spy: ReturnType<typeof vi.fn>): unknown[] =>
    spy.mock.calls.map((call) => (call[1] as { duration?: number }).duration)

  it('pauses on an echo with a Resume that asks the Studio to turn System audio on', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    try {
      showSessionHealthEvent(healthEvent('system-audio-echo-paused'), false)
      expect(entry('system-audio-echo')).toMatchObject({
        state: 'open',
        tone: 'warning',
        title: 'System audio paused: your stream was echoing',
        detail: 'system-audio-echo-paused message',
        actions: [
          { id: 'resume', label: 'Resume', kind: 'fix' },
          { id: 'open-sources', label: 'Open Sources', kind: 'door' }
        ]
      })
      // A warning Videorc found on its own: the entry, never a toast, even
      // live with quiet off (the owner's rule).
      expect(toastSpies.warning).not.toHaveBeenCalled()
      await notifications.runAction('system-audio-echo', 'resume')
      expect(dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'videorc:resume-system-audio' })
      )
      // The press resolves the entry: the backend sends no code for it.
      await vi.waitFor(() =>
        expect(entry('system-audio-echo')).toMatchObject({
          state: 'resolved',
          title: 'System audio is back on'
        })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('counts short blips on one entry each, and never pops them up', () => {
    const silenced = healthEvent('microphone-noise-reduction-silenced')
    showSessionHealthEvent(silenced, false)
    showSessionHealthEvent(silenced, false)
    showSessionHealthEvent(silenced, false)
    showSessionHealthEvent(healthEvent('audio-output-stalled'), false)
    expect(entry('microphone-blip')).toMatchObject({
      tone: 'news',
      title: 'Microphone silenced for a moment',
      occurrences: 3,
      detail: '3 times. microphone-noise-reduction-silenced message'
    })
    expect(entry('audio-blip')).toMatchObject({ title: 'Audio dropped for a moment' })
    expect(toastSpies.warning).not.toHaveBeenCalled()
    expect(notifications.count().unread).toBe(0)
  })

  it('a silent microphone is one entry that the recovery resolves (issue 1064, retest 151)', () => {
    showSessionHealthEvent(healthEvent('mic-silent'), false)
    expect(entry('microphone')).toMatchObject({
      tone: 'warning',
      title: 'Microphone is silent',
      actions: [{ label: 'Open Audio', kind: 'door' }]
    })
    showSessionHealthEvent(healthEvent('mic-silent', 'error'), false)
    expect(entry('microphone')).toMatchObject({ tone: 'urgent', title: 'Recording has no sound' })
    showSessionHealthEvent(healthEvent('microphone-signal-recovered'), false)
    expect(notifications.snapshot()).toHaveLength(1)
    expect(entry('microphone')).toMatchObject({
      state: 'resolved',
      title: 'Your microphone has sound again'
    })
    // A recovery never pops up on its own: it only takes the place of the
    // problem's toast while that is still on screen.
    expect(toastSpies.success).toHaveBeenCalledTimes(1)
    expect(durations(toastSpies.success)).toEqual([4_000])
  })

  it('a recovery for a microphone nobody reported lost changes nothing', () => {
    showSessionHealthEvent(healthEvent('microphone-input-recovered'), false)
    showSessionHealthEvent(healthEvent('microphone-timeline-recovered'), false)
    expect(notifications.snapshot()).toEqual([])
    expect(toastSpies.success).not.toHaveBeenCalled()
  })

  it('says the stream stopped, urgently, without pinning a toast', () => {
    showSessionHealthEvent(healthEvent('stream-output-failed', 'error'), false)
    expect(entry('stream-output')).toMatchObject({
      tone: 'urgent',
      state: 'happened',
      title: 'Your stream stopped',
      detail: 'stream-output-failed message',
      actions: [{ label: 'Open Health', kind: 'door' }]
    })
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Your stream stopped',
      expect.objectContaining({ id: 'notification:stream-output', duration: 15_000 })
    )
  })

  it('says the take is silent, and that the recording stopped, each as an urgent entry', () => {
    showSessionHealthEvent(healthEvent('audio-output-failed', 'error'), false)
    showSessionHealthEvent(healthEvent('recording-output-failed', 'error'), false)
    expect(entry('audio-output')).toMatchObject({
      tone: 'urgent',
      title: 'Your recording has no sound from here'
    })
    expect(entry('recording-output')).toMatchObject({
      tone: 'urgent',
      title: 'Your recording stopped'
    })
    expect(durations(toastSpies.error)).toEqual([15_000, 15_000])
  })

  it('a frozen stream that moves again is one entry, resolved', () => {
    showSessionHealthEvent(healthEvent('stream-output-stalled'), false)
    expect(entry('stream-output')).toMatchObject({ tone: 'urgent', title: 'Your stream is frozen' })
    showSessionHealthEvent(healthEvent('stream-output-resumed', 'info'), false)
    expect(notifications.snapshot()).toHaveLength(1)
    expect(entry('stream-output')).toMatchObject({
      state: 'resolved',
      title: 'Your stream is moving again',
      detail: 'It was frozen for 1 s.'
    })
  })

  it('a choppy stream is open until it is smooth again', () => {
    showSessionHealthEvent(healthEvent('stream-delivery-degraded'), false)
    expect(entry('stream-delivery')).toMatchObject({
      state: 'open',
      tone: 'warning',
      title: 'Your stream is choppy'
    })
    expect(notifications.count()).toEqual({ unread: 1, urgent: 0, tone: 'warning' })
    showSessionHealthEvent(healthEvent('stream-delivery-recovered', 'info'), false)
    expect(entry('stream-delivery')).toMatchObject({
      state: 'resolved',
      title: 'Your stream is smooth again'
    })
    // A warning that cleared on its own stops counting.
    expect(notifications.count()).toEqual({ unread: 0, urgent: 0, tone: null })
  })

  it('tells the connection story on one entry: overflow, step down, floor, back', () => {
    const titles: (string | undefined)[] = []
    for (const code of [
      'stream-leg-overflow',
      'stream-bitrate-lowered',
      'stream-bitrate-floor',
      'stream-bitrate-restored'
    ]) {
      showSessionHealthEvent(healthEvent(code), false)
      titles.push(entry('stream-uplink')?.title)
    }
    expect(titles).toEqual([
      'Your connection can’t keep up',
      'Stream quality lowered to fit your connection',
      'Your connection can’t carry this stream',
      'Stream quality is back'
    ])
    expect(notifications.snapshot()).toHaveLength(1)
    // One entry for the episode, and no pop-up: a warning waits behind the
    // bell, even live with quiet off.
    expect(toastSpies.warning).not.toHaveBeenCalled()
  })

  it('says once that a Screen file stopped, and that the Combined recording keeps going', () => {
    const event = {
      ...healthEvent('separate-source-recordings-role-failed'),
      sessionId: 'take',
      message: 'screen: the encoder stopped accepting frames'
    }
    showSessionHealthEvent(event, false, { sessionId: 'take', state: 'recording' })
    showSessionHealthEvent(event, false, { sessionId: 'take', state: 'recording' })
    const file = entry('separate-file:take:screen')
    expect(file).toMatchObject({
      tone: 'warning',
      title: 'Screen file stopped',
      occurrences: 1,
      actions: [{ label: 'Open Health', kind: 'door' }]
    })
    expect(file?.detail).toContain('Your Combined recording keeps going.')
  })

  it('says once per take that the separate files stopped so the main recording keeps up', () => {
    const event = { ...healthEvent('separate-source-recordings-shed'), sessionId: 'take' }
    showSessionHealthEvent(event, false)
    showSessionHealthEvent(event, false)
    expect(entry('separate-files-shed:take')).toMatchObject({
      title: 'Separate files stopped so the main recording keeps up',
      occurrences: 1
    })
    expect(notifications.snapshot()).toHaveLength(1)
  })

  it('reports a stopped screen capture by severity, a window out of sight, and their return', () => {
    showSessionHealthEvent(healthEvent('screen-capture-stopped'), false)
    expect(entry('screen-capture')).toMatchObject({
      tone: 'warning',
      title: 'Screen capture stopped',
      actions: [{ label: 'Open Sources' }]
    })
    showSessionHealthEvent(healthEvent('screen-capture-stopped', 'error'), false)
    expect(entry('screen-capture')?.tone).toBe('urgent')
    showSessionHealthEvent(healthEvent('screen-capture-restored', 'info'), false)
    expect(entry('screen-capture')).toMatchObject({
      state: 'resolved',
      title: 'Screen capture is back'
    })

    notifications.reset()
    showSessionHealthEvent(healthEvent('screen-window-out-of-sight'), false)
    expect(entry('screen-capture')).toMatchObject({ title: 'Window out of sight', state: 'open' })
    showSessionHealthEvent(healthEvent('screen-window-back', 'info'), false)
    expect(entry('screen-capture')).toMatchObject({
      state: 'resolved',
      title: 'The window is back'
    })
  })

  it('sends screen capture that lost its access to Permissions', () => {
    showSessionHealthEvent(
      { ...healthEvent('screen-capture-stopped', 'error'), permissionPane: 'screen-recording' },
      false
    )
    expect(entry('screen-capture')?.actions).toEqual([
      { id: 'open-permissions', label: 'Open Permissions', kind: 'door' }
    ])
  })

  it('an overloaded computer and low recording space are open entries, not toasts that stack', () => {
    showSessionHealthEvent(healthEvent('host-overloaded'), false)
    showSessionHealthEvent(healthEvent('host-overloaded'), false)
    showSessionHealthEvent(healthEvent('disk-space-low'), false)
    expect(entry('host-overloaded')).toMatchObject({
      state: 'open',
      title: 'This computer is overloaded',
      actions: []
    })
    expect(entry('disk-space')).toMatchObject({
      state: 'open',
      title: 'Recording space is low',
      actions: [{ label: 'Open Output' }]
    })
    expect(notifications.snapshot()).toHaveLength(2)
    // Both wait behind the bell (the owner's rule).
    expect(toastSpies.warning).not.toHaveBeenCalled()
  })

  it('the first-seconds notice holds for the session; a refused start stays a toast', () => {
    showSessionHealthEvent(healthEvent('recording-startup-cadence-unsteady'), false)
    expect(entry('session-notice:recording-startup-cadence-unsteady')).toMatchObject({
      state: 'open',
      title: 'The first seconds may stutter',
      sessionId: 'live'
    })
    notifications.reset()
    vi.clearAllMocks()
    showSessionHealthEvent(healthEvent('recording-startup-barrier-timeout', 'error'), false)
    // It answers Record or Go Live, so it is not a notification.
    expect(notifications.snapshot()).toEqual([])
    expect(toastSpies.error).toHaveBeenCalledWith(
      "Couldn't start",
      expect.objectContaining({ duration: Infinity })
    )
  })

  it('the Clips ring that could not start at launch is its entry, never "Couldn\'t start"', () => {
    showSessionHealthEvent(healthEvent('recording-startup-barrier-timeout', 'error'), false, {
      state: 'starting',
      sessionId: 'live',
      replayOnly: true
    })
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(entry('clips')).toMatchObject({ title: "Clips couldn't start", tone: 'warning' })
  })

  it('a quality notice is one entry per recording, with the way to its row', () => {
    const event = { ...healthEvent('recording-quality-not-100'), sessionId: 'take' }
    expect(showSessionHealthEvent(event, false)).toBe('take')
    expect(showSessionHealthEvent(event, true)).toBeNull()
    expect(entry('recording-quality:take')).toMatchObject({
      title: 'This recording has dropped frames',
      actions: [{ label: 'Open in Library', kind: 'door' }]
    })
    expect(showSessionHealthEvent(healthEvent('recording-quality-ok', 'info'), false)).toBeNull()
  })

  it('keeps the watchdog history codes and the per-frame codes silent', () => {
    for (const code of [
      'watchdog-mic-muted',
      'watchdog-mic-muted-cleared',
      'stream-dropped-frames',
      'live-background-gpu-budget',
      'some-new-code'
    ]) {
      showSessionHealthEvent(healthEvent(code), false)
    }
    expect(notifications.snapshot()).toEqual([])
  })
})

describe('record+stream notices (plan 174 B-6)', () => {
  const goLive = {
    state: 'recording' as const,
    sessionId: 'go-live',
    streamUrl: 'rtmp://127.0.0.1/live/***'
  }
  const microphoneLost: HealthEvent = {
    id: 'mic-lost',
    code: 'microphone-input-lost',
    message: 'The selected microphone stopped providing audio.',
    sessionId: 'go-live',
    level: 'warn',
    createdAt: '2026-10-10T10:00:00Z'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    notifications.reset()
  })

  it('says a microphone dropout during Go Live leaves the livestream silent', () => {
    const presentation = microphoneLossPresentation({
      event: microphoneLost,
      recording: goLive,
      lastActivity: 'recording',
      currentDedupeKey: null
    })!
    expect(presentation.activity).toBe('record+stream')
    expect(sessionRuntimeNoticeTitle(presentation.notice)).toBe(
      'Microphone stopped: livestream continues with silence'
    )

    const recordingOnly = microphoneLossPresentation({
      event: microphoneLost,
      recording: { state: 'recording', sessionId: 'go-live' },
      lastActivity: 'record+stream',
      currentDedupeKey: null
    })!
    expect(sessionRuntimeNoticeTitle(recordingOnly.notice)).toBe(
      'Microphone stopped: recording continues with silence'
    )
  })

  it('does not say a recording continues when only the Clips buffer runs', () => {
    const presentation = microphoneLossPresentation({
      event: microphoneLost,
      recording: { state: 'recording', sessionId: 'go-live', replayOnly: true },
      lastActivity: 'recording',
      currentDedupeKey: null
    })!
    expect(presentation.activity).toBe('clips')
    expect(sessionRuntimeNoticeTitle(presentation.notice)).toBe(
      'Microphone stopped: Clips continue with silence'
    )
    expect(sessionRuntimeNoticeTitle(presentation.notice)).not.toContain(
      'recording continues with silence'
    )
  })

  it('reads each stored session mode as what the session did', () => {
    expect(sessionModeActivity('record')).toBe('recording')
    expect(sessionModeActivity('imported')).toBe('recording')
    expect(sessionModeActivity('record+stream')).toBe('record+stream')
    expect(sessionModeActivity('stream')).toBe('live-stream')
    expect(sessionModeActivity('Streaming')).toBe('live-stream')
  })

  it('recovers a Go Live failure with no stored summary from the last status the Studio saw', () => {
    const recording = { state: 'failed' as const, sessionId: 'go-live' }
    const plan = { failureSessionId: 'go-live' }
    expect(
      completeSessionRuntimeRecovery({
        plan,
        recording,
        events: [],
        priorSessionState: 'recording',
        priorSessionActivity: 'record+stream'
      })
    ).toMatchObject({ kind: 'recording-failed', activity: 'record+stream' })
    // Without the sighting, the state alone still decides, as before.
    expect(
      completeSessionRuntimeRecovery({
        plan,
        recording,
        events: [],
        priorSessionState: 'recording'
      })
    ).toMatchObject({ activity: 'recording' })
  })

  it('ends the live stream news with the session (plans 218 and 250)', async () => {
    const { toast } = await import('sonner')
    notifications.reset()
    const choppy: HealthEvent = {
      id: 'choppy',
      code: 'stream-delivery-degraded',
      level: 'warn',
      sessionId: 'live',
      message: 'Viewers get 21 of 30 frames.',
      createdAt: '2026-10-10T10:00:00Z'
    }
    showSessionHealthEvent(choppy, false, { sessionId: 'live', state: 'streaming' })
    showSessionFinished({
      status: { state: 'idle' as const, sessionId: 'live' },
      activity: 'live-stream',
      currentNotice: null,
      replaceNotice: vi.fn()
    })
    // It stays in the list as what happened. A warning never popped up (only
    // urgent problems do), so there is no toast to take away.
    expect(notifications.snapshot()[0]).toMatchObject({
      key: 'stream-delivery',
      state: 'resolved',
      tone: 'news',
      title: 'Your stream is choppy',
      detail: 'Viewers get 21 of 30 frames. Ended with the livestream.'
    })
    expect(toast.dismiss).not.toHaveBeenCalledWith('notification:stream-delivery')
    expect(notifications.count().tone).toBeNull()
  })

  it('a microphone lost during the session ends with its ended words', () => {
    notifications.reset()
    const lost = microphoneLossPresentation({
      event: microphoneLost,
      recording: goLive,
      lastActivity: 'record+stream',
      currentDedupeKey: null
    })!
    showMicrophoneLoss(lost)
    expect(notifications.snapshot()[0]).toMatchObject({
      key: 'microphone',
      tone: 'urgent',
      state: 'open',
      actions: [{ label: 'Open Audio' }]
    })
    const replaceNotice = vi.fn()
    showSessionFinished({
      status: { state: 'idle' as const, sessionId: 'go-live' },
      activity: 'record+stream',
      currentNotice: lost.notice,
      replaceNotice
    })
    expect(replaceNotice).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ended' }))
    const ended = notifications.snapshot().find((item) => item.key === 'microphone')
    expect(ended).toMatchObject({ state: 'resolved', peakTone: 'urgent' })
    expect(ended?.title).toBe(sessionRuntimeNoticeTitle({ ...lost.notice, phase: 'ended' }))
    expect(ended?.detail).toContain('Ended with the livestream.')
    // An urgent problem that ended still counts until it has been seen.
    expect(notifications.count().unread).toBeGreaterThanOrEqual(1)
  })

  it('still announces the saved recording when Go Live ends, and never for stream-only', () => {
    const replaceNotice = vi.fn()
    const ended = { state: 'idle' as const, sessionId: 'go-live' }
    showSessionFinished({
      status: ended,
      activity: 'record+stream',
      currentNotice: null,
      replaceNotice
    })
    // Plan 250 (D13): an entry with both buttons, and a short toast while idle.
    expect(
      notifications.snapshot().find((item) => item.key === 'recording-saved:go-live')
    ).toMatchObject({
      tone: 'done',
      title: 'Recording saved',
      actions: [
        { id: 'play', label: 'Play', kind: 'fix' },
        { id: 'open-library', label: 'Open in Library', kind: 'door' }
      ]
    })
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Recording saved',
      expect.objectContaining({
        duration: 8_000,
        action: expect.objectContaining({ label: 'Play' })
      })
    )

    vi.clearAllMocks()
    notifications.reset()
    showSessionFinished({
      status: ended,
      activity: 'live-stream',
      currentNotice: null,
      replaceNotice
    })
    expect(toastSpies.success).not.toHaveBeenCalled()
    expect(notifications.snapshot()).toEqual([])
  })

  it('says a source changed while streaming during Go Live, naming the device', () => {
    showSourceFallbackActiveSession(goLive, {
      kind: 'automatic-source-fallback',
      sourceKind: 'camera',
      reason: 'unavailable-selected',
      previousName: 'Studio Cam',
      nextId: 'cam-2',
      nextName: 'FaceTime HD Camera'
    })
    expect(
      notifications.snapshot().find((item) => item.key === 'source-fallback:camera')
    ).toMatchObject({
      tone: 'warning',
      title: 'Camera switched to FaceTime HD Camera',
      detail: 'Your stream uses it now. Check the output before you continue.',
      actions: [{ label: 'Open Sources', kind: 'door' }]
    })
    showSourceFallbackActiveSession({ state: 'recording' })
    expect(
      notifications.snapshot().find((item) => item.key === 'source-fallback:source')
    ).toMatchObject({
      title: 'A source changed',
      detail: 'Your recording uses it now. Check the output before you continue.'
    })
  })

  it('names the source a fallback turned off (plan 174 S2.4)', () => {
    expect(
      sourceFallbackTitle({
        kind: 'automatic-source-fallback',
        sourceKind: 'microphone',
        reason: 'unavailable-cleared',
        previousName: 'USB Mic'
      })
    ).toBe('Microphone turned off')
  })
})

// Plan 174 S3.18 (D9): a failure Videorc can't explain says "export a support
// bundle from Health", so its toast opens Health; a known cause doesn't.
// Plan 250 S9: a `health` event is sent once. A renderer that reloads
// mid-stream rebuilds the session's open problems from its stored events.
describe('the rebuild after a reload mid-session (plan 250 S9)', () => {
  const stored = (code: string, second: number): HealthEvent => ({
    id: `${code}-${second}`,
    code,
    level: 'warn',
    sessionId: 'live',
    message: `${code} message`,
    createdAt: new Date(Date.UTC(2026, 10, 19, 10, 0, second)).toISOString()
  })
  const running = (id: string): SessionSummary => ({
    ...failedSession('record+stream'),
    id,
    status: 'running',
    healthEventCount: 3
  })
  const events = [
    stored('stream-delivery-degraded', 10),
    stored('host-overloaded', 20),
    stored('stream-delivery-recovered', 30)
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    notifications.reset()
  })

  it('lists what is still open for the session that is running', async () => {
    const loadHealthEvents = vi.fn(async () => events)
    await recoverSessionRuntime({
      recording: { state: 'streaming', sessionId: 'live' },
      sessions: [running('live')],
      priorSessionState: 'idle',
      loadHealthEvents
    })
    expect(loadHealthEvents).toHaveBeenCalledWith('live')
    expect(notifications.snapshot()).toHaveLength(1)
    expect(notifications.snapshot()[0]).toMatchObject({
      key: 'host-overloaded',
      state: 'open',
      sessionId: 'live'
    })
  })

  it('rebuilds nothing for a session that is not running, or that failed', async () => {
    await recoverSessionRuntime({
      recording: { state: 'idle' },
      sessions: [running('live')],
      priorSessionId: 'live',
      priorSessionState: 'streaming',
      loadHealthEvents: async () => events
    })
    expect(notifications.snapshot()).toEqual([])
    await recoverSessionRuntime({
      recording: { state: 'failed', sessionId: 'live' },
      sessions: [{ ...running('live'), status: 'failed' }],
      priorSessionState: 'streaming',
      loadHealthEvents: async () => events
    })
    expect(notifications.snapshot().some((entry) => entry.key === 'host-overloaded')).toBe(false)
  })
})

describe('backend error toasts', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('a failure nobody pressed for is one counted entry behind the bell, not an error toast', () => {
    notifications.reset()
    noteBackgroundError(new Error('engine said no'), 'connected')
    noteBackgroundError(new Error('engine said no again'), 'connected')
    // Past the launch the store may pop the entry up once (plan 250); it is
    // never the error toast with its Copy, and never two.
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.warning.mock.calls.length).toBeLessThanOrEqual(1)
    const entries = notifications.snapshot()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'backend-error',
      occurrences: 2,
      actions: [{ label: 'Open Health', kind: 'door' }]
    })
  })

  it('a background failure while reconnecting adds nothing: the badge says so', () => {
    notifications.reset()
    noteBackgroundError(new Error(ENGINE_NOT_CONNECTED), 'connecting')
    expect(notifications.snapshot()).toEqual([])
  })

  it('gives an unexplained failure an Open Health door on a timed toast', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    showBackendError(new Error('engine said no'), 'connected', {
      action: 'save',
      object: 'the scene'
    })
    expect(toastSpies.error).toHaveBeenCalledOnce()
    const [title, options] = toastSpies.error.mock.calls[0]
    expect(title).toBe("Couldn't save the scene")
    expect(options).toMatchObject({
      description: 'Try again. If it keeps happening, export a support bundle from Health.',
      duration: 8_000,
      action: { label: 'Open Health' }
    })
    options.action.onClick()
    expect(dispatchEvent.mock.calls[0][0].detail).toEqual({ tab: 'diagnostics' })
  })

  it('keeps a known cause without the door', () => {
    const error = Object.assign(new Error('busy'), { code: 'command-lane-full' })
    showBackendError(error, 'connected', { action: 'save', object: 'the scene' })
    const [, options] = toastSpies.warning.mock.calls[0]
    expect(options.action).toBeUndefined()
  })
})
