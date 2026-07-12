/**
 * Browser-side measurement helpers injected into the detached Windows proof
 * surface. Total surface/frame counters stay monotonic; each measurement gets
 * a fresh percentile epoch so startup and encoder-probe stalls cannot leak into
 * a later steady-state sample window.
 */
export const NATIVE_PREVIEW_PROOF_MEASUREMENT_RUNTIME_SCRIPT = String.raw`
function createNativePreviewProofMeasurementEpoch(now, blankFrames, skippedFrames) {
  return {
    startedAt: now,
    frameTimes: [],
    frames: 0,
    inputToPresentLatencyMs: null,
    inputToPresentLatencies: [],
    blankFramesBaseline: blankFrames,
    skippedFramesBaseline: skippedFrames
  };
}

function recordNativePreviewProofMeasurementFrame(epoch, now) {
  epoch.frames += 1;
  epoch.frameTimes.push(now);
  if (epoch.frameTimes.length > 900) epoch.frameTimes.shift();
}

function recordNativePreviewProofMeasurementLatency(epoch, latencyMs) {
  epoch.inputToPresentLatencyMs = latencyMs;
  epoch.inputToPresentLatencies.push(latencyMs);
  if (epoch.inputToPresentLatencies.length > 900) {
    epoch.inputToPresentLatencies.shift();
  }
}

function nativePreviewProofMeasurementPercentile(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function nativePreviewProofMeasurementSnapshot(epoch, now, blankFrames, skippedFrames) {
  const intervals = epoch.frameTimes
    .slice(1)
    .map((time, index) => time - epoch.frameTimes[index]);
  const elapsed = Math.max(1, now - epoch.startedAt);
  return {
    measuredFps: epoch.frames / elapsed * 1000,
    intervalP50Ms: nativePreviewProofMeasurementPercentile(intervals, 50),
    intervalP95Ms: nativePreviewProofMeasurementPercentile(intervals, 95),
    intervalP99Ms: nativePreviewProofMeasurementPercentile(intervals, 99),
    inputToPresentLatencyMs: epoch.inputToPresentLatencyMs,
    inputToPresentLatencyP50Ms: nativePreviewProofMeasurementPercentile(
      epoch.inputToPresentLatencies,
      50
    ),
    inputToPresentLatencyP95Ms: nativePreviewProofMeasurementPercentile(
      epoch.inputToPresentLatencies,
      95
    ),
    inputToPresentLatencyP99Ms: nativePreviewProofMeasurementPercentile(
      epoch.inputToPresentLatencies,
      99
    ),
    blankFrames: Math.max(0, blankFrames - epoch.blankFramesBaseline),
    skippedCompositorFrames: Math.max(0, skippedFrames - epoch.skippedFramesBaseline)
  };
}
`
