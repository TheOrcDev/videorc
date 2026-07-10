const DEADLINE_JITTER_SAMPLE_ALLOWANCE = 1

export function performanceSamplingInvariants(measurementMs, intervalMs) {
  assertPositiveFinite('measurement', measurementMs)
  assertPositiveFinite('interval', intervalMs)
  const expectedSamples = Math.ceil(measurementMs / intervalMs)
  return {
    expectedSamples,
    minSamples: Math.max(3, expectedSamples - DEADLINE_JITTER_SAMPLE_ALLOWANCE),
    minDurationMs: Math.max(0, measurementMs - intervalMs)
  }
}

export function absoluteSampleDelayMs({ measurementStartedAtMs, sampleIndex, intervalMs, nowMs }) {
  if (!Number.isFinite(measurementStartedAtMs) || !Number.isFinite(nowMs)) {
    throw new Error('Performance sampling timestamps must be finite.')
  }
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error(`Performance sample index must be a non-negative integer, got ${sampleIndex}.`)
  }
  assertPositiveFinite('interval', intervalMs)
  const deadlineMs = measurementStartedAtMs + sampleIndex * intervalMs
  return Math.max(0, deadlineMs - nowMs)
}

function assertPositiveFinite(label, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Performance sampling ${label} must be positive, got ${value}.`)
  }
}
