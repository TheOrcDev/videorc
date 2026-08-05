export function previewWindowSurfaceReady(
  { windowState, surfaceStatus } = {},
  {
    expectedTransport,
    expectedBacking,
    expectedHostKind,
    expectNativeMetalPreview,
    expectNativePresenter = expectNativeMetalPreview
  } = {}
) {
  const bounds = surfaceStatus?.bounds
  const positiveBounds =
    Number.isFinite(bounds?.width) &&
    bounds.width > 0 &&
    Number.isFinite(bounds?.height) &&
    bounds.height > 0
  const placementReady = expectNativePresenter
    ? windowState?.nativeOwnsPlacement === true &&
      surfaceStatus?.nativePreviewHostKind === expectedHostKind &&
      surfaceStatus?.framePollingSuppressed === true
    : windowState?.surface?.visible === true &&
      surfaceStatus?.nativePreviewHostKind === 'proof-surface' &&
      surfaceStatus?.framePollingSuppressed === false
  const nativeSupervisorReady =
    windowState?.supervisor?.lifecycleState === 'surface-live' &&
    windowState?.supervisor?.surfaceActive === true
  // Windows' supported proof presenter is intentionally reported as a
  // lifecycle fallback (it is not a native D3D11/CAMetal surface). Once the
  // proof surface is live, visible, and its first source frame is verified,
  // that fallback is healthy and should satisfy the smoke's readiness gate.
  const proofFallbackReady =
    expectedTransport === 'electron-proof-surface' &&
    expectedBacking === 'electron-browser-window' &&
    windowState?.supervisor?.lifecycleState === 'surface-fallback' &&
    windowState?.supervisor?.surfaceActive === false &&
    surfaceStatus?.state === 'live' &&
    surfaceStatus?.nativePreviewHostKind === 'proof-surface' &&
    surfaceStatus?.sourcePixelsPresent === true &&
    surfaceStatus?.firstFrameContract === 'met'
  const supervisorReady = nativeSupervisorReady || proofFallbackReady
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
