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
