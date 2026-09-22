import type { Scene, SceneCommitStatus, SceneTransformUpdateParams } from '@/lib/backend'

export type TransformCommitResult = { ok: true; status: SceneCommitStatus } | { ok: false }

/** A bounded transform operation; stale responses cannot restore a replaced scene. */
export async function commitSceneTransform({
  sourceId,
  patch,
  request,
  isCurrent,
  apply,
  persist,
  reportError
}: {
  sourceId: string
  patch: SceneTransformUpdateParams['transform']
  request: ((params: SceneTransformUpdateParams) => Promise<SceneCommitStatus>) | null
  isCurrent: (status: SceneCommitStatus) => boolean
  apply: (status: SceneCommitStatus) => void
  persist: (scene: Scene, sourceId: string) => void
  reportError: (error: unknown) => void
}): Promise<TransformCommitResult> {
  if (!request) {
    reportError(new Error('Scene editing is unavailable. Reconnect and try again.'))
    return { ok: false }
  }
  try {
    const status = await request({ sourceId, transform: patch, snap: 'none' })
    if (!isCurrent(status)) return { ok: false }
    if (!status.applied) throw new Error(status.message ?? 'Scene transform was not applied.')
    if (!status.scene.sources.some((source) => source.id === sourceId))
      throw new Error('The edited source is no longer available.')
    apply(status)
    persist(status.scene, sourceId)
    return { ok: true, status }
  } catch (error) {
    reportError(error)
    return { ok: false }
  }
}

/** Committed transform echoes are not a new editing intent. Everything else is. */
export function transformLayoutIntent(layout: Record<string, unknown>): string {
  const {
    sourceTransformOverrides: _overrides,
    cameraTransform: _transform,
    cameraTransformMode: _mode,
    ...intent
  } = layout
  return JSON.stringify(intent)
}

export function transformSourceIdentity(scene: Scene | null): string {
  return JSON.stringify([
    scene?.id,
    scene?.sources.map((source) => [
      source.id,
      source.kind,
      source.deviceId,
      source.locked,
      source.visible
    ])
  ])
}
