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

/**
 * Collect on absolute deadlines so collector overhead does not reduce cadence.
 * Deadlines that expire before collection starts are skipped and reported;
 * they are never backfilled with a burst of adjacent observations.
 */
export async function collectPerformanceSamplesOnSchedule({
  measurementMs,
  intervalMs,
  collectSample,
  nowMs = Date.now,
  sleep = defaultSleep
}) {
  const invariants = performanceSamplingInvariants(measurementMs, intervalMs)
  if (typeof collectSample !== 'function') {
    throw new Error('Performance sample collector must be a function.')
  }
  if (typeof nowMs !== 'function' || typeof sleep !== 'function') {
    throw new Error('Performance sampling clock and sleep must be functions.')
  }

  const measurementStartedAtMs = nowMs()
  const samples = []
  const sampleObservedAtMs = []
  let sampleIndex = 0
  let skippedDeadlineCount = 0

  while (sampleIndex < invariants.expectedSamples) {
    const delayMs = absoluteSampleDelayMs({
      measurementStartedAtMs,
      sampleIndex,
      intervalMs,
      nowMs: nowMs()
    })
    if (delayMs > 0) await sleep(delayMs)

    const observedBeforeCollectionMs = nowMs()
    const effectiveSampleIndex = performanceSampleIndexAtTime({
      measurementStartedAtMs,
      minimumSampleIndex: sampleIndex,
      intervalMs,
      nowMs: observedBeforeCollectionMs
    })
    skippedDeadlineCount += Math.min(invariants.expectedSamples, effectiveSampleIndex) - sampleIndex
    sampleIndex = effectiveSampleIndex
    if (
      sampleIndex >= invariants.expectedSamples ||
      observedBeforeCollectionMs - measurementStartedAtMs >= measurementMs
    ) {
      break
    }

    const scheduledAtMs = absoluteSampleDeadlineMs({
      measurementStartedAtMs,
      sampleIndex,
      intervalMs
    })
    samples.push(await collectSample({ sampleIndex, scheduledAtMs }))
    sampleObservedAtMs.push(nowMs())
    sampleIndex += 1
  }

  const remainingMeasurementMs = measurementMs - (nowMs() - measurementStartedAtMs)
  if (remainingMeasurementMs > 0) await sleep(remainingMeasurementMs)
  const measurementEndedAtMs = nowMs()
  return {
    samples,
    evidence: {
      expectedSamples: invariants.expectedSamples,
      collectedSamples: samples.length,
      skippedDeadlineCount,
      maxSampleGapMs: maximumAdjacentGapMs([
        measurementStartedAtMs,
        ...sampleObservedAtMs,
        measurementEndedAtMs
      ]),
      measurementElapsedMs: measurementEndedAtMs - measurementStartedAtMs
    }
  }
}

export function absoluteSampleDelayMs({ measurementStartedAtMs, sampleIndex, intervalMs, nowMs }) {
  if (!Number.isFinite(nowMs)) {
    throw new Error('Performance sampling timestamps must be finite.')
  }
  const deadlineMs = absoluteSampleDeadlineMs({
    measurementStartedAtMs,
    sampleIndex,
    intervalMs
  })
  return Math.max(0, deadlineMs - nowMs)
}

export function absoluteSampleDeadlineMs({ measurementStartedAtMs, sampleIndex, intervalMs }) {
  if (!Number.isFinite(measurementStartedAtMs)) {
    throw new Error('Performance sampling timestamps must be finite.')
  }
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error(`Performance sample index must be a non-negative integer, got ${sampleIndex}.`)
  }
  assertPositiveFinite('interval', intervalMs)
  return measurementStartedAtMs + sampleIndex * intervalMs
}

/**
 * Return the first still-valid absolute deadline. Host sleep and severe event
 * loop stalls must skip expired slots; backfilling them would manufacture a
 * dense sample burst that did not observe the elapsed wall-clock interval.
 */
export function performanceSampleIndexAtTime({
  measurementStartedAtMs,
  minimumSampleIndex,
  intervalMs,
  nowMs
}) {
  if (!Number.isFinite(measurementStartedAtMs) || !Number.isFinite(nowMs)) {
    throw new Error('Performance sampling timestamps must be finite.')
  }
  if (!Number.isInteger(minimumSampleIndex) || minimumSampleIndex < 0) {
    throw new Error(
      `Performance minimum sample index must be a non-negative integer, got ${minimumSampleIndex}.`
    )
  }
  assertPositiveFinite('interval', intervalMs)
  const elapsedIndex = Math.max(0, Math.floor((nowMs - measurementStartedAtMs) / intervalMs))
  return Math.max(minimumSampleIndex, elapsedIndex)
}

export function performanceSamplingEvidenceFailures(evidence, measurementMs, intervalMs) {
  const invariants = performanceSamplingInvariants(measurementMs, intervalMs)
  if (!evidence || typeof evidence !== 'object') {
    return ['performance wall-clock sampling evidence was missing']
  }
  const failures = []
  if (evidence.expectedSamples !== invariants.expectedSamples) {
    failures.push('performance sampling expected count did not match declared timing')
  }
  if (!Number.isInteger(evidence.collectedSamples) || evidence.collectedSamples < 0) {
    failures.push('performance sampling collected count was invalid')
  }
  if (!Number.isInteger(evidence.skippedDeadlineCount) || evidence.skippedDeadlineCount < 0) {
    failures.push('performance sampling skipped-deadline count was invalid')
  } else {
    if (evidence.skippedDeadlineCount > DEADLINE_JITTER_SAMPLE_ALLOWANCE) {
      failures.push(
        `performance sampling skipped ${evidence.skippedDeadlineCount} wall-clock deadlines; host sleep or a severe scheduling stall contaminated the run`
      )
    }
    if (
      Number.isInteger(evidence.collectedSamples) &&
      evidence.collectedSamples + evidence.skippedDeadlineCount !== invariants.expectedSamples
    ) {
      failures.push('performance sampling collected plus skipped counts did not cover the schedule')
    }
  }
  if (!Number.isFinite(evidence.maxSampleGapMs) || evidence.maxSampleGapMs > intervalMs * 2.5) {
    failures.push(
      `performance sampling max gap ${evidence.maxSampleGapMs ?? 'missing'}ms indicated host sleep or a scheduling stall`
    )
  }
  if (
    !Number.isFinite(evidence.measurementElapsedMs) ||
    evidence.measurementElapsedMs < measurementMs - intervalMs ||
    evidence.measurementElapsedMs > measurementMs + intervalMs
  ) {
    failures.push(
      `performance sampling elapsed ${evidence.measurementElapsedMs ?? 'missing'}ms did not match the ${measurementMs}ms wall-clock measurement`
    )
  }
  return failures
}

function assertPositiveFinite(label, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Performance sampling ${label} must be positive, got ${value}.`)
  }
}

function maximumAdjacentGapMs(timestamps) {
  let maximum = 0
  for (let index = 1; index < timestamps.length; index += 1) {
    maximum = Math.max(maximum, timestamps[index] - timestamps[index - 1])
  }
  return maximum
}

function defaultSleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
