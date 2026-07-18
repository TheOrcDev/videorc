import { describe, expect, it } from 'vitest'

import {
  activeAiWorkflowStatus,
  aiRunButtonAction,
  latestAiProblemArtifact
} from './ai-workflow-status'
import type { AiArtifact, HealthEvent, SessionWithDetails } from './backend'

function session(overrides: Partial<SessionWithDetails> = {}): SessionWithDetails {
  return {
    aiArtifacts: [],
    aiArtifactCount: 0,
    healthEvents: [],
    healthEventCount: 0,
    id: 'session-1',
    mode: 'record',
    sessionLogs: [],
    sessionLogCount: 0,
    startedAt: '2026-07-01T00:00:00.000Z',
    status: 'completed',
    title: 'Session',
    commentCount: 0,
    ...overrides
  }
}

function artifact(overrides: Partial<AiArtifact>): AiArtifact {
  return {
    content: {},
    createdAt: '2026-07-01T00:00:00.000Z',
    id: 'artifact-1',
    kind: 'summary',
    sessionId: 'session-1',
    status: 'ready',
    ...overrides
  }
}

function health(overrides: Partial<HealthEvent>): HealthEvent {
  return {
    code: 'cloud-ai-worker-delayed',
    createdAt: '2026-07-01T00:00:00.000Z',
    id: 'health-1',
    level: 'warn',
    message: 'Queued - worker delayed.',
    sessionId: 'session-1',
    ...overrides
  }
}

describe('ai workflow status', () => {
  it('the primary button is either the run or the exact fix, never a half-run', () => {
    // Ready + consent: run/retry/regenerate.
    expect(
      aiRunButtonAction({
        aiRunning: false,
        consent: true,
        hasFailedArtifacts: true,
        hasReviewableArtifacts: false,
        readinessState: 'ready'
      })
    ).toEqual({ kind: 'run', label: 'Retry generation' })
    expect(
      aiRunButtonAction({
        aiRunning: false,
        consent: true,
        hasFailedArtifacts: false,
        hasReviewableArtifacts: false,
        readinessState: 'ready'
      })
    ).toEqual({ kind: 'run', label: 'Generate publish pack' })
    // Missing consent is the fix, regardless of readiness.
    expect(
      aiRunButtonAction({
        aiRunning: false,
        consent: false,
        hasFailedArtifacts: false,
        hasReviewableArtifacts: false,
        readinessState: 'signed-out'
      })
    ).toEqual({ kind: 'enable-consent', label: 'Enable cloud consent' })
    // Each blocked readiness state names its own fix.
    expect(
      aiRunButtonAction({
        aiRunning: false,
        consent: true,
        hasFailedArtifacts: false,
        hasReviewableArtifacts: false,
        readinessState: 'signed-out'
      }).kind
    ).toBe('sign-in')
    expect(
      aiRunButtonAction({
        aiRunning: false,
        consent: true,
        hasFailedArtifacts: false,
        hasReviewableArtifacts: false,
        readinessState: 'premium-required'
      }).kind
    ).toBe('view-premium')
    expect(
      aiRunButtonAction({
        aiRunning: false,
        consent: true,
        hasFailedArtifacts: false,
        hasReviewableArtifacts: false,
        readinessState: 'server-unconfigured'
      }).kind
    ).toBe('blocked')
    expect(
      aiRunButtonAction({
        aiRunning: true,
        consent: true,
        hasFailedArtifacts: false,
        hasReviewableArtifacts: false,
        readinessState: 'ready'
      })
    ).toEqual({ kind: 'run', label: 'Running…' })
  })

  it('surfaces delayed worker health while the workflow is active', () => {
    const status = activeAiWorkflowStatus(
      session({
        healthEvents: [health({ code: 'cloud-ai-worker-delayed' })]
      })
    )

    expect(status.title).toBe('Queued - worker delayed')
    expect(status.tone).toBe('warning')
  })

  it('falls back to extraction and processing states from local artifacts', () => {
    expect(activeAiWorkflowStatus(session()).title).toBe('Preparing recording')
    expect(
      activeAiWorkflowStatus(
        session({
          aiArtifacts: [artifact({ kind: 'transcript' })]
        })
      ).title
    ).toBe('Processing cloud AI')
    expect(
      activeAiWorkflowStatus(
        session({
          aiArtifacts: [artifact({ kind: 'audio-extract' })]
        })
      ).title
    ).toBe('Processing cloud AI')
  })

  it('returns the latest failed or pending artifact for attention banners', () => {
    const pending = artifact({
      kind: 'transcript',
      status: 'pending-consent'
    })
    const failed = artifact({
      content: { message: 'Cloud AI failed.' },
      id: 'artifact-2',
      kind: 'transcript',
      status: 'failed'
    })

    expect(latestAiProblemArtifact(session({ aiArtifacts: [pending, failed] }))).toBe(failed)
  })
})
