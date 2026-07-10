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
