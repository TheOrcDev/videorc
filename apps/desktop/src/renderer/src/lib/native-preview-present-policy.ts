import type {
  CompositorStatus,
  PreviewSurfaceCompositorUpdateParams,
  PreviewSurfaceStatus,
  RecordingStatus
} from './backend'
import { isActiveRecordingState } from './format'

export type NativePreviewRendererTimingFields = Pick<
  PreviewSurfaceCompositorUpdateParams,
  | 'nativePreviewRendererPollIntervalP95Ms'
  | 'nativePreviewRendererPollRoundTripP95Ms'
  | 'nativePreviewRendererPresentRoundTripP95Ms'
  | 'nativePreviewRendererPollInFlightSkips'
>

export type NativePreviewCompositorPresentDecision =
  | { kind: 'disabled' }
  | { kind: 'suppress-starting' }
  | { kind: 'queue' }

export function decideNativePreviewCompositorPresent(input: {
  nativePreviewSurfaceEnabled: boolean
  updateCompositorAvailable: boolean
  recordingState: RecordingStatus['state']
}): NativePreviewCompositorPresentDecision {
  if (!input.nativePreviewSurfaceEnabled || !input.updateCompositorAvailable) {
    return { kind: 'disabled' }
  }
  if (input.recordingState === 'starting') {
    return { kind: 'suppress-starting' }
  }
  return { kind: 'queue' }
}

export function buildNativePreviewCompositorUpdateParams(
  status: CompositorStatus,
  recordingState: RecordingStatus['state'],
  rendererTimingFields: NativePreviewRendererTimingFields
): PreviewSurfaceCompositorUpdateParams {
  const suppressFramePolling = isActiveRecordingState(recordingState)
  return suppressFramePolling
    ? {
        ...status,
        suppressFramePolling: true,
        ...rendererTimingFields
      }
    : { ...status, ...rendererTimingFields }
}

export function pendingCompositorStatusSupersedes(
  pending: CompositorStatus | null,
  current: CompositorStatus,
  { includeSameRunFrameAdvance }: { includeSameRunFrameAdvance: boolean }
): boolean {
  if (!pending) {
    return false
  }
  if (pending.runId && current.runId && pending.runId !== current.runId) {
    return true
  }
  return includeSameRunFrameAdvance && pending.framesRendered > current.framesRendered
}

export function nativePreviewDroppedFramesWithSuppressed(
  surfaceStatus: Pick<PreviewSurfaceStatus, 'droppedFrames'>,
  suppressedPresents: number
): number {
  return Math.max(0, surfaceStatus.droppedFrames) + Math.max(0, suppressedPresents)
}
