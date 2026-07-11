import type { PreviewSurfaceStatus } from './backend'

/** Backend-originated statuses omit the IPC acknowledgement and remain compatible. */
export function rendererCompositorUpdateWasAccepted(status: PreviewSurfaceStatus): boolean {
  return status.compositorUpdateAccepted !== false
}
