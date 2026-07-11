import type { PreviewSurfaceStatus } from '../../../shared/backend'

interface NativePreviewWindowLifecycleSnapshot {
  open: boolean
  supervisor: {
    generation: number
  }
}

type PreviewPresentationSnapshot = Pick<
  PreviewSurfaceStatus,
  | 'backing'
  | 'nativePreviewHostAttached'
  | 'nativePreviewHostKind'
  | 'sourcePixelsPresent'
  | 'state'
  | 'transport'
>

export interface NativePreviewFramePollingSuppressionInput {
  recordingActive: boolean
  windowOpen: boolean
  status: PreviewPresentationSnapshot
}

/**
 * The Electron proof surface is Windows' production pixel transport, so an
 * active recording must not suppress it. Only an attached native surface can
 * make proof polling redundant while the preview window remains open.
 */
export function nativePreviewFramePollingShouldSuppress(
  input: NativePreviewFramePollingSuppressionInput
): boolean {
  if (!input.windowOpen) {
    return true
  }

  const status = input.status
  const attachedNativePixels =
    status.state === 'live' &&
    status.transport === 'native-surface' &&
    status.backing === 'cametal-layer' &&
    status.sourcePixelsPresent === true &&
    status.nativePreviewHostAttached === true &&
    status.nativePreviewHostKind !== 'proof-surface'

  return input.recordingActive && attachedNativePixels
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
