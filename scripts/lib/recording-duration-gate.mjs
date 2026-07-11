export function evaluateRecordingWallDuration({
  expectedDurationMs,
  actualDurationSeconds,
  minRatio = 0.8
}) {
  if (!(expectedDurationMs > 0)) {
    return ['expected recording duration must be positive']
  }
  if (!(Number.isFinite(actualDurationSeconds) && actualDurationSeconds > 0)) {
    return ['final artifact did not report a positive media duration']
  }
  const expectedSeconds = expectedDurationMs / 1000
  const ratio = actualDurationSeconds / expectedSeconds
  if (ratio < minRatio) {
    return [
      `final artifact duration ${actualDurationSeconds.toFixed(2)}s was only ${(ratio * 100).toFixed(1)}% of the requested ${expectedSeconds.toFixed(2)}s`
    ]
  }
  return []
}
