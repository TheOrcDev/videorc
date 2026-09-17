import type { CloudAiReadinessState } from './ai-readiness'
import type { AiArtifact, HealthEvent, SessionWithDetails } from './backend'

export interface AiWorkflowStatus {
  description: string
  title: string
  tone: 'neutral' | 'warning'
}

// The primary button is either the RUN or the FIX — never a misleading
// "Extract local audio" that half-executes and looks like a dead feature
// (2026-07-11 report: "Title & description just downloads sound").
export type AiRunButtonAction =
  | { kind: 'run'; label: string }
  | { kind: 'enable-consent'; label: string }
  | { kind: 'sign-in'; label: string }
  | { kind: 'view-premium'; label: string }
  | { kind: 'blocked'; label: string }

export function aiRunButtonAction(params: {
  aiRunning: boolean
  consent: boolean
  hasFailedArtifacts: boolean
  hasReviewableArtifacts: boolean
  readinessState: CloudAiReadinessState
}): AiRunButtonAction {
  if (params.aiRunning) {
    return { kind: 'run', label: 'Running…' }
  }
  if (!params.consent) {
    return { kind: 'enable-consent', label: 'Enable cloud consent' }
  }
  switch (params.readinessState) {
    case 'ready':
      break
    case 'signed-out':
    case 'session-expired':
      return { kind: 'sign-in', label: 'Sign in to generate' }
    case 'premium-required':
      return { kind: 'view-premium', label: 'View Premium' }
    case 'checking':
      return { kind: 'blocked', label: 'Checking cloud AI…' }
    default:
      return { kind: 'blocked', label: 'Cloud AI unavailable' }
  }
  if (params.hasFailedArtifacts) {
    return { kind: 'run', label: 'Retry generation' }
  }
  if (params.hasReviewableArtifacts) {
    return { kind: 'run', label: 'Regenerate publish pack' }
  }
  return { kind: 'run', label: 'Generate publish pack' }
}

export function activeAiWorkflowStatus(session: SessionWithDetails): AiWorkflowStatus {
  const latestEvent = latestAiEvent(session.healthEvents)
  if (latestEvent) {
    return statusForHealthEvent(latestEvent)
  }

  const hasLocalInput = session.aiArtifacts.some(
    (artifact) =>
      artifact.status === 'ready' &&
      (artifact.kind === 'audio-extract' || artifact.kind === 'transcript')
  )
  return hasLocalInput
    ? {
        description: 'Videorc is waiting for the server job to return generated artifacts.',
        title: 'Processing cloud AI',
        tone: 'neutral'
      }
    : {
        description: 'Videorc is preparing the local transcript or audio before any cloud upload.',
        title: 'Preparing recording',
        tone: 'neutral'
      }
}

export function latestAiProblemArtifact(session: SessionWithDetails): AiArtifact | null {
  return (
    session.aiArtifacts
      .filter((artifact) => artifact.status === 'failed' || artifact.status === 'pending-consent')
      .at(-1) ?? null
  )
}

function latestAiEvent(events: HealthEvent[]): HealthEvent | null {
  return (
    events
      .filter((event) => event.code.startsWith('cloud-ai-') || event.code.startsWith('ai-'))
      .at(-1) ?? null
  )
}

function statusForHealthEvent(event: HealthEvent): AiWorkflowStatus {
  switch (event.code) {
    case 'cloud-ai-worker-delayed':
      return {
        description: event.message,
        title: 'Queued - worker delayed',
        tone: 'warning'
      }
    case 'cloud-ai-worker-still-processing':
      return {
        description: event.message,
        title: 'Still processing',
        tone: 'warning'
      }
    case 'cloud-ai-job-failed':
    case 'cloud-ai-sign-in-required':
      return {
        description: event.message,
        title: 'Cloud AI needs attention',
        tone: 'warning'
      }
    default:
      return {
        description: event.message,
        title: 'AI workflow running',
        tone: 'neutral'
      }
  }
}
