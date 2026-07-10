// Real-source acceptance gate (plan Phase 1 / Phase 8).
//
// A pure evaluator that decides whether a real-source recording run passes the
// OBS-quality bar, combining the honest final-file analyzer verdict with the live
// diagnostics sampled during the run. Kept separate from the live harness so the gate
// logic itself is unit-testable on synthetic inputs (no app, no hardware) — which is the
// point of Phase 1: synthetic-only success must not be able to mark the plan complete,
// and the gate must fail the current bad path.

export const DEFAULT_ACCEPTANCE_GATES = Object.freeze({
  minEncoderSpeed: 0.98, // encoder must stay at/above real-time
  minMicCaptureCoverage: 0.95, // mic must capture ≥95% of expected samples
  minPreviewPresentFps: 55, // visible native preview should keep a smooth present cadence
  maxPreviewIntervalP95Ms: 24, // p95 present interval should stay near 60fps
  maxPreviewInputToPresentLatencyP95Ms: 50, // preview should feel current at p95
  maxPreviewInputToPresentLatencyP99Ms: 100, // rare spikes still need a hard ceiling
  maxPreviewInputToPresentLatencyMs: 100, // fallback hard ceiling when percentile latency is unavailable
  maxPreviewCompositorFrameLag: 2, // latest presented frame cannot trail compositor by >2 frames
  maxRecordingQueueDepth: 16,
  maxRecordingQueueOldestFrameAgeMs: 250,
  maxStreamQueueDepth: 8,
  maxStreamQueueOldestFrameAgeMs: 150
})

export function recordingPreviewAcceptanceGates(outputFps, gates = DEFAULT_ACCEPTANCE_GATES) {
  const fps = Number.isFinite(outputFps) && outputFps > 0 ? outputFps : 1
  return {
    ...gates,
    minPreviewPresentFps: Math.min(gates.minPreviewPresentFps, fps * 0.9),
    maxPreviewIntervalP95Ms: Math.max(gates.maxPreviewIntervalP95Ms, (1000 / fps) * 1.5)
  }
}

/**
 * @param {object} input
 * @param {{pass:boolean, failures:string[]}} input.analyzerVerdict - from analyzeRecording()
 * @param {{pass:boolean, failures:string[]}} [input.startupVerdict] - from analyzeStartupResolution()
 * @param {object} input.diagnostics - summarized live diagnostics for the run
 * @param {boolean} input.claimsNative - whether the preview reported the real native Metal transport
 * @param {boolean} [input.requireObsNativePreview] - whether OBS parity requires that real native transport
 * @param {boolean} [input.requireGpuCompositor] - whether OBS parity requires the Metal compositor/backend export path
 * @param {{width:number,height:number,fps:number}} [input.requestedOutput] - requested recording output dimensions
 * @param {boolean} [input.require4kMediaEvidence] - whether 4K source/compositor/Metal evidence is required
 * @param {boolean} input.expectAudio - whether a mic was selected
 * @param {object} [gates]
 * @returns {{pass:boolean, failures:string[]}}
 */
export function evaluateAcceptance(input, gates = DEFAULT_ACCEPTANCE_GATES) {
  const failures = []
  const d = input.diagnostics ?? {}

  // 1. Final-file gates (freeze / repeated-frame bursts / pacing / audio / A/V skew).
  if (input.analyzerVerdict && !input.analyzerVerdict.pass) {
    for (const failure of input.analyzerVerdict.failures ?? []) {
      failures.push(`final-file: ${failure}`)
    }
  }

  // 1b. Startup gates: the first seconds must already be target-resolution real output.
  if (input.startupVerdict && !input.startupVerdict.pass) {
    for (const failure of input.startupVerdict.failures ?? []) {
      failures.push(`startup: ${failure}`)
    }
  }
  const finalFilePassed = input.analyzerVerdict?.pass === true

  // 2. Bridge repeat diagnostics are under-run evidence when there is no passing
  // decoded-file analyzer. When the analyzer passes, its repeated-frame burst gate is
  // the artifact-level source of truth.
  if ((d.encoderBridgeRepeatedFrames ?? 0) > 0 && !finalFilePassed) {
    const burstDetail =
      (d.encoderBridgeRepeatedFrameBursts ?? 0) > 0 || (d.encoderBridgeMaxRepeatedFrameRun ?? 0) > 0
        ? ` across ${d.encoderBridgeRepeatedFrameBursts ?? 0} burst(s), max run ${d.encoderBridgeMaxRepeatedFrameRun ?? 0}`
        : ''
    failures.push(
      `recording: ${d.encoderBridgeRepeatedFrames} duplicate frame(s) re-fed to the encoder${burstDetail} (compositor under-run)`
    )
  }
  if ((d.encoderBridgeSyntheticFrames ?? 0) > 0) {
    failures.push(
      `recording: ${d.encoderBridgeSyntheticFrames} synthetic filler frame(s) fed (no real source ready)`
    )
  }
  if ((d.encoderBridgeRecordingQueueDroppedFrames ?? 0) > 0) {
    failures.push(
      `recording: ${d.encoderBridgeRecordingQueueDroppedFrames} frame(s) discarded by recording output backpressure (recording frames must never be dropped)`
    )
  }
  if (input.requireGpuCompositor) {
    requireBoundedQueue(failures, d, 'recording', {
      depth: 'encoderBridgeRecordingQueueDepth',
      oldestAge: 'encoderBridgeRecordingQueueOldestFrameAgeMs',
      pressure: 'encoderBridgeRecordingQueueCapacityPressureEvents',
      dropped: 'encoderBridgeRecordingQueueDroppedFrames',
      maxDepth: gates.maxRecordingQueueDepth,
      maxOldestAgeMs: gates.maxRecordingQueueOldestFrameAgeMs,
      allowDrops: false
    })
    if (d.encoderBridgeSeparateOutputEncodersActive === true) {
      requireBoundedQueue(failures, d, 'stream', {
        depth: 'encoderBridgeStreamQueueDepth',
        oldestAge: 'encoderBridgeStreamQueueOldestFrameAgeMs',
        pressure: 'encoderBridgeStreamQueueCapacityPressureEvents',
        dropped: 'encoderBridgeStreamQueueDroppedFrames',
        maxDepth: gates.maxStreamQueueDepth,
        maxOldestAgeMs: gates.maxStreamQueueOldestFrameAgeMs,
        allowDrops: true
      })
    }
  }

  // 2b. OBS parity needs the shared live compositor to stay on the GPU path.
  if (input.requireGpuCompositor && d.compositorBackend !== 'metal') {
    const suffix = d.compositorFallbackReason ? `: ${d.compositorFallbackReason}` : ''
    failures.push(
      `compositor: expected Metal backend, got ${d.compositorBackend ?? 'unknown'}${suffix}`
    )
  }
  if (input.requireGpuCompositor && (d.compositorCpuFallbackFrames ?? 0) > 0) {
    failures.push(
      `compositor: ${d.compositorCpuFallbackFrames} CPU fallback frame(s) rendered during session`
    )
  }
  if (input.requireGpuCompositor && (d.encoderBridgeMetalTargetFrames ?? 0) <= 0) {
    failures.push(
      'recording: expected encoder bridge to observe IOSurface-backed Metal target frames, got none'
    )
  }
  if (input.requireGpuCompositor && (d.encoderBridgeMetalTargetHandleFrames ?? 0) <= 0) {
    failures.push(
      'recording: expected encoder bridge to receive retained Metal target handles, got none'
    )
  }
  if (
    input.requireGpuCompositor &&
    (d.encoderBridgeMetalTargetFrames ?? 0) > (d.encoderBridgeMetalTargetHandleFrames ?? 0)
  ) {
    const missing =
      (d.encoderBridgeMetalTargetFrames ?? 0) - (d.encoderBridgeMetalTargetHandleFrames ?? 0)
    failures.push(
      `recording: ${missing} IOSurface-backed Metal target frame(s) lacked retained target handles`
    )
  }
  if (input.requireGpuCompositor && (d.encoderBridgeRawVideoCopiedFrames ?? 0) > 0) {
    failures.push(
      `recording: ${d.encoderBridgeRawVideoCopiedFrames} raw-YUV frame(s) copied through the developer/debug raw-video FFmpeg bridge`
    )
  }
  if (input.requireGpuCompositor && (d.encoderBridgeMetalTargetCopiedFrames ?? 0) > 0) {
    failures.push(
      `recording: ${d.encoderBridgeMetalTargetCopiedFrames} Metal target frame(s) still copied through the raw-video FFmpeg bridge (not zero-copy)`
    )
  }
  if (input.requireGpuCompositor && (d.encoderBridgeZeroCopyFrames ?? 0) <= 0) {
    failures.push('recording: expected zero-copy encoder bridge frames, got none')
  }

  // 2c. 4K evidence: the 4K command must not pass because the final mux happened to
  // write a 4K container around a downscaled source/compositor path.
  if (input.require4kMediaEvidence) {
    for (const failure of evaluate4kMediaEvidence(d.mediaDimensions, input.requestedOutput)) {
      failures.push(failure)
    }
    for (const failure of evaluate4kSourceImportEvidence(d)) {
      failures.push(failure)
    }
  }

  // 3. Encoder progress speed is useful live telemetry, but VideoToolbox can report
  // cumulative progress stalls while the decoded artifact is clean. Keep it hard only
  // when a passing final-file analyzer is not available.
  if (d.minEncoderSpeed != null && d.minEncoderSpeed < gates.minEncoderSpeed && !finalFilePassed) {
    failures.push(`encoder: speed ${d.minEncoderSpeed.toFixed(2)}x below ${gates.minEncoderSpeed}x`)
  }

  // 4. Audio: zero mic drops and adequate capture coverage.
  if (input.expectAudio) {
    if ((d.micDroppedFrames ?? 0) > 0) {
      failures.push(`audio: microphone dropped ${d.micDroppedFrames} frame(s)`)
    }
    if (d.minMicCaptureCoverage != null && d.minMicCaptureCoverage < gates.minMicCaptureCoverage) {
      failures.push(
        `audio: mic capture coverage ${(d.minMicCaptureCoverage * 100).toFixed(0)}% below ${(gates.minMicCaptureCoverage * 100).toFixed(0)}%`
      )
    }
    if (!isFiniteNumber(d.minMicCaptureCoverage)) {
      failures.push('audio: microphone capture coverage telemetry was missing')
    }
  }

  // 5. Transport honesty: a "native" preview must not have fetched image-poll routes.
  if (input.requireObsNativePreview && !input.claimsNative) {
    failures.push('transport: preview did not report the real native Metal surface')
  }
  if (input.requireObsNativePreview && d.previewSurfaceBacking !== 'cametal-layer') {
    failures.push(
      `transport: expected CAMetalLayer preview backing, got ${d.previewSurfaceBacking ?? 'unknown'}`
    )
  }
  if (input.requireObsNativePreview && (d.previewPendingHostCommandCount ?? 0) > 0) {
    failures.push(
      `transport: ${d.previewPendingHostCommandCount} native preview host command(s) still pending (preview host not applied)`
    )
  }
  if (input.requireObsNativePreview && !isFiniteNumber(d.previewPendingHostCommandCount)) {
    failures.push('transport: native preview pending-host-command telemetry was missing')
  }
  const imagePolls = d.imagePollDuringSession?.total
  if (input.requireObsNativePreview && !isFiniteNumber(imagePolls)) {
    failures.push('transport: native preview image-poll telemetry was missing')
  }
  if (input.claimsNative && imagePolls != null && imagePolls > 0) {
    failures.push(
      `transport: ${imagePolls} image-poll request(s) during a "native" preview session (not native)`
    )
  }

  // 6. Preview present path: currentness matters while recording. A native preview may
  // skip stale frames to stay current, but it may not queue old compositor frames.
  if (input.requireObsNativePreview && input.claimsNative) {
    requireFiniteMetrics(failures, d, [
      ['minPreviewPresentFps', 'preview present FPS'],
      ['previewIntervalP95Ms', 'preview p95 present interval'],
      ['previewInputToPresentLatencyP95Ms', 'preview source-to-present p95 latency'],
      ['previewInputToPresentLatencyP99Ms', 'preview source-to-present p99 latency'],
      ['previewCompositorFrameLag', 'preview compositor frame lag']
    ])
  }
  if (
    input.claimsNative &&
    d.minPreviewPresentFps != null &&
    d.minPreviewPresentFps < gates.minPreviewPresentFps
  ) {
    failures.push(
      `preview: present FPS ${d.minPreviewPresentFps.toFixed(1)} below ${gates.minPreviewPresentFps}`
    )
  }
  if (
    input.claimsNative &&
    d.previewIntervalP95Ms != null &&
    d.previewIntervalP95Ms > gates.maxPreviewIntervalP95Ms
  ) {
    failures.push(
      `preview: p95 present interval ${d.previewIntervalP95Ms.toFixed(1)}ms exceeds ${gates.maxPreviewIntervalP95Ms}ms`
    )
  }
  if (
    input.claimsNative &&
    d.previewInputToPresentLatencyP95Ms != null &&
    d.previewInputToPresentLatencyP95Ms > gates.maxPreviewInputToPresentLatencyP95Ms
  ) {
    failures.push(
      `preview: source-to-present p95 latency ${d.previewInputToPresentLatencyP95Ms.toFixed(0)}ms exceeds ${gates.maxPreviewInputToPresentLatencyP95Ms}ms`
    )
  }
  if (
    input.claimsNative &&
    d.previewInputToPresentLatencyP99Ms != null &&
    d.previewInputToPresentLatencyP99Ms > gates.maxPreviewInputToPresentLatencyP99Ms
  ) {
    failures.push(
      `preview: source-to-present p99 latency ${d.previewInputToPresentLatencyP99Ms.toFixed(0)}ms exceeds ${gates.maxPreviewInputToPresentLatencyP99Ms}ms`
    )
  }
  const hasPreviewLatencyPercentiles =
    d.previewInputToPresentLatencyP95Ms != null || d.previewInputToPresentLatencyP99Ms != null
  if (
    input.claimsNative &&
    !hasPreviewLatencyPercentiles &&
    d.previewInputToPresentLatencyMs != null &&
    d.previewInputToPresentLatencyMs > gates.maxPreviewInputToPresentLatencyMs
  ) {
    failures.push(
      `preview: source-to-present latency ${d.previewInputToPresentLatencyMs.toFixed(0)}ms exceeds ${gates.maxPreviewInputToPresentLatencyMs}ms`
    )
  }
  if (
    input.claimsNative &&
    d.previewCompositorFrameLag != null &&
    d.previewCompositorFrameLag > gates.maxPreviewCompositorFrameLag
  ) {
    failures.push(
      `preview: presented frame is ${d.previewCompositorFrameLag} compositor frame(s) behind (max ${gates.maxPreviewCompositorFrameLag})`
    )
  }

  return { pass: failures.length === 0, failures }
}

function requireFiniteMetrics(failures, diagnostics, metrics) {
  for (const [field, label] of metrics) {
    if (!isFiniteNumber(diagnostics[field])) {
      failures.push(`${label} telemetry was missing`)
    }
  }
}

function requireBoundedQueue(
  failures,
  diagnostics,
  label,
  { depth, oldestAge, pressure, dropped, maxDepth, maxOldestAgeMs, allowDrops }
) {
  requireFiniteMetrics(failures, diagnostics, [
    [depth, `${label} queue depth`],
    [pressure, `${label} queue capacity pressure`],
    [dropped, `${label} queue dropped frames`]
  ])
  const actualDepth = diagnostics[depth]
  if (isFiniteNumber(actualDepth) && actualDepth > maxDepth) {
    failures.push(`${label}: queue depth ${actualDepth} exceeded ${maxDepth}`)
  }
  const age = diagnostics[oldestAge]
  if (isFiniteNumber(actualDepth) && actualDepth > 0 && !isFiniteNumber(age)) {
    failures.push(`${label} queue oldest-frame age telemetry was missing while non-empty`)
  } else if (isFiniteNumber(age) && age > maxOldestAgeMs) {
    failures.push(
      `${label}: queue oldest-frame age ${age.toFixed(0)}ms exceeded ${maxOldestAgeMs}ms`
    )
  }
  if (isFiniteNumber(diagnostics[pressure]) && diagnostics[pressure] > 0) {
    failures.push(`${label}: queue hit capacity ${diagnostics[pressure]} time(s)`)
  }
  if (!allowDrops && isFiniteNumber(diagnostics[dropped]) && diagnostics[dropped] > 0) {
    // The legacy recording-drop message above is retained for compatibility; this
    // queue-specific failure keeps the bounded-queue contract self-contained.
    failures.push(`${label}: queue dropped ${diagnostics[dropped]} frame(s)`)
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function evaluate4kMediaEvidence(mediaDimensions, requestedOutput) {
  const failures = []
  const requested = requestedOutput ?? mediaDimensions?.requestedOutput
  if (
    !isAtLeast(requested?.width, 3840) ||
    !isAtLeast(requested?.height, 2160) ||
    !isAtLeast(requested?.fps, 30)
  ) {
    failures.push(
      `4k: expected requested output at least 3840x2160@30, got ${formatDimension(requested?.width, requested?.height)}@${requested?.fps ?? 'n/a'}`
    )
    return failures
  }

  requireDimensionAtLeast(
    failures,
    '4k: screen source capture',
    (mediaDimensions?.screenSourceActual ?? mediaDimensions?.screenSource)?.max,
    requested
  )
  requireDimensionAtLeast(
    failures,
    '4k: compositor screen source',
    mediaDimensions?.compositorScreenSource?.max,
    requested
  )
  requireDimensionAtLeast(
    failures,
    '4k: compositor target',
    mediaDimensions?.compositorTarget?.max,
    requested
  )
  requireDimensionAtLeast(
    failures,
    '4k: Metal target',
    mediaDimensions?.compositorMetalTarget?.max,
    requested
  )

  return failures
}

function evaluate4kSourceImportEvidence(diagnostics) {
  const failures = []
  const screenByteUploads = diagnostics.compositorScreenSourceByteUploadFrames ?? 0
  const screenZeroCopyImports =
    (diagnostics.compositorScreenSourceIosurfaceImportFrames ?? 0) +
    (diagnostics.compositorScreenSourceCvpixelbufferImportFrames ?? 0)
  const cameraByteUploads = diagnostics.compositorCameraSourceByteUploadFrames ?? 0
  const cameraZeroCopyImports =
    (diagnostics.compositorCameraSourceIosurfaceImportFrames ?? 0) +
    (diagnostics.compositorCameraSourceCvpixelbufferImportFrames ?? 0)
  const cameraImportFailures = diagnostics.compositorCameraSourceImportFailures ?? 0
  const cameraObserved =
    cameraByteUploads > 0 ||
    cameraZeroCopyImports > 0 ||
    cameraImportFailures > 0 ||
    isAtLeast(diagnostics.previewCameraActualWidth, 1) ||
    isAtLeast(diagnostics.previewCameraActualHeight, 1)

  if (screenByteUploads > 0) {
    failures.push(
      `4k: screen source used ${screenByteUploads} byte-upload frame(s); expected zero-copy source import`
    )
  }
  if (screenZeroCopyImports <= 0) {
    failures.push('4k: expected screen source zero-copy import frames, got none')
  }
  if (cameraObserved && cameraByteUploads > 0) {
    failures.push(
      `4k: camera source used ${cameraByteUploads} byte-upload frame(s); expected zero-copy source import`
    )
  }
  if (cameraObserved && cameraZeroCopyImports <= 0) {
    failures.push('4k: expected camera source zero-copy import frames, got none')
  }

  return failures
}

function requireDimensionAtLeast(failures, label, actual, requested) {
  if (!actual) {
    failures.push(`${label}: dimensions not reported`)
    return
  }
  if (!isAtLeast(actual.width, requested.width) || !isAtLeast(actual.height, requested.height)) {
    failures.push(
      `${label}: ${formatDimension(actual.width, actual.height)} below requested ${formatDimension(requested.width, requested.height)}`
    )
  }
}

function isAtLeast(value, minimum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
}

function formatDimension(width, height) {
  const w = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : 'n/a'
  const h = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : 'n/a'
  return `${w}x${h}`
}
