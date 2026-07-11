import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  absoluteSampleDelayMs,
  absoluteSampleDeadlineMs,
  collectPerformanceSamplesOnSchedule,
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
      minDurationMs: 18_000
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
      minDurationMs: 598_000
    })
    assert.equal(
      absoluteSampleDeadlineMs({
        measurementStartedAtMs: 10_000,
        sampleIndex: 599,
        intervalMs: 1_000
      }) -
        absoluteSampleDeadlineMs({
          measurementStartedAtMs: 10_000,
          sampleIndex: 0,
          intervalMs: 1_000
        }),
      599_000
    )
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
          observations: observationsForSchedule(600, 1_000),
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
          observations: observationsForSchedule(599, 1_000),
          maxSampleGapMs: 2_000,
          measurementElapsedMs: 600_000
        },
        600_000,
        1_000
      ),
      []
    )
  })

  it('keeps the short process-memory sentinel on its absolute cadence despite collector cost', async () => {
    const clock = fakeClock()
    const scheduledAtMs = []
    const result = await collectPerformanceSamplesOnSchedule({
      measurementMs: 4_000,
      intervalMs: 500,
      nowMs: clock.now,
      sleep: clock.sleep,
      collectSample: async (sample) => {
        scheduledAtMs.push(sample.scheduledAtMs)
        clock.advance(300)
        return sample.sampleIndex
      }
    })

    assert.deepEqual(result.samples, [0, 1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(scheduledAtMs, [0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500])
    assert.deepEqual(result.sampleTimings, [
      { sampleIndex: 0, scheduledAtMs: 0, observedAtMs: 300 },
      { sampleIndex: 1, scheduledAtMs: 500, observedAtMs: 800 },
      { sampleIndex: 2, scheduledAtMs: 1_000, observedAtMs: 1_300 },
      { sampleIndex: 3, scheduledAtMs: 1_500, observedAtMs: 1_800 },
      { sampleIndex: 4, scheduledAtMs: 2_000, observedAtMs: 2_300 },
      { sampleIndex: 5, scheduledAtMs: 2_500, observedAtMs: 2_800 },
      { sampleIndex: 6, scheduledAtMs: 3_000, observedAtMs: 3_300 },
      { sampleIndex: 7, scheduledAtMs: 3_500, observedAtMs: 3_800 }
    ])
    assert.equal(result.measurementStartedAtMs, 0)
    assert.equal(result.measurementEndedAtMs, 4_000)
    assert.deepEqual(result.evidence, {
      expectedSamples: 8,
      collectedSamples: 8,
      skippedDeadlineCount: 0,
      observations: result.sampleTimings,
      maxSampleGapMs: 500,
      measurementElapsedMs: 4_000
    })
  })

  it('accepts hosted slow-first and fast-last completion latency on a valid schedule', async () => {
    const clock = fakeClock()
    const completionLatenciesMs = [475.533, 58.865, 58.865, 58.865, 58.865, 58.865, 58.865, 58.865]
    const result = await collectPerformanceSamplesOnSchedule({
      measurementMs: 4_000,
      intervalMs: 500,
      nowMs: clock.now,
      sleep: clock.sleep,
      collectSample: async ({ sampleIndex }) => {
        clock.advance(completionLatenciesMs[sampleIndex])
        return sampleIndex
      }
    })

    const observedDurationMs =
      result.sampleTimings.at(-1).observedAtMs - result.sampleTimings[0].observedAtMs
    assert.ok(Math.abs(observedDurationMs - 3_083.332) < 1e-9)
    const invariants = performanceSamplingInvariants(4_000, 500)
    assert.deepEqual(invariants, {
      expectedSamples: 8,
      minSamples: 7,
      minDurationMs: 3_000
    })
    assert.ok(observedDurationMs >= invariants.minDurationMs)
    assert.ok(observedDurationMs < 3_375)
    assert.deepEqual(result.evidence, {
      expectedSamples: 8,
      collectedSamples: 8,
      skippedDeadlineCount: 0,
      observations: result.sampleTimings,
      maxSampleGapMs: 500,
      measurementElapsedMs: 4_000
    })
    assert.deepEqual(performanceSamplingEvidenceFailures(result.evidence, 4_000, 500), [])
  })

  it('skips expired short-sentinel deadlines instead of backfilling them', async () => {
    const clock = fakeClock()
    let collectionCount = 0
    const result = await collectPerformanceSamplesOnSchedule({
      measurementMs: 4_000,
      intervalMs: 500,
      nowMs: clock.now,
      sleep: clock.sleep,
      collectSample: async ({ sampleIndex }) => {
        clock.advance(collectionCount === 0 ? 1_300 : 100)
        collectionCount += 1
        return sampleIndex
      }
    })

    assert.deepEqual(result.samples, [0, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(
      result.sampleTimings.map(({ sampleIndex, scheduledAtMs, observedAtMs }) => ({
        sampleIndex,
        scheduledAtMs,
        observedAtMs
      })),
      [
        { sampleIndex: 0, scheduledAtMs: 0, observedAtMs: 1_300 },
        { sampleIndex: 2, scheduledAtMs: 1_000, observedAtMs: 1_400 },
        { sampleIndex: 3, scheduledAtMs: 1_500, observedAtMs: 1_600 },
        { sampleIndex: 4, scheduledAtMs: 2_000, observedAtMs: 2_100 },
        { sampleIndex: 5, scheduledAtMs: 2_500, observedAtMs: 2_600 },
        { sampleIndex: 6, scheduledAtMs: 3_000, observedAtMs: 3_100 },
        { sampleIndex: 7, scheduledAtMs: 3_500, observedAtMs: 3_600 }
      ]
    )
    assert.equal(result.evidence.skippedDeadlineCount, 1)
    assert.equal(result.evidence.collectedSamples, 7)
    assert.equal(result.evidence.maxSampleGapMs, 1_300)
    assert.deepEqual(performanceSamplingEvidenceFailures(result.evidence, 4_000, 500), [
      'performance sampling observation span 2300ms was below 3000ms',
      'performance sampling max gap 1300ms indicated host sleep or a scheduling stall'
    ])
  })

  it('rejects observations whose completion span does not cover the duration invariant', async () => {
    const clock = fakeClock()
    const completionLatenciesMs = [750, 50, 50, 50, 50, 50, 50, 50]
    const result = await collectPerformanceSamplesOnSchedule({
      measurementMs: 4_000,
      intervalMs: 500,
      nowMs: clock.now,
      sleep: clock.sleep,
      collectSample: async ({ sampleIndex }) => {
        clock.advance(completionLatenciesMs[sampleIndex])
        return sampleIndex
      }
    })

    assert.equal(result.evidence.collectedSamples, 8)
    assert.equal(result.evidence.skippedDeadlineCount, 0)
    assert.equal(result.evidence.maxSampleGapMs, 750)
    assert.deepEqual(performanceSamplingEvidenceFailures(result.evidence, 4_000, 500), [
      'performance sampling observation span 2800ms was below 3000ms'
    ])
  })
})

function observationsForSchedule(sampleCount, intervalMs) {
  return Array.from({ length: sampleCount }, (_, sampleIndex) => ({
    sampleIndex,
    scheduledAtMs: sampleIndex * intervalMs,
    observedAtMs: sampleIndex * intervalMs
  }))
}

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

function fakeClock() {
  let nowMs = 0
  return {
    now: () => nowMs,
    sleep: async (durationMs) => {
      nowMs += durationMs
    },
    advance: (durationMs) => {
      nowMs += durationMs
    }
  }
}
