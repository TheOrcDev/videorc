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
  // The Electron proof presenter can continuously have one compositor update
  // queued on a loaded hosted runner. Once its surface is live and the first
  // source frame is proven, that queue depth is not a readiness failure. Native
  // presenters still require an empty host-command queue before they claim
  // ownership.
  const hostCommandsReady =
    !expectNativePresenter || (surfaceStatus?.pendingHostCommandCount ?? -1) === 0

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
    hostCommandsReady &&
    positiveBounds
  )
}

export function nativePreviewSurfaceStatusReady(
  status,
  { expectedTransport, expectedBacking, expectedHostKind, previousFrames = 0 } = {}
) {
  const isProofSurface =
    expectedTransport === 'electron-proof-surface' &&
    expectedBacking === 'electron-browser-window'
  const hostKindReady =
    expectedHostKind === undefined ||
    status?.nativePreviewHostKind === expectedHostKind ||
    (isProofSurface && status?.nativePreviewHostKind === undefined)
  const proofStatusReady =
    !isProofSurface ||
    (status?.sourcePixelsPresent === true &&
      (status?.nativePreviewHostKind === undefined ||
        status?.nativePreviewHostKind === 'proof-surface'))
  return (
    status?.state === 'live' &&
    status?.transport === expectedTransport &&
    status?.backing === expectedBacking &&
    hostKindReady &&
    proofStatusReady &&
    (status?.targetFps ?? 0) >= 60 &&
    (status?.framesRendered ?? 0) > previousFrames
  )
}
