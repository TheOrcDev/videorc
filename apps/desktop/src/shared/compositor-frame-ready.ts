import type { CompositorFrameReady, CompositorStatus } from './backend'

const EMPTY_IMAGE_CACHE: NonNullable<CompositorStatus['imageCache']> = {
  budgetBytes: 0,
  entryBudget: 0,
  entries: 0,
  decodedBytes: 0,
  preconvertedBgraBytes: 0,
  residentBytes: 0,
  pinnedEntries: 0,
  pinnedBytes: 0,
  hits: 0,
  misses: 0,
  evictions: 0
}

const EMPTY_FRAME_PIPELINE: NonNullable<CompositorStatus['framePipeline']> = {
  gpuReadbacks: 0,
  bgraBytesCopied: 0,
  yuvFramesConverted: 0,
  immutableTextureUploads: 0,
  immutableTextureReuses: 0
}

/**
 * Expands the deliberately small wire event into the shape consumed by the
 * existing native-present path. Heavy scene/source diagnostics are reused only
 * when they describe the same run and scene revision; they are never sent at
 * frame cadence.
 */
export function compositorStatusFromFrameReady(
  frame: CompositorFrameReady,
  previous?: CompositorStatus | null
): CompositorStatus {
  const previousMatchesFrame =
    previous !== null &&
    previous !== undefined &&
    previous.runId === frame.runId &&
    previous.sceneRevision === frame.sceneRevision
  const matchingPrevious = previousMatchesFrame ? previous : undefined

  return {
    state: 'live',
    targetFps: frame.targetFps,
    width: frame.width,
    height: frame.height,
    runId: frame.runId,
    sceneRevision: frame.sceneRevision,
    frameSceneRevision: frame.frameSceneRevision,
    sceneId: matchingPrevious?.sceneId,
    sceneLayout: matchingPrevious?.sceneLayout,
    activeScreenId: matchingPrevious?.activeScreenId,
    sceneSources: matchingPrevious?.sceneSources ?? [],
    sources: matchingPrevious?.sources ?? [],
    renderFps: matchingPrevious?.renderFps,
    framesRendered: frame.framesRendered,
    repeatedFrames: matchingPrevious?.repeatedFrames ?? 0,
    droppedFrames: matchingPrevious?.droppedFrames ?? 0,
    frameAgeMs: frame.frameAgeMs,
    frameTimeP95Ms: matchingPrevious?.frameTimeP95Ms,
    metalTargetIosurfaceId: frame.metalTargetIosurfaceId,
    metalTargetWidth: frame.metalTargetWidth,
    metalTargetHeight: frame.metalTargetHeight,
    imageCache: matchingPrevious?.imageCache ?? EMPTY_IMAGE_CACHE,
    framePipeline: matchingPrevious?.framePipeline ?? EMPTY_FRAME_PIPELINE,
    updatedAt: frame.updatedAt,
    message: matchingPrevious?.message
  }
}
