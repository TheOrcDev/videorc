export function previewWindowSurfaceReady(
  { windowState, surfaceStatus } = {},
  { expectedTransport, expectedBacking, expectNativeMetalPreview } = {}
) {
  const bounds = surfaceStatus?.bounds
  const positiveBounds =
    Number.isFinite(bounds?.width) &&
    bounds.width > 0 &&
    Number.isFinite(bounds?.height) &&
    bounds.height > 0
  const placementReady = expectNativeMetalPreview
    ? windowState?.nativeOwnsPlacement === true
    : windowState?.surface?.visible === true &&
      surfaceStatus?.nativePreviewHostKind === 'proof-surface' &&
      surfaceStatus?.framePollingSuppressed === false
  const supervisorReady =
    windowState?.supervisor?.lifecycleState === 'surface-live' &&
    windowState?.supervisor?.surfaceActive === true
  const firstFrameReady = expectNativeMetalPreview || surfaceStatus?.firstFrameContract === 'met'

  return (
    windowState?.open === true &&
    windowState?.visible === true &&
    windowState?.surface?.exists === true &&
    supervisorReady &&
    firstFrameReady &&
    placementReady &&
    surfaceStatus?.state === 'live' &&
    surfaceStatus?.transport === expectedTransport &&
    surfaceStatus?.backing === expectedBacking &&
    (surfaceStatus?.targetFps ?? 0) >= 60 &&
    (surfaceStatus?.pendingHostCommandCount ?? -1) === 0 &&
    positiveBounds
  )
}
