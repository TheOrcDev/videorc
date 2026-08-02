import type { PreviewSurfaceStatus } from '../../../shared/backend'
import { isNativePreviewCapability } from '../../../shared/native-preview-capability'

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
  platform?: string
  status: PreviewPresentationSnapshot
}

/**
 * Backend D3D11 status intentionally omits Electron-main authority fields.
 * Renderer consumers must resolve these events through main before treating
 * them as presentation truth.
 */
export function previewSurfaceStatusRequiresMainAuthority(
  status: Pick<PreviewSurfaceStatus, 'transport' | 'windowsD3d11Presenter'>
): boolean {
  return status.transport === 'd3d11-shared-texture' || status.windowsD3d11Presenter !== undefined
}

/**
 * Only a platform-canonical attached native presenter can make proof polling
 * redundant while the preview window remains open.
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
    isNativePreviewCapability(status, input.platform ?? 'darwin') &&
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
