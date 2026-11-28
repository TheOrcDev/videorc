export interface NativePreviewDriverResetOperations {
  retire: () => void | Promise<void>
  allowImmediateRetry: () => void
  reconcile: () => void | Promise<void>
}

export async function runNativePreviewDriverReset(
  operations: NativePreviewDriverResetOperations
): Promise<void> {
  await operations.retire()
  operations.allowImmediateRetry()
  await operations.reconcile()
}

export interface NativePreviewExplicitProofFallbackOperations<Status> {
  /**
   * Runs `operation` after every surface mutation already queued and before any
   * queued later (the surface mutation queue).
   */
  serialize: (operation: () => Promise<void>) => Promise<void>
  /** Retires the real surface driver and shows the proof surface. */
  retire: () => Promise<void>
  /** The surface status as main holds it now. */
  status: () => Status
}

/**
 * The smoke's explicit proof fallback (`exercise-native-preview-proof-fallback`)
 * retires the native driver and answers with the surface status.
 *
 * The retire must run inside the surface mutation queue, as
 * `reset-real-surface-driver` does. Run outside it, a compositor update already
 * in flight on the old driver finishes AFTER the retire and writes its
 * `native-surface` / `cametal-layer` status back over the fallback status, so
 * the answer reports a fallback that did not happen (1 run in 6 on Electron,
 * `smoke:preview-performance:native`, 2026-11-28). Queued, the in-flight update
 * completes first and the status read after the retire is the fallback's.
 */
export async function runNativePreviewExplicitProofFallback<Status>(
  operations: NativePreviewExplicitProofFallbackOperations<Status>
): Promise<Status> {
  await operations.serialize(operations.retire)
  return operations.status()
}
