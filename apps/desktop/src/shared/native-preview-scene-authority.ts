import type { PreviewSurfaceSceneState, PreviewSurfaceStatus } from './backend'

export interface CompositorSceneAuthorityContext {
  committedRunId?: string
  candidateRunId?: string
}

export function compositorSceneConflictsWithCommitted(
  committed: PreviewSurfaceSceneState,
  candidate: PreviewSurfaceSceneState,
  context: CompositorSceneAuthorityContext = {}
): boolean {
  if (committed.revision !== candidate.revision) {
    return false
  }
  if (
    context.committedRunId &&
    context.candidateRunId &&
    context.committedRunId !== context.candidateRunId
  ) {
    return false
  }
  return sceneFingerprint(committed) !== sceneFingerprint(candidate)
}

export function nativePreviewStatusProvesSceneRevision(
  status: PreviewSurfaceStatus,
  sceneRevision: number
): boolean {
  return (
    status.state === 'live' &&
    status.transport === 'native-surface' &&
    status.backing === 'cametal-layer' &&
    status.sourcePixelsPresent === true &&
    status.nativePreviewHostKind !== 'proof-surface' &&
    status.nativePreviewHostAttached === true &&
    status.nativePreviewPresentedSceneRevision === sceneRevision
  )
}

function sceneFingerprint(scene: PreviewSurfaceSceneState): string {
  const { updatedAt: _updatedAt, sources, ...content } = scene
  return JSON.stringify(
    canonicalValue({
      ...content,
      sources: sources.map(({ frameUrl: _frameUrl, ...source }) => source)
    })
  )
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue)
  }
  if (!isObject(value)) {
    return value
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])])
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
