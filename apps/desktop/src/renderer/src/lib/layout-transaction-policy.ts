import type { RecordingStatus } from '../../../shared/backend'

export type LayoutTransactionProofDisposition = 'ignore-stale' | 'apply-proven' | 'apply-unproven'

export function shouldReloadSceneFromCaptureConfig(input: {
  connected: boolean
  sceneEditMode: boolean
  recordingState: RecordingStatus['state']
  startRequestPending: boolean
  stopRequestPending: boolean
}): boolean {
  return (
    input.connected &&
    !input.sceneEditMode &&
    !input.startRequestPending &&
    !input.stopRequestPending &&
    !['starting', 'recording', 'streaming', 'stopping'].includes(input.recordingState)
  )
}

export function layoutTransactionProofDisposition(input: {
  latestIntentId: number
  committedIntentId: number
  proofSucceeded: boolean
}): LayoutTransactionProofDisposition {
  if (input.latestIntentId !== input.committedIntentId) {
    return 'ignore-stale'
  }
  return input.proofSucceeded ? 'apply-proven' : 'apply-unproven'
}

// Instant background apply while live: commit only when a session is active,
// only after the session's own start armed the watcher (start params already
// carry the background), and only when the resolved background VALUE changed —
// the registry yields new objects on unrelated edits (rename, import into an
// inactive slot) which must not commit.
export function liveBackgroundCommitDecision(input: {
  sessionActive: boolean
  armedFingerprint: string | null
  fingerprint: string
}): { next: string | null; commit: boolean } {
  if (!input.sessionActive) {
    return { next: null, commit: false }
  }
  if (input.armedFingerprint === null || input.armedFingerprint === input.fingerprint) {
    return { next: input.fingerprint, commit: false }
  }
  return { next: input.fingerprint, commit: true }
}

// A backend commit whose recording/streaming output proof passed but whose
// native preview presented-revision readback missed is a preview-only fault:
// the session output is already proven and the controls are reconciled to the
// commit, so it must not be raised as a destructive error.
export class NativePreviewPresentationProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativePreviewPresentationProofError'
  }
}

export type LayoutTransactionUnprovenSeverity = 'output-error' | 'presentation-warning'

export function layoutTransactionUnprovenSeverity(
  proofError: unknown
): LayoutTransactionUnprovenSeverity {
  return proofError instanceof NativePreviewPresentationProofError
    ? 'presentation-warning'
    : 'output-error'
}

export type LayoutTransactionFailureReconciliation<T> = {
  source: 'backend-truth' | 'latest-commit'
  snapshot: T
}

export function latestLayoutTransactionCommit<T extends { sceneRevision: number }>(
  current: T | null,
  candidate: T
): T {
  return current && current.sceneRevision > candidate.sceneRevision ? current : candidate
}

export function layoutTransactionBackendSnapshotIsStable<T extends { id: string }>(input: {
  sceneBefore: T
  compositorSceneId?: string
  sceneAfter: T
}): boolean {
  if (
    input.sceneBefore.id !== input.sceneAfter.id ||
    (input.compositorSceneId !== undefined && input.compositorSceneId !== input.sceneAfter.id)
  ) {
    return false
  }
  return JSON.stringify(input.sceneBefore) === JSON.stringify(input.sceneAfter)
}

export function layoutTransactionFailureReconciliation<T>(input: {
  latestIntentId: number
  failedIntentId: number
  backendTruth: T | null
  latestCommit: T | null
}): LayoutTransactionFailureReconciliation<T> | null {
  if (input.latestIntentId !== input.failedIntentId) {
    return null
  }
  if (input.backendTruth) {
    return { source: 'backend-truth', snapshot: input.backendTruth }
  }
  if (input.latestCommit) {
    return { source: 'latest-commit', snapshot: input.latestCommit }
  }
  return null
}
