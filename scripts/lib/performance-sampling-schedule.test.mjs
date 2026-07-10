import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  absoluteSampleDelayMs,
  performanceSampleIndexAtTime,
  performanceSamplingEvidenceFailures,
  performanceSamplingInvariants
} from './performance-sampling-schedule.mjs'

describe('performance sampling schedule', () => {
  it('keeps a 20-second schedule on absolute one-second deadlines despite collector overhead', () => {
    const simulated = simulateSchedule({ measurementMs: 20_000, intervalMs: 1_000 })

    assert.equal(simulated.sampledAtMs.length, 20)
    assert.equal(simulated.sampledAtMs[0], 0)
    assert.equal(simulated.sampledAtMs.at(-1), 19_000)
    assert.equal(simulated.endedAtMs, 20_000)
    assert.deepEqual(performanceSamplingInvariants(20_000, 1_000), {
      expectedSamples: 20,
      minSamples: 19,
      minDurationMs: 19_000
    })
  })

  it('keeps a 600-second calibration schedule drift-free with one jitter sample tolerance', () => {
    const simulated = simulateSchedule({ measurementMs: 600_000, intervalMs: 1_000 })

    assert.equal(simulated.sampledAtMs.length, 600)
    assert.equal(simulated.sampledAtMs.at(-1), 599_000)
    assert.equal(simulated.endedAtMs, 600_000)
    assert.deepEqual(performanceSamplingInvariants(600_000, 1_000), {
      expectedSamples: 600,
      minSamples: 599,
      minDurationMs: 599_000
    })
  })

  it('skips host-sleep deadlines instead of backfilling them in a post-wake burst', () => {
    const simulated = simulateSchedule({
      measurementMs: 600_000,
      intervalMs: 1_000,
      sleepAfterSamples: 160,
      sleepMs: 197_000
    })

    assert.equal(simulated.sampledAtMs.length, 404)
    assert.equal(simulated.skippedDeadlineCount, 196)
    assert.equal(simulated.sampledAtMs[159], 159_000)
    assert.equal(simulated.sampledAtMs[160], 356_075)
    assert.equal(simulated.sampledAtMs.at(-1), 599_000)
    assert.equal(simulated.endedAtMs, 600_000)
  })

  it('never moves a requested sample index backwards', () => {
    assert.equal(
      performanceSampleIndexAtTime({
        measurementStartedAtMs: 1_000,
        minimumSampleIndex: 8,
        intervalMs: 1_000,
        nowMs: 5_000
      }),
      8
    )
  })

  it('rejects a sleep or stall after the final scheduled sample', () => {
    assert.deepEqual(
      performanceSamplingEvidenceFailures(
        {
          expectedSamples: 600,
          collectedSamples: 600,
          skippedDeadlineCount: 0,
          maxSampleGapMs: 198_000,
          measurementElapsedMs: 797_000
        },
        600_000,
        1_000
      ),
      [
        'performance sampling max gap 198000ms indicated host sleep or a scheduling stall',
        'performance sampling elapsed 797000ms did not match the 600000ms wall-clock measurement'
      ]
    )
  })

  it('accepts one jitter skip only when counts and boundaries remain truthful', () => {
    assert.deepEqual(
      performanceSamplingEvidenceFailures(
        {
          expectedSamples: 600,
          collectedSamples: 599,
          skippedDeadlineCount: 1,
          maxSampleGapMs: 2_000,
          measurementElapsedMs: 600_000
        },
        600_000,
        1_000
      ),
      []
    )
  })
})

function simulateSchedule({
  measurementMs,
  intervalMs,
  collectorMs = 75,
  sleepAfterSamples,
  sleepMs = 0
}) {
  const { expectedSamples } = performanceSamplingInvariants(measurementMs, intervalMs)
  let nowMs = 0
  let sampleIndex = 0
  let skippedDeadlineCount = 0
  const sampledAtMs = []
  while (sampleIndex < expectedSamples) {
    nowMs += absoluteSampleDelayMs({
      measurementStartedAtMs: 0,
      sampleIndex,
      intervalMs,
      nowMs
    })
    const effectiveSampleIndex = performanceSampleIndexAtTime({
      measurementStartedAtMs: 0,
      minimumSampleIndex: sampleIndex,
      intervalMs,
      nowMs
    })
    skippedDeadlineCount += Math.min(expectedSamples, effectiveSampleIndex) - sampleIndex
    sampleIndex = effectiveSampleIndex
    if (sampleIndex >= expectedSamples || nowMs >= measurementMs) break
    sampledAtMs.push(nowMs)
    nowMs += collectorMs
    sampleIndex += 1
    if (sampledAtMs.length === sleepAfterSamples) nowMs += sleepMs
  }
  nowMs += Math.max(0, measurementMs - nowMs)
  return { sampledAtMs, skippedDeadlineCount, endedAtMs: nowMs }
}
