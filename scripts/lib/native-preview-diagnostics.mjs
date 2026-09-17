export function resolveNativePreviewLatencyBudgets({
  configuredP95Ms,
  configuredP99Ms,
  sourceCompleteScene = false,
  expectNativeMetalPreview = true,
  expectNativePreview = expectNativeMetalPreview,
  exerciseProofFramePolling = false,
  proofPollingIntervalMs
}) {
  const usesContainedProofSurface = !expectNativePreview && exerciseProofFramePolling
  const usesExpandedBudget = sourceCompleteScene || usesContainedProofSurface
  const proofPollingBudgetMs =
    usesContainedProofSurface &&
    Number.isFinite(proofPollingIntervalMs) &&
    proofPollingIntervalMs > 0
      ? proofPollingIntervalMs * 2
      : null

  // The Electron proof surface shares renderer/main-loop scheduling and is not
  // governed by the CAMetal presenter contract. A live proof source can only
  // advance at its configured poll cadence, so allow at most two polls while
  // the smoke separately proves advancing, fresh source pixels and no blanks.
  return {
    p95Ms: usesExpandedBudget
      ? Math.max(configuredP95Ms, proofPollingBudgetMs ?? 100)
      : configuredP95Ms,
    p99Ms: usesExpandedBudget
      ? Math.max(configuredP99Ms, proofPollingBudgetMs ?? 150)
      : configuredP99Ms
  }
}

export function minimumProofSourceFrameDelta({
  measurementMs,
  pollingIntervalMs,
  toleratedPollsPerAdvance = 4
}) {
  if (
    !Number.isFinite(measurementMs) ||
    measurementMs <= 0 ||
    !Number.isFinite(pollingIntervalMs) ||
    pollingIntervalMs <= 0 ||
    !Number.isFinite(toleratedPollsPerAdvance) ||
    toleratedPollsPerAdvance < 1
  ) {
    return 2
  }
  return Math.max(2, Math.floor(measurementMs / (pollingIntervalMs * toleratedPollsPerAdvance)))
}

export function summarizeNativePreviewRecordingDiagnostics(
  samples,
  {
    targetFps,
    startedAt,
    stopRequestedAt,
    warmupMs,
    expectedSurfaceTransport,
    expectedSurfaceBacking,
    expectedNativePreviewHostKind,
    previewSurfaceSamples = []
  }
) {
  const activeSamples = samples.filter((sample) => {
    const receivedAt = sample.receivedAt ?? 0
    return (
      isRecordingMode(sample.activeOutputMode) &&
      receivedAt >= startedAt &&
      receivedAt <= stopRequestedAt
    )
  })
  const steadySamples = activeSamples.filter(
    (sample) => (sample.receivedAt ?? 0) - startedAt >= warmupMs
  )
  const measuredSamples = steadySamples.length ? steadySamples : activeSamples
  const activeSurfaceSamples = previewSurfaceSamples.filter((sample) => {
    const receivedAt = sample.receivedAt ?? 0
    return receivedAt >= startedAt && receivedAt <= stopRequestedAt
  })
  const steadySurfaceSamples = activeSurfaceSamples.filter(
    (sample) => (sample.receivedAt ?? 0) - startedAt >= warmupMs
  )
  const measuredSurfaceSamples = steadySurfaceSamples.length
    ? steadySurfaceSamples
    : activeSurfaceSamples
  const collect = (field) =>
    measuredSamples.map((sample) => numeric(sample[field])).filter((value) => value !== null)
  const collectCounts = (field) => measuredSamples.map((sample) => numeric(sample[field]) ?? 0)
  const lastString = (field) => {
    for (let index = measuredSamples.length - 1; index >= 0; index -= 1) {
      const value = measuredSamples[index]?.[field]
      if (typeof value === 'string' && value.length > 0) {
        return value
      }
    }
    return null
  }
  const collectSurface = (field) =>
    measuredSurfaceSamples.map((sample) => numeric(sample[field])).filter((value) => value !== null)
  const collectSurfaceCounts = (field) =>
    measuredSurfaceSamples.map((sample) => numeric(sample[field]) ?? 0)
  const d3d11Samples = measuredSamples
    .map((sample) => sample.windowsD3d11Media)
    .filter((sample) => sample && typeof sample === 'object' && !Array.isArray(sample))
  const collectD3d11 = (field) =>
    d3d11Samples.map((sample) => numeric(sample[field])).filter((value) => value !== null)
  const collectD3d11Counts = (field) => d3d11Samples.map((sample) => numeric(sample[field]) ?? 0)
  const lastD3d11 = (field) => {
    for (let index = d3d11Samples.length - 1; index >= 0; index -= 1) {
      const value = d3d11Samples[index]?.[field]
      if (value !== undefined && value !== null) return value
    }
    return null
  }
  const d3d11PresenterSamples = measuredSurfaceSamples
    .map((sample) => sample.windowsD3d11Presenter)
    .filter((sample) => sample && typeof sample === 'object' && !Array.isArray(sample))
  const collectD3d11PresenterCounts = (field) =>
    d3d11PresenterSamples.map((sample) => numeric(sample[field]) ?? 0)
  const lastD3d11Presenter = (field) => {
    for (let index = d3d11PresenterSamples.length - 1; index >= 0; index -= 1) {
      const value = d3d11PresenterSamples[index]?.[field]
      if (value !== undefined && value !== null) return value
    }
    return null
  }
  const fpsValues = [...collect('captureFps'), ...collect('renderFps')]
  const backendRssValues = collect('backendRssBytes')
  const ffmpegProcessValues = collect('activeFfmpegProcesses')
  const ffprobeProcessValues = collect('activeFfprobeProcesses')
  const nativeDiagnosticsSamples = measuredSamples.filter(
    (sample) =>
      sample.previewTransport === expectedSurfaceTransport &&
      sample.previewSurfaceBacking === expectedSurfaceBacking &&
      (!expectedNativePreviewHostKind ||
        sample.nativePreviewHostKind === expectedNativePreviewHostKind)
  ).length
  const nativeSurfaceSamples = measuredSurfaceSamples.filter(
    (sample) =>
      sample.transport === expectedSurfaceTransport &&
      sample.backing === expectedSurfaceBacking &&
      (!expectedNativePreviewHostKind ||
        sample.nativePreviewHostKind === expectedNativePreviewHostKind)
  ).length

  return {
    minFps: minOf(fpsValues),
    minSpeed: minOf(collect('encoderSpeed')),
    droppedFrames: maxOf(collectCounts('droppedFrames')) ?? 0,
    micDroppedFrames: maxOf(collectCounts('micDroppedFrames')) ?? 0,
    maintenanceSamples: measuredSamples.filter((sample) => sample.ffmpegMaintenanceRunning).length,
    duplicateCaptureSamples: measuredSamples.filter(
      (sample) =>
        Array.isArray(sample.duplicateCaptureSources) && sample.duplicateCaptureSources.length > 0
    ).length,
    maxEncoderBridgeRepeatedFrames: maxOf(collectCounts('encoderBridgeRepeatedFrames')) ?? 0,
    maxEncoderBridgeRepeatedFrameBursts:
      maxOf(collectCounts('encoderBridgeRepeatedFrameBursts')) ?? 0,
    maxEncoderBridgeMaxRepeatedFrameRun:
      maxOf(collectCounts('encoderBridgeMaxRepeatedFrameRun')) ?? 0,
    maxEncoderBridgeSourceAgeMs: maxOf(collectCounts('encoderBridgeSourceAgeMs')) ?? 0,
    maxEncoderBridgeSourceAgeP95Ms: maxOf(collect('encoderBridgeSourceAgeP95Ms')) ?? null,
    maxEncoderBridgeRepeatedFrameAgeP95Ms:
      maxOf(collect('encoderBridgeRepeatedFrameAgeP95Ms')) ?? null,
    maxEncoderBridgeRepeatedFrameAgeMaxMs:
      maxOf(collectCounts('encoderBridgeRepeatedFrameAgeMaxMs')) ?? 0,
    maxEncoderBridgeMetalTargetFrames: maxOf(collectCounts('encoderBridgeMetalTargetFrames')) ?? 0,
    maxEncoderBridgeRawVideoCopiedFrames:
      maxOf(collectCounts('encoderBridgeRawVideoCopiedFrames')) ?? 0,
    maxEncoderBridgeMetalTargetCopiedFrames:
      maxOf(collectCounts('encoderBridgeMetalTargetCopiedFrames')) ?? 0,
    maxEncoderBridgeMetalTargetHandleFrames:
      maxOf(collectCounts('encoderBridgeMetalTargetHandleFrames')) ?? 0,
    maxEncoderBridgeZeroCopyFrames: maxOf(collectCounts('encoderBridgeZeroCopyFrames')) ?? 0,
    maxEncoderBridgeVideoToolboxProbeFrames:
      maxOf(collectCounts('encoderBridgeVideoToolboxProbeFrames')) ?? 0,
    maxEncoderBridgeVideoToolboxProbeBytes:
      maxOf(collectCounts('encoderBridgeVideoToolboxProbeBytes')) ?? 0,
    maxEncoderBridgeVideoToolboxProbeErrors:
      maxOf(collectCounts('encoderBridgeVideoToolboxProbeErrors')) ?? 0,
    maxEncoderBridgeVideoToolboxOutputFrames:
      maxOf(collectCounts('encoderBridgeVideoToolboxOutputFrames')) ?? 0,
    maxEncoderBridgeVideoToolboxOutputBytes:
      maxOf(collectCounts('encoderBridgeVideoToolboxOutputBytes')) ?? 0,
    maxEncoderBridgeVideoToolboxOutputEncodeMs:
      maxOf(collectCounts('encoderBridgeVideoToolboxOutputEncodeMs')) ?? 0,
    maxEncoderBridgeCompositorWaitP95Ms: maxOf(collect('encoderBridgeCompositorWaitP95Ms')) ?? null,
    maxEncoderBridgeVideoToolboxSubmitP95Ms:
      maxOf(collect('encoderBridgeVideoToolboxSubmitP95Ms')) ?? null,
    maxEncoderBridgeVideoToolboxFifoWriteP95Ms:
      maxOf(collect('encoderBridgeVideoToolboxFifoWriteP95Ms')) ?? null,
    maxEncoderBridgeVideoToolboxFifoEnqueueP95Ms:
      maxOf(collect('encoderBridgeVideoToolboxFifoEnqueueP95Ms')) ?? null,
    maxEncoderBridgeVideoToolboxFifoEnqueueMaxMs:
      maxOf(collect('encoderBridgeVideoToolboxFifoEnqueueMaxMs')) ?? null,
    maxEncoderBridgeWriterLoopP95Ms: maxOf(collect('encoderBridgeWriterLoopP95Ms')) ?? null,
    maxEncoderBridgeWriterSleepP95Ms: maxOf(collect('encoderBridgeWriterSleepP95Ms')) ?? null,
    maxEncoderBridgeWriterActiveP95Ms: maxOf(collect('encoderBridgeWriterActiveP95Ms')) ?? null,
    maxEncoderBridgeDeadlineLagP95Ms: maxOf(collect('encoderBridgeDeadlineLagP95Ms')) ?? null,
    maxEncoderBridgeDeadlineLagMaxMs: maxOf(collect('encoderBridgeDeadlineLagMaxMs')) ?? null,
    maxEncoderBridgeLateDeadlineTicks: maxOf(collectCounts('encoderBridgeLateDeadlineTicks')) ?? 0,
    maxCompositorCpuFallbackFrames: maxOf(collectCounts('compositorCpuFallbackFrames')) ?? 0,
    maxCompositorSourceIosurfaceImportFrames:
      maxOf(collectCounts('compositorSourceIosurfaceImportFrames')) ?? 0,
    maxCompositorSourceCvpixelbufferImportFrames:
      maxOf(collectCounts('compositorSourceCvpixelbufferImportFrames')) ?? 0,
    maxCompositorSourceByteUploadFrames:
      maxOf(collectCounts('compositorSourceByteUploadFrames')) ?? 0,
    maxCompositorSourceImportFailures: maxOf(collectCounts('compositorSourceImportFailures')) ?? 0,
    maxCompositorCameraSourceIosurfaceImportFrames:
      maxOf(collectCounts('compositorCameraSourceIosurfaceImportFrames')) ?? 0,
    maxCompositorCameraSourceCvpixelbufferImportFrames:
      maxOf(collectCounts('compositorCameraSourceCvpixelbufferImportFrames')) ?? 0,
    maxCompositorCameraSourceByteUploadFrames:
      maxOf(collectCounts('compositorCameraSourceByteUploadFrames')) ?? 0,
    maxCompositorCameraSourceImportFailures:
      maxOf(collectCounts('compositorCameraSourceImportFailures')) ?? 0,
    maxCompositorScreenSourceIosurfaceImportFrames:
      maxOf(collectCounts('compositorScreenSourceIosurfaceImportFrames')) ?? 0,
    maxCompositorScreenSourceCvpixelbufferImportFrames:
      maxOf(collectCounts('compositorScreenSourceCvpixelbufferImportFrames')) ?? 0,
    maxCompositorScreenSourceByteUploadFrames:
      maxOf(collectCounts('compositorScreenSourceByteUploadFrames')) ?? 0,
    maxCompositorScreenSourceImportFailures:
      maxOf(collectCounts('compositorScreenSourceImportFailures')) ?? 0,
    lastCompositorFallbackReason: lastString('compositorFallbackReason'),
    lastWindowsD3d11State: lastD3d11('state'),
    lastWindowsD3d11AdapterLuid: lastD3d11('adapterLuid'),
    lastWindowsD3d11Generation: lastD3d11('generation'),
    lastWindowsD3d11CaptureBackend: lastD3d11('captureBackend'),
    lastWindowsD3d11CursorMode: lastD3d11('cursorMode'),
    lastWindowsD3d11FallbackReason: lastD3d11('fallbackReason'),
    maxWindowsD3d11CaptureReadbackFrames: maxOf(collectD3d11Counts('captureReadbackFrames')) ?? 0,
    maxWindowsD3d11TextureImportFrames: maxOf(collectD3d11Counts('textureImportFrames')) ?? 0,
    maxWindowsD3d11CompositorCpuFallbackFrames:
      maxOf(collectD3d11Counts('compositorCpuFallbackFrames')) ?? 0,
    maxWindowsD3d11PreviewPresents: maxOf(collectD3d11Counts('previewPresents')) ?? 0,
    maxWindowsD3d11PreviewDrops: maxOf(collectD3d11Counts('previewDrops')) ?? 0,
    maxWindowsD3d11PreviewBmpRequests: maxOf(collectD3d11Counts('previewBmpRequests')) ?? 0,
    maxWindowsD3d11PreviewBmpBytes: maxOf(collectD3d11Counts('previewBmpBytes')) ?? 0,
    maxWindowsD3d11EncoderGpuSamples: maxOf(collectD3d11Counts('encoderGpuSamples')) ?? 0,
    maxWindowsD3d11EncoderSystemMemorySamples:
      maxOf(collectD3d11Counts('encoderSystemMemorySamples')) ?? 0,
    maxWindowsD3d11RawVideoCopiedFrames: maxOf(collectD3d11Counts('rawVideoCopiedFrames')) ?? 0,
    maxWindowsD3d11TexturePoolPressureEvents:
      maxOf(collectD3d11Counts('texturePoolPressureEvents')) ?? 0,
    maxWindowsD3d11AdapterMismatches: maxOf(collectD3d11Counts('adapterMismatches')) ?? 0,
    maxWindowsD3d11DeviceResets: maxOf(collectD3d11Counts('deviceResets')) ?? 0,
    maxWindowsD3d11MessagePumpLagP95Ms: maxOf(collectD3d11('messagePumpLagP95Ms')) ?? null,
    maxWindowsD3d11MessagePumpLagMaxMs: maxOf(collectD3d11('messagePumpLagMaxMs')) ?? null,
    lastWindowsD3d11PresenterLayered: lastD3d11Presenter('layered'),
    lastWindowsD3d11PresenterTransparent: lastD3d11Presenter('transparent'),
    lastWindowsD3d11PresenterNoActivate: lastD3d11Presenter('noActivate'),
    lastWindowsD3d11PresenterExcludedFromCapture: lastD3d11Presenter('excludedFromCapture'),
    lastWindowsD3d11PresenterWindowActive: lastD3d11Presenter('windowActive'),
    lastWindowsD3d11PresenterWindowFocused: lastD3d11Presenter('windowFocused'),
    lastWindowsD3d11PresenterGenerationMatches: lastD3d11Presenter('generationMatches'),
    lastWindowsD3d11PresenterOwnerProcessMatches: lastD3d11Presenter('ownerProcessMatches'),
    lastWindowsD3d11PresenterSameAdapter: lastD3d11Presenter('sameAdapter'),
    lastWindowsD3d11PresenterSourceLive: lastD3d11Presenter('sourceLive'),
    lastWindowsD3d11PresenterFirstPresentSucceeded: lastD3d11Presenter('firstPresentSucceeded'),
    lastWindowsD3d11PresenterSequence: lastD3d11Presenter('lastPresentedSequence'),
    lastWindowsD3d11PresenterBounds: lastD3d11Presenter('actualBounds'),
    lastWindowsD3d11PresenterFallbackReason: lastD3d11Presenter('fallbackReason'),
    maxWindowsD3d11PresenterSuccessfulPresents:
      maxOf(collectD3d11PresenterCounts('successfulPresents')) ?? 0,
    maxWindowsD3d11PresenterLatestWinsDrops:
      maxOf(collectD3d11PresenterCounts('latestWinsDrops')) ?? 0,
    maxWindowsD3d11PresenterHiddenDrops: maxOf(collectD3d11PresenterCounts('hiddenDrops')) ?? 0,
    maxWindowsD3d11PresenterBusyDrops: maxOf(collectD3d11PresenterCounts('busyDrops')) ?? 0,
    maxWindowsD3d11PresenterStaleFrameDrops:
      maxOf(collectD3d11PresenterCounts('staleFrameDrops')) ?? 0,
    nativePreviewSamples: nativeDiagnosticsSamples + nativeSurfaceSamples,
    minPreviewPresentFps: minOf([...collect('previewPresentFps'), ...collectSurface('presentFps')]),
    maxPreviewInputToPresentLatencyMs: maxOf([
      ...collect('previewInputToPresentLatencyMs'),
      ...collectSurface('inputToPresentLatencyMs')
    ]),
    maxPreviewInputToPresentLatencyP95Ms: maxOf([
      ...collect('previewInputToPresentLatencyP95Ms'),
      ...collectSurface('inputToPresentLatencyP95Ms')
    ]),
    maxPreviewInputToPresentLatencyP99Ms: maxOf([
      ...collect('previewInputToPresentLatencyP99Ms'),
      ...collectSurface('inputToPresentLatencyP99Ms')
    ]),
    maxPreviewCompositorFrameLag: maxOf([
      ...collect('previewCompositorFrameLag'),
      ...collectSurface('compositorFrameLag')
    ]),
    maxPreviewRenderFrameTimeP95Ms: maxOf([
      ...collect('previewRenderFrameTimeP95Ms'),
      ...collectSurface('intervalP95Ms')
    ]),
    maxPreviewDroppedFrames:
      maxOf([...collectCounts('previewDroppedFrames'), ...collectSurfaceCounts('droppedFrames')]) ??
      0,
    maxNativePreviewRendererPollIntervalP95Ms: maxOf([
      ...collect('nativePreviewRendererPollIntervalP95Ms'),
      ...collectSurface('nativePreviewRendererPollIntervalP95Ms')
    ]),
    maxNativePreviewRendererPollRoundTripP95Ms: maxOf([
      ...collect('nativePreviewRendererPollRoundTripP95Ms'),
      ...collectSurface('nativePreviewRendererPollRoundTripP95Ms')
    ]),
    maxNativePreviewRendererPresentRoundTripP95Ms: maxOf([
      ...collect('nativePreviewRendererPresentRoundTripP95Ms'),
      ...collectSurface('nativePreviewRendererPresentRoundTripP95Ms')
    ]),
    maxNativePreviewRendererPollInFlightSkips:
      maxOf([
        ...collectCounts('nativePreviewRendererPollInFlightSkips'),
        ...collectSurfaceCounts('nativePreviewRendererPollInFlightSkips')
      ]) ?? 0,
    maxNativePreviewMainQueueWaitP95Ms: maxOf([
      ...collect('nativePreviewMainQueueWaitP95Ms'),
      ...collectSurface('nativePreviewMainQueueWaitP95Ms')
    ]),
    maxNativePreviewMainPresentP95Ms: maxOf([
      ...collect('nativePreviewMainPresentP95Ms'),
      ...collectSurface('nativePreviewMainPresentP95Ms')
    ]),
    maxNativePreviewMainQueuedBehindCount:
      maxOf([
        ...collectCounts('nativePreviewMainQueuedBehindCount'),
        ...collectSurfaceCounts('nativePreviewMainQueuedBehindCount')
      ]) ?? 0,
    maxNativePreviewHelperRoundTripP95Ms: maxOf([
      ...collect('nativePreviewHelperRoundTripP95Ms'),
      ...collectSurface('nativePreviewHelperRoundTripP95Ms')
    ]),
    maxNativePreviewMainStatusFetchP95Ms: maxOf([
      ...collect('nativePreviewMainStatusFetchP95Ms'),
      ...collectSurface('nativePreviewMainStatusFetchP95Ms')
    ]),
    maxNativePreviewMainStatusFetchFailures:
      maxOf([
        ...collectCounts('nativePreviewMainStatusFetchFailures'),
        ...collectSurfaceCounts('nativePreviewMainStatusFetchFailures')
      ]) ?? 0,
    maxNativePreviewMainStatusFetchSuccesses:
      maxOf([
        ...collectCounts('nativePreviewMainStatusFetchSuccesses'),
        ...collectSurfaceCounts('nativePreviewMainStatusFetchSuccesses')
      ]) ?? 0,
    maxNativePreviewMainPresentedStatusAgeMs: maxOf([
      ...collect('nativePreviewMainPresentedStatusAgeMs'),
      ...collectSurface('nativePreviewMainPresentedStatusAgeMs')
    ]),
    maxNativePreviewMainPresentedStatusAgeP95Ms: maxOf([
      ...collect('nativePreviewMainPresentedStatusAgeP95Ms'),
      ...collectSurface('nativePreviewMainPresentedStatusAgeP95Ms')
    ]),
    maxNativePreviewMainPresentedFrameAgeP95Ms: maxOf([
      ...collect('nativePreviewMainPresentedFrameAgeP95Ms'),
      ...collectSurface('nativePreviewMainPresentedFrameAgeP95Ms')
    ]),
    maxPreviewRepeatedFrames: maxOf(collectCounts('previewRepeatedFrames')) ?? 0,
    maxBackendRssBytes: maxOf(backendRssValues),
    maxActiveFfmpegProcesses: maxOf(ffmpegProcessValues) ?? 0,
    maxActiveFfprobeProcesses: maxOf(ffprobeProcessValues) ?? 0,
    activeSamples: activeSamples.length,
    activeSurfaceSamples: activeSurfaceSamples.length,
    measuredSamples: measuredSamples.length,
    measuredSurfaceSamples: measuredSurfaceSamples.length,
    steadySamples: steadySamples.length,
    steadySurfaceSamples: steadySurfaceSamples.length,
    targetFps
  }
}

function isRecordingMode(mode) {
  return typeof mode === 'string' && mode.includes('record')
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function minOf(values) {
  return values.length ? Math.min(...values) : null
}

function maxOf(values) {
  return values.length ? Math.max(...values) : null
}
