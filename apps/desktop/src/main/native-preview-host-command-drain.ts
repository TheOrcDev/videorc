import type { NativePreviewHostCommand, PreviewSurfaceStatus } from '../shared/backend'

export interface NativePreviewHostCommandDrainDependencies {
  generation: number
  takeCommands: () => Promise<NativePreviewHostCommand[]>
  applyCommands: (
    commands: NativePreviewHostCommand[],
    generation: number
  ) => Promise<PreviewSurfaceStatus>
  currentStatus: () => PreviewSurfaceStatus
}

/**
 * Drain backend-owned native-host lifecycle commands inside Electron main.
 *
 * Bounds placement is already written directly by main from BrowserWindow
 * events, so replaying the backend's delayed update-bounds echo can only move
 * the native layer backwards. Create/destroy remain lifecycle commands and
 * must run on the privileged main side.
 */
export async function drainNativePreviewHostCommands({
  generation,
  takeCommands,
  applyCommands,
  currentStatus
}: NativePreviewHostCommandDrainDependencies): Promise<PreviewSurfaceStatus> {
  const queuedCommands = await takeCommands()
  const lifecycleCommands = queuedCommands.filter((command) => command.kind !== 'update-bounds')
  return lifecycleCommands.length > 0
    ? applyCommands(lifecycleCommands, generation)
    : currentStatus()
}
