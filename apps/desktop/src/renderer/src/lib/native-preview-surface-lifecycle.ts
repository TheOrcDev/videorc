interface NativePreviewWindowLifecycleSnapshot {
  open: boolean
  supervisor: {
    generation: number
  }
}

/**
 * A supervisor generation remains unchanged while its window is closed, so a
 * generation match alone cannot authorize an async surface sync to commit.
 */
export function nativePreviewSurfaceSyncCanCommit(
  windowState: NativePreviewWindowLifecycleSnapshot,
  generation?: number
): boolean {
  return (
    windowState.open &&
    (generation === undefined || windowState.supervisor.generation === generation)
  )
}

/** A stopped backend session must be created again, even if renderer state was stale. */
export function nativePreviewSurfaceSyncNeedsCreate(
  surfaceAlreadyCreated: boolean,
  backendState: string
): boolean {
  return surfaceAlreadyCreated && backendState !== 'live'
}
