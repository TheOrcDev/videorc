import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  absoluteSampleDelayMs,
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
})

function simulateSchedule({ measurementMs, intervalMs, collectorMs = 75 }) {
  const { expectedSamples } = performanceSamplingInvariants(measurementMs, intervalMs)
  let nowMs = 0
  const sampledAtMs = []
  for (let sampleIndex = 0; sampleIndex < expectedSamples; sampleIndex += 1) {
    nowMs += absoluteSampleDelayMs({
      measurementStartedAtMs: 0,
      sampleIndex,
      intervalMs,
      nowMs
    })
    if (nowMs >= measurementMs) break
    sampledAtMs.push(nowMs)
    nowMs += collectorMs
  }
  nowMs += Math.max(0, measurementMs - nowMs)
  return { sampledAtMs, endedAtMs: nowMs }
}
