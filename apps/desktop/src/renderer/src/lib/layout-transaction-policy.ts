import type { RecordingStatus } from '../../../shared/backend'

export type LayoutTransactionProofDisposition = 'ignore-stale' | 'apply-proven' | 'apply-unproven'

export function shouldReloadSceneFromCaptureConfig(input: {
  connected: boolean
  sceneEditMode: boolean
  recordingState: RecordingStatus['state']
  startRequestPending: boolean
  stopRequestPending: boolean
  /**
   * A performance check runs backend sessions the recording status never
   * shows (plan 212), and the backend refuses an idle reload while one holds
   * the session slot. The reload waits for the check's completed event.
   */
  performanceCheckRunning: boolean
}): boolean {
  return (
    input.connected &&
    !input.sceneEditMode &&
    !input.startRequestPending &&
    !input.stopRequestPending &&
    !input.performanceCheckRunning &&
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

// Idle scene commits are authoritative immediately. Only wait for the compositor
// presentation proof when the detached preview can actually receive a frame;
// with no preview window open, the compositor intentionally has no presentation
// consumer and a proof would be impossible.
export function idlePreviewLayoutProofRequired(input: { surfaceCanPresent: boolean }): boolean {
  return input.surfaceCanPresent
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

export type LayoutTransactionFailureDisposition =
  | 'requested-scene-applied'
  | 'backend-scene-different'
  | 'backend-truth-unavailable'
  | 'terminal-evidence-unavailable'
  | 'definitely-not-applied'

/**
 * Only a post-send outcome-unknown failure is eligible for reconciliation.
 * A stable scene read must both advance beyond the pre-command revision and
 * exactly match every observable part of the requested scene transaction.
 */
export function layoutTransactionFailureDisposition<T>(input: {
  failureCode?: string
  sceneRevisionBeforeRequest?: number
  requestedScene: T
  backendTruth: { sceneRevision: number; scene: T } | null
}): LayoutTransactionFailureDisposition {
  if (input.failureCode !== 'request-outcome-unknown') return 'definitely-not-applied'
  if (!input.backendTruth) return 'backend-truth-unavailable'
  if (
    input.sceneRevisionBeforeRequest === undefined ||
    input.backendTruth.sceneRevision <= input.sceneRevisionBeforeRequest
  ) {
    return 'terminal-evidence-unavailable'
  }
  return semanticJsonEqual(input.requestedScene, input.backendTruth.scene)
    ? 'requested-scene-applied'
    : 'backend-scene-different'
}

function semanticJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => semanticJsonEqual(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && semanticJsonEqual(leftRecord[key], rightRecord[key])
    )
  )
}

export function latestLayoutTransactionCommit<T extends { sceneRevision: number }>(
  current: T | null,
  candidate: T
): T {
  return current && current.sceneRevision > candidate.sceneRevision ? current : candidate
}

/**
 * The capture selection a layout transaction adopts from the backend's scene
 * (plan 212 S2, change 8). A `test-pattern` source is adopted in the dev app
 * only: the packaged app has no test pattern of its own (a performance
 * check's benchmark scene never reaches `scene.get` since plan 212, and
 * nothing else makes one), so one there is never the user's look and is
 * ignored rather than persisted into the working visual.
 */
export function layoutTransactionSourcesFromScene<
  S extends {
    cameraId?: string
    cameraName?: string
    screenId?: string
    screenName?: string
    screenUuid?: string
    windowId?: string
    windowName?: string
    testPattern?: boolean
  }
>(
  current: S,
  sceneSources: ReadonlyArray<{ kind: string; deviceId?: string; name: string }>,
  { packaged }: { packaged: boolean }
): S {
  const sources = { ...current }
  for (const source of sceneSources) {
    if (source.kind === 'camera') {
      sources.cameraName =
        sources.cameraId === source.deviceId ? (sources.cameraName ?? source.name) : source.name
      sources.cameraId = source.deviceId
    }
    if (source.kind === 'screen') {
      sources.screenName =
        sources.screenId === source.deviceId ? (sources.screenName ?? source.name) : source.name
      // Plan 213 F1: another display's UUID would find that display first.
      if (sources.screenId !== source.deviceId) sources.screenUuid = undefined
      sources.screenId = source.deviceId
      sources.windowId = undefined
      sources.windowName = undefined
      sources.testPattern = false
    }
    if (source.kind === 'window') {
      sources.windowName =
        sources.windowId === source.deviceId ? (sources.windowName ?? source.name) : source.name
      sources.windowId = source.deviceId
      sources.screenId = undefined
      sources.screenName = undefined
      sources.screenUuid = undefined
      sources.testPattern = false
    }
    if (source.kind === 'test-pattern' && !packaged) {
      sources.screenId = undefined
      sources.screenUuid = undefined
      sources.windowId = undefined
      sources.testPattern = true
    }
  }
  return sources
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
