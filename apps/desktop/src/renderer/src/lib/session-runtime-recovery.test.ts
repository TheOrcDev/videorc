import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  sessionRuntimeContinuationIsCurrent,
  sessionRuntimeRecoveryPlan,
  showOAuthCallbackResult,
  showSessionHealthEvent,
  showXPlaybackEvent
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

    expect(
      completeSessionRuntimeRecovery({
        plan,
        recording,
        events: [],
        priorSessionState: 'recording'
      })
    ).toMatchObject({ kind: 'recording-failed', activity: 'recording' })
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

    expect(toastSpies.success).toHaveBeenCalledWith('Account connected.')
    expect(toastSpies.error).toHaveBeenCalledWith('OAuth callback failed.', {
      description: 'Authorization was declined.'
    })
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
      'Microphone audio could not be recorded: saved session has missing audio'
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
})
