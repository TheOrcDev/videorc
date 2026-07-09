import type { PreviewSurfaceStatus } from './backend'

export function accountSkippedPreviewFrame(
  status: Pick<PreviewSurfaceStatus, 'framesRendered' | 'presentedFrameId' | 'droppedFrames'>,
  skippedFrameId: number
): Pick<PreviewSurfaceStatus, 'framesRendered' | 'droppedFrames' | 'compositorFrameLag'> {
  const frameId = positiveInteger(skippedFrameId)
  if (frameId === null) {
    return {
      framesRendered: nonNegativeInteger(status.framesRendered),
      droppedFrames: nonNegativeInteger(status.droppedFrames),
      compositorFrameLag: compositorLag(status)
    }
  }

  const framesRendered = Math.max(nonNegativeInteger(status.framesRendered), frameId)
  const presentedFrameId = nonNegativeInteger(status.presentedFrameId)
  const accountedThrough = Math.max(nonNegativeInteger(status.framesRendered), presentedFrameId)
  const newlySkipped = Math.max(0, frameId - accountedThrough)

  return {
    framesRendered,
    droppedFrames: nonNegativeInteger(status.droppedFrames) + newlySkipped,
    compositorFrameLag: Math.max(0, framesRendered - presentedFrameId)
  }
}

export function accountCoalescedPreviewFrame(
  status: Pick<
    PreviewSurfaceStatus,
    'framesRendered' | 'presentedFrameId' | 'droppedFrames' | 'nativePreviewMainCoalescedFrameCount'
  >,
  skippedFrameId: number
): Pick<
  PreviewSurfaceStatus,
  'framesRendered' | 'droppedFrames' | 'compositorFrameLag' | 'nativePreviewMainCoalescedFrameCount'
> {
  const accounted = accountSkippedPreviewFrame(status, skippedFrameId)
  const droppedFrames = nonNegativeInteger(status.droppedFrames)
  const newlyCoalesced = Math.max(0, accounted.droppedFrames - droppedFrames)
  return {
    ...accounted,
    droppedFrames,
    nativePreviewMainCoalescedFrameCount:
      nonNegativeInteger(status.nativePreviewMainCoalescedFrameCount) + newlyCoalesced
  }
}

function compositorLag(
  status: Pick<PreviewSurfaceStatus, 'framesRendered' | 'presentedFrameId'>
): number {
  return Math.max(
    0,
    nonNegativeInteger(status.framesRendered) - nonNegativeInteger(status.presentedFrameId)
  )
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}
