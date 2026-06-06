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
  maxPreviewInputToPresentLatencyP95Ms: 50, // preview should feel current at p95
  maxPreviewInputToPresentLatencyP99Ms: 100, // rare spikes still need a hard ceiling
  maxPreviewInputToPresentLatencyMs: 100, // preview should stay current, not queued
  maxPreviewCompositorFrameLag: 2, // latest presented frame cannot trail compositor by >2 frames
})

/**
 * @param {object} input
 * @param {{pass:boolean, failures:string[]}} input.analyzerVerdict - from analyzeRecording()
 * @param {{pass:boolean, failures:string[]}} [input.startupVerdict] - from analyzeStartupResolution()
 * @param {object} input.diagnostics - summarized live diagnostics for the run
 * @param {boolean} input.claimsNative - whether the preview reported the real native Metal transport
 * @param {boolean} [input.requireObsNativePreview] - whether OBS parity requires that real native transport
 * @param {boolean} [input.requireGpuCompositor] - whether OBS parity requires the Metal compositor/backend export path
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
    failures.push(
      `recording: ${d.encoderBridgeRepeatedFrames} duplicate frame(s) re-fed to the encoder (compositor under-run)`
    )
  }
  if ((d.encoderBridgeSyntheticFrames ?? 0) > 0) {
    failures.push(
      `recording: ${d.encoderBridgeSyntheticFrames} synthetic filler frame(s) fed (no real source ready)`
    )
  }

  // 2b. OBS parity needs the shared live compositor to stay on the GPU path.
  if (input.requireGpuCompositor && d.compositorBackend !== 'metal') {
    const suffix = d.compositorFallbackReason ? `: ${d.compositorFallbackReason}` : ''
    failures.push(`compositor: expected Metal backend, got ${d.compositorBackend ?? 'unknown'}${suffix}`)
  }
  if (input.requireGpuCompositor && (d.compositorCpuFallbackFrames ?? 0) > 0) {
    failures.push(`compositor: ${d.compositorCpuFallbackFrames} CPU fallback frame(s) rendered during session`)
  }
  if (input.requireGpuCompositor && (d.encoderBridgeMetalTargetFrames ?? 0) <= 0) {
    failures.push(
      'recording: expected encoder bridge to observe IOSurface-backed Metal target frames, got none'
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

  // 3. Encoder progress speed is useful live telemetry, but VideoToolbox can report
  // cumulative progress stalls while the decoded artifact is clean. Keep it hard only
  // when a passing final-file analyzer is not available.
  if (d.minEncoderSpeed != null && d.minEncoderSpeed < gates.minEncoderSpeed && !finalFilePassed) {
    failures.push(
      `encoder: speed ${d.minEncoderSpeed.toFixed(2)}x below ${gates.minEncoderSpeed}x`
    )
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
  }

  // 5. Transport honesty: a "native" preview must not have fetched image-poll routes.
  if (input.requireObsNativePreview && !input.claimsNative) {
    failures.push('transport: preview did not report the real native Metal surface')
  }
  if (input.requireObsNativePreview && d.previewSurfaceBacking !== 'cametal-layer') {
    failures.push(`transport: expected CAMetalLayer preview backing, got ${d.previewSurfaceBacking ?? 'unknown'}`)
  }
  const imagePolls = d.imagePollDuringSession?.total
  if (input.claimsNative && imagePolls != null && imagePolls > 0) {
    failures.push(
      `transport: ${imagePolls} image-poll request(s) during a "native" preview session (not native)`
    )
  }

  // 6. Preview present path: currentness matters while recording. A native preview may
  // skip stale frames to stay current, but it may not queue old compositor frames.
  if (input.claimsNative && d.previewInputToPresentLatencyP95Ms != null && d.previewInputToPresentLatencyP95Ms > gates.maxPreviewInputToPresentLatencyP95Ms) {
    failures.push(
      `preview: source-to-present p95 latency ${d.previewInputToPresentLatencyP95Ms.toFixed(0)}ms exceeds ${gates.maxPreviewInputToPresentLatencyP95Ms}ms`
    )
  }
  if (input.claimsNative && d.previewInputToPresentLatencyP99Ms != null && d.previewInputToPresentLatencyP99Ms > gates.maxPreviewInputToPresentLatencyP99Ms) {
    failures.push(
      `preview: source-to-present p99 latency ${d.previewInputToPresentLatencyP99Ms.toFixed(0)}ms exceeds ${gates.maxPreviewInputToPresentLatencyP99Ms}ms`
    )
  }
  if (input.claimsNative && d.previewInputToPresentLatencyMs != null && d.previewInputToPresentLatencyMs > gates.maxPreviewInputToPresentLatencyMs) {
    failures.push(
      `preview: source-to-present latency ${d.previewInputToPresentLatencyMs.toFixed(0)}ms exceeds ${gates.maxPreviewInputToPresentLatencyMs}ms`
    )
  }
  if (input.claimsNative && d.previewCompositorFrameLag != null && d.previewCompositorFrameLag > gates.maxPreviewCompositorFrameLag) {
    failures.push(
      `preview: presented frame is ${d.previewCompositorFrameLag} compositor frame(s) behind (max ${gates.maxPreviewCompositorFrameLag})`
    )
  }

  return { pass: failures.length === 0, failures }
}
