import type {
  CompositorStatus,
  PreviewSurfaceCompositorUpdateParams,
  PreviewSurfaceStatus,
  RecordingStatus
} from './backend'
import {
  nativePreviewFramePollingShouldSuppress,
  type NativePreviewFramePollingSuppressionInput
} from './native-preview-surface-lifecycle'

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

export type NativePreviewSceneProofPresentationOwner =
  | 'main-pump'
  | 'renderer-fallback'
  | 'unavailable'

export function rendererFallbackSeedCompositorStatus({
  wasMainPumpActive,
  nextMainPumpActive,
  latestStatus
}: {
  wasMainPumpActive: boolean
  nextMainPumpActive: boolean
  latestStatus: CompositorStatus | null
}): CompositorStatus | null {
  // While main owns presentation the renderer's connection deliberately mutes
  // compact frame events. Its cached status can therefore carry an expired
  // IOSurface handoff. On takeover, wait for the first newly unmuted frameReady
  // event instead of presenting that stale main-era target.
  return wasMainPumpActive && !nextMainPumpActive ? null : latestStatus
}

export function rendererFallbackOwnsPresentation({
  mainPumpActive
}: {
  mainPumpActive: boolean
  recordingState: RecordingStatus['state']
}): boolean {
  // Recording changes polling/report fields, not ownership. If main's socket
  // drops mid-recording, renderer fallback remains the only live presentation
  // path and must keep the user's preview current until main reconnects.
  return !mainPumpActive
}

export function rendererFallbackCompositorStatusIsFresh({
  fallbackActivatedAtMs,
  statusUpdatedAt
}: {
  fallbackActivatedAtMs: number
  statusUpdatedAt: string
}): boolean {
  if (!(fallbackActivatedAtMs > 0)) {
    return true
  }
  const statusUpdatedAtMs = Date.parse(statusUpdatedAt)
  return Number.isFinite(statusUpdatedAtMs) && statusUpdatedAtMs >= fallbackActivatedAtMs
}

export function nativePreviewSceneProofPresentationOwner(input: {
  mainPumpActive: boolean
  statusReaderAvailable: boolean
  rendererUpdaterAvailable: boolean
}): NativePreviewSceneProofPresentationOwner {
  if (input.mainPumpActive) {
    return input.statusReaderAvailable ? 'main-pump' : 'unavailable'
  }
  return input.rendererUpdaterAvailable ? 'renderer-fallback' : 'unavailable'
}

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
  rendererTimingFields: NativePreviewRendererTimingFields,
  framePolling: NativePreviewFramePollingSuppressionInput
): PreviewSurfaceCompositorUpdateParams {
  return {
    ...status,
    suppressFramePolling: nativePreviewFramePollingShouldSuppress(framePolling),
    ...rendererTimingFields
  }
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

export function compositorStatusHasRenderedSceneRevision(
  status: Pick<CompositorStatus, 'sceneRevision' | 'frameSceneRevision'>,
  revision: number
): boolean {
  return status.sceneRevision === revision && status.frameSceneRevision === revision
}

export function nativePreviewDroppedFramesWithSuppressed(
  surfaceStatus: Pick<PreviewSurfaceStatus, 'droppedFrames'>,
  suppressedPresents: number
): number {
  return Math.max(0, surfaceStatus.droppedFrames) + Math.max(0, suppressedPresents)
}
