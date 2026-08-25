import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '@/lib/backend'
import {
  completeSessionRuntimeRecovery,
  sessionRuntimeContinuationIsCurrent,
  sessionRuntimeRecoveryPlan
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
})
