export function summarizeNativePreviewRecordingDiagnostics(
  samples,
  {
    targetFps,
    startedAt,
    stopRequestedAt,
    warmupMs,
    expectedSurfaceTransport,
    expectedSurfaceBacking,
    previewSurfaceSamples = []
  }
) {
  const activeSamples = samples.filter((sample) => {
    const receivedAt = sample.receivedAt ?? 0
    return sample.activeOutputMode === 'record' && receivedAt >= startedAt && receivedAt <= stopRequestedAt
  })
  const steadySamples = activeSamples.filter((sample) => (sample.receivedAt ?? 0) - startedAt >= warmupMs)
  const measuredSamples = steadySamples.length ? steadySamples : activeSamples
  const activeSurfaceSamples = previewSurfaceSamples.filter((sample) => {
    const receivedAt = sample.receivedAt ?? 0
    return receivedAt >= startedAt && receivedAt <= stopRequestedAt
  })
  const steadySurfaceSamples = activeSurfaceSamples.filter((sample) => (sample.receivedAt ?? 0) - startedAt >= warmupMs)
  const measuredSurfaceSamples = steadySurfaceSamples.length ? steadySurfaceSamples : activeSurfaceSamples
  const collect = (field) => measuredSamples.map((sample) => numeric(sample[field])).filter((value) => value !== null)
  const collectCounts = (field) => measuredSamples.map((sample) => numeric(sample[field]) ?? 0)
  const collectSurface = (field) =>
    measuredSurfaceSamples.map((sample) => numeric(sample[field])).filter((value) => value !== null)
  const collectSurfaceCounts = (field) => measuredSurfaceSamples.map((sample) => numeric(sample[field]) ?? 0)
  const fpsValues = [...collect('captureFps'), ...collect('renderFps')]
  const backendRssValues = collect('backendRssBytes')
  const ffmpegProcessValues = collect('activeFfmpegProcesses')
  const ffprobeProcessValues = collect('activeFfprobeProcesses')
  const nativeDiagnosticsSamples = measuredSamples.filter(
    (sample) =>
      sample.previewTransport === expectedSurfaceTransport &&
      sample.previewSurfaceBacking === expectedSurfaceBacking
  ).length
  const nativeSurfaceSamples = measuredSurfaceSamples.filter(
    (sample) => sample.transport === expectedSurfaceTransport && sample.backing === expectedSurfaceBacking
  ).length

  return {
    minFps: minOf(fpsValues),
    minSpeed: minOf(collect('encoderSpeed')),
    droppedFrames: maxOf(collectCounts('droppedFrames')) ?? 0,
    micDroppedFrames: maxOf(collectCounts('micDroppedFrames')) ?? 0,
    maintenanceSamples: measuredSamples.filter((sample) => sample.ffmpegMaintenanceRunning).length,
    duplicateCaptureSamples: measuredSamples.filter(
      (sample) => Array.isArray(sample.duplicateCaptureSources) && sample.duplicateCaptureSources.length > 0
    ).length,
    maxEncoderBridgeMetalTargetFrames: maxOf(collectCounts('encoderBridgeMetalTargetFrames')) ?? 0,
    maxCompositorCpuFallbackFrames: maxOf(collectCounts('compositorCpuFallbackFrames')) ?? 0,
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
    maxPreviewCompositorFrameLag: maxOf([...collect('previewCompositorFrameLag'), ...collectSurface('compositorFrameLag')]),
    maxPreviewRenderFrameTimeP95Ms: maxOf([...collect('previewRenderFrameTimeP95Ms'), ...collectSurface('intervalP95Ms')]),
    maxPreviewDroppedFrames: maxOf([...collectCounts('previewDroppedFrames'), ...collectSurfaceCounts('droppedFrames')]) ?? 0,
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

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function minOf(values) {
  return values.length ? Math.min(...values) : null
}

function maxOf(values) {
  return values.length ? Math.max(...values) : null
}
