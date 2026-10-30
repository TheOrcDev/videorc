import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastSpies = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { ...toastSpies, dismiss: vi.fn() } }))

import type { HealthEvent, SessionSummary } from '@/lib/backend'
import { sessionRuntimeNoticeTitle } from '@/lib/session-runtime-notice'
import {
  completeSessionRuntimeRecovery,
  microphoneLossPresentation,
  recordingFailurePresentation,
  sessionModeActivity,
  sessionRuntimeContinuationIsCurrent,
  sessionRuntimeRecoveryPlan,
  showBackendError,
  showOAuthCallbackExhausted,
  showOAuthCallbackResult,
  showRecordingFailure,
  showSessionFinished,
  showSessionHealthEvent,
  showSourceFallbackActiveSession,
  showXPlaybackEvent,
  sourceFallbackTitle
} from '@/lib/session-runtime-recovery'

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
  beforeEach(() => vi.clearAllMocks())

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
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Livestream stopped unexpectedly',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Open in Library' }),
        cancel: expect.objectContaining({ onClick: expect.any(Function) })
      })
    )
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
    expect(toastSpies.warning).toHaveBeenCalledTimes(1)
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
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

describe('session audio news (plan 076)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('keeps an echo pause up with a Resume that asks the Studio to turn System audio on', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    try {
      showSessionHealthEvent(healthEvent('system-audio-echo-paused'), false)
      expect(toastSpies.warning).toHaveBeenCalledWith(
        'System audio paused: your stream was echoing',
        expect.objectContaining({
          id: 'system-audio-echo-paused',
          description: 'system-audio-echo-paused message',
          duration: Infinity,
          action: expect.objectContaining({ label: 'Resume' })
        })
      )
      const options = toastSpies.warning.mock.calls[0][1] as { action: { onClick: () => void } }
      options.action.onClick()
      expect(dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'videorc:resume-system-audio' })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a stalled output and a recovered microphone once each', () => {
    showSessionHealthEvent(healthEvent('audio-output-stalled'), false)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Audio dropped for a moment',
      expect.objectContaining({ description: 'audio-output-stalled message' })
    )
    showSessionHealthEvent(healthEvent('microphone-timeline-recovered', 'info'), false)
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Microphone is back',
      expect.objectContaining({ description: 'microphone-timeline-recovered message' })
    )
    showSessionHealthEvent(healthEvent('system-audio-recovered', 'info'), false)
    expect(toastSpies.success).toHaveBeenCalledTimes(1)
  })

  it('says the microphone is back after a stopped input was opened again (retest 151)', () => {
    showSessionHealthEvent(healthEvent('microphone-input-recovered', 'info'), false)
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Microphone is back',
      expect.objectContaining({ description: 'microphone-input-recovered message' })
    )
  })

  it('says the stream stopped when it stops, and keeps saying it', () => {
    showSessionHealthEvent(healthEvent('stream-output-failed', 'error'), false)
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Your stream stopped',
      expect.objectContaining({
        id: 'stream-output',
        description: 'stream-output-failed message',
        duration: Infinity
      })
    )
  })

  it('replaces a frozen-stream warning with the news that it resumed', () => {
    showSessionHealthEvent(healthEvent('stream-output-stalled'), false)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Your stream is frozen',
      expect.objectContaining({ id: 'stream-output', duration: Infinity })
    )
    showSessionHealthEvent(healthEvent('stream-output-resumed', 'info'), false)
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Your stream is moving again',
      expect.objectContaining({ id: 'stream-output' })
    )
  })

  it('says once that a Screen file stopped, and that the Combined recording keeps going', () => {
    // Plan 198 (D1): the role-failed event rides the Combined session.
    const event = {
      ...healthEvent('separate-source-recordings-role-failed'),
      message: 'Screen capture failed after source recovery'
    }
    expect(showSessionHealthEvent(event, false, { sessionId: 'live', state: 'recording' })).toBe(
      null
    )
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Screen file stopped',
      expect.objectContaining({
        description:
          "The screen stopped sending video and couldn't be restarted. Your Combined recording keeps going.",
        action: expect.objectContaining({ label: 'Open Health' })
      })
    )
    const [, first] = toastSpies.warning.mock.calls[0] as [string, { id: string }]
    showSessionHealthEvent(event, false, { sessionId: 'live', state: 'recording' })
    const [, second] = toastSpies.warning.mock.calls[1] as [string, { id: string }]
    expect(second.id).toBe(first.id)
  })

  it('says once per take that the separate files stopped so the main recording keeps up', () => {
    // Plan 200 D1: the still-recording separate files stop together; one
    // toast, never one per file, and the copy names no roles.
    const event = healthEvent('separate-source-recordings-shed')
    expect(showSessionHealthEvent(event, false, { sessionId: 'live', state: 'recording' })).toBe(
      null
    )
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Separate files stopped so the main recording keeps up',
      expect.objectContaining({
        description:
          'Your Mac fell behind encoding the separate files. The separate files keep what they recorded, and your Combined recording keeps going.',
        action: expect.objectContaining({ label: 'Open Health' })
      })
    )
    const [, first] = toastSpies.warning.mock.calls[0] as [string, { id: string }]
    showSessionHealthEvent(event, false, { sessionId: 'live', state: 'recording' })
    const [, second] = toastSpies.warning.mock.calls[1] as [string, { id: string }]
    expect(second.id).toBe(first.id)
    // The raw backend sentence never reaches the toast.
    expect(JSON.stringify(toastSpies.warning.mock.calls)).not.toContain(event.message)
    expect(JSON.stringify(toastSpies.warning.mock.calls)).not.toMatch(/three|Screen|Camera/)
  })

  it('reports a stopped screen capture by severity, and its return', () => {
    showSessionHealthEvent(healthEvent('screen-capture-stopped'), false)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Screen capture stopped',
      expect.objectContaining({ id: 'screen-capture', duration: 20_000 })
    )
    showSessionHealthEvent(healthEvent('screen-capture-stopped', 'error'), false)
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Screen capture stopped',
      expect.objectContaining({ id: 'screen-capture', duration: Infinity })
    )
    showSessionHealthEvent(healthEvent('screen-capture-restored', 'info'), false)
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Screen capture is back',
      expect.objectContaining({ id: 'screen-capture' })
    )
  })

  it('warns once that the computer is overloaded', () => {
    showSessionHealthEvent(healthEvent('host-overloaded'), false)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'This computer is overloaded',
      expect.objectContaining({ id: 'host-overloaded', description: 'host-overloaded message' })
    )
  })

  it('warns at Record that little recording space is left', () => {
    showSessionHealthEvent(healthEvent('disk-space-low'), false)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Recording space is low',
      expect.objectContaining({
        id: 'disk-space-low',
        description: 'disk-space-low message',
        duration: 20_000
      })
    )
  })
})

// Plan 174 B-6: Go Live leaves recording on, and the backend reports that
// record+stream session as `recording` with a stream URL. Its notices speak of
// the livestream (the audience lost something) and keep the saved file's
// actions (it recorded too).
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

  beforeEach(() => vi.clearAllMocks())

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

  it('still announces the saved recording when Go Live ends, and never for stream-only', () => {
    const replaceNotice = vi.fn()
    const ended = { state: 'idle' as const, sessionId: 'go-live' }
    showSessionFinished({
      status: ended,
      activity: 'record+stream',
      currentNotice: null,
      replaceNotice
    })
    expect(toastSpies.success).toHaveBeenCalledWith('Recording saved', expect.anything())

    vi.clearAllMocks()
    showSessionFinished({
      status: ended,
      activity: 'live-stream',
      currentNotice: null,
      replaceNotice
    })
    expect(toastSpies.success).not.toHaveBeenCalled()
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
    expect(toastSpies.warning).toHaveBeenLastCalledWith(
      'Camera switched to FaceTime HD Camera',
      expect.objectContaining({
        id: 'source-reconciliation:active-session',
        description: 'Your stream uses it now. Check the output before you continue.'
      })
    )
    showSourceFallbackActiveSession({ state: 'recording' })
    expect(toastSpies.warning).toHaveBeenLastCalledWith(
      'A source changed',
      expect.objectContaining({
        description: 'Your recording uses it now. Check the output before you continue.'
      })
    )
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
describe('backend error toasts', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

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
